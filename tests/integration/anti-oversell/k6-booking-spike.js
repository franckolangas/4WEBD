import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL || 'http://localhost:8080';
const eventId = __ENV.EVENT_ID || '00000000-0000-0000-0000-000000000001';
const userToken = __ENV.USER_TOKEN || 'replace_me';

const successReservations = new Counter('success_reservations');
const conflictReservations = new Counter('conflict_reservations');

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
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<500'],
  }
};

function createReservation(userId, idx) {
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

export default function () {
  const syntheticUserId = `00000000-0000-0000-0000-${String(__VU).padStart(12, '0')}`;

  const reservationRes = createReservation(syntheticUserId, 1);

  const ok = check(reservationRes, {
    'reservation status is 201 or 409': (r) => r.status === 201 || r.status === 409,
  });

  if (!ok) {
    console.error(`Unexpected reservation status: ${reservationRes.status} body=${reservationRes.body}`);
  }

  if (reservationRes.status === 201) {
    successReservations.add(1);
  }

  if (reservationRes.status === 409) {
    conflictReservations.add(1);
  }

  sleep(0.1);
}
