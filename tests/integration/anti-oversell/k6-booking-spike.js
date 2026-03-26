import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL || 'http://localhost:8080';
const bootstrapToken = __ENV.ADMIN_BOOTSTRAP_TOKEN || 'bootstrap-admin';

const successReservations = new Counter('success_reservations');
const conflictReservations = new Counter('conflict_reservations');
const unexpectedReservations = new Counter('unexpected_reservations');

export const options = {
  scenarios: {
    booking_spike: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 300,
      stages: [
        { duration: '20s', target: 80 },
        { duration: '30s', target: 120 },
        { duration: '20s', target: 0 }
      ]
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    unexpected_reservations: ['count==0'],
  }
};

function parseJsonResponse(res) {
  if (!res || !res.body) return {};
  try {
    return JSON.parse(res.body);
  } catch (_err) {
    return {};
  }
}

function expectStatus(res, expected, label) {
  const ok = check(res, {
    [label]: (r) => expected.includes(r.status),
  });
  if (!ok) {
    throw new Error(`${label} failed: status=${res.status} body=${res.body}`);
  }
}

export function setup() {
  const stamp = Date.now();
  const adminEmail = `admin-k6-${stamp}@test.local`;
  const userEmail = `user-k6-${stamp}@test.local`;

  const adminRegister = http.post(
    `${baseUrl}/api/v1/auth/register`,
    JSON.stringify({
      email: adminEmail,
      password: 'Password123!',
      fullName: 'Admin K6',
      role: 'ADMIN',
      locale: 'fr'
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-admin-bootstrap': bootstrapToken
      }
    }
  );
  expectStatus(adminRegister, [201], 'admin register is 201');

  const adminLogin = http.post(
    `${baseUrl}/api/v1/auth/login`,
    JSON.stringify({ email: adminEmail, password: 'Password123!' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  expectStatus(adminLogin, [200], 'admin login is 200');
  const adminToken = parseJsonResponse(adminLogin).accessToken;

  const userRegister = http.post(
    `${baseUrl}/api/v1/auth/register`,
    JSON.stringify({
      email: userEmail,
      password: 'Password123!',
      fullName: 'User K6',
      locale: 'fr'
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  expectStatus(userRegister, [201], 'user register is 201');
  const userId = parseJsonResponse(userRegister).id;

  const userLogin = http.post(
    `${baseUrl}/api/v1/auth/login`,
    JSON.stringify({ email: userEmail, password: 'Password123!' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  expectStatus(userLogin, [200], 'user login is 200');
  const userToken = parseJsonResponse(userLogin).accessToken;

  const eventCreate = http.post(
    `${baseUrl}/api/v1/events`,
    JSON.stringify({
      name: `K6 Stress Event ${stamp}`,
      venue: 'Paris',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      totalCapacity: 5
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      }
    }
  );
  expectStatus(eventCreate, [201], 'event create is 201');
  const eventId = parseJsonResponse(eventCreate).id;

  return { eventId, userId, userToken };
}

function createReservation(eventId, userId, userToken, idx) {
  const payload = JSON.stringify({
    eventId,
    userId,
    quantity: 1
  });

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${userToken}`,
    'Idempotency-Key': `k6-${__VU}-${__ITER}-${idx}`
  };

  return http.post(`${baseUrl}/api/v1/inventory/reservations`, payload, { headers });
}

export default function (data) {
  const { eventId, userId, userToken } = data;

  const reservationRes = createReservation(eventId, userId, userToken, 1);

  const ok = check(reservationRes, {
    'reservation status is 200, 201 or 409': (r) => r.status === 200 || r.status === 201 || r.status === 409,
  });

  if (!ok) {
    unexpectedReservations.add(1);
    console.error(`Unexpected reservation status: ${reservationRes.status} body=${reservationRes.body}`);
  }

  if (reservationRes.status === 200 || reservationRes.status === 201) {
    successReservations.add(1);
  }

  if (reservationRes.status === 409) {
    conflictReservations.add(1);
  }

  sleep(0.1);
}
