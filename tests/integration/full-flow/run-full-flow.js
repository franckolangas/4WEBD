/* eslint-disable no-console */
const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
const adminBootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN || 'bootstrap-admin';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_e) {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function run() {
  const suffix = Date.now();
  const adminEmail = `admin-${suffix}@test.local`;
  const userEmail = `user-${suffix}@test.local`;

  const adminRegister = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-bootstrap': adminBootstrapToken
    },
    body: JSON.stringify({
      email: adminEmail,
      password: 'Password123!',
      fullName: 'Admin Test',
      role: 'ADMIN',
      locale: 'fr'
    })
  });
  assert(adminRegister.status === 201, `admin register failed: ${adminRegister.status}`);

  const adminLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: 'Password123!' })
  });
  assert(adminLogin.status === 200, `admin login failed: ${adminLogin.status}`);
  const adminToken = adminLogin.body.accessToken;

  const userRegister = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
      password: 'Password123!',
      fullName: 'User Test',
      locale: 'fr'
    })
  });
  assert(userRegister.status === 201, `user register failed: ${userRegister.status}`);

  const userId = userRegister.body.id;

  const userLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: 'Password123!' })
  });
  assert(userLogin.status === 200, `user login failed: ${userLogin.status}`);
  const userToken = userLogin.body.accessToken;

  const eventCreate = await request('/api/v1/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      name: `Concert Test ${suffix}`,
      venue: 'Paris',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      totalCapacity: 2
    })
  });
  assert(eventCreate.status === 201, `event create failed: ${eventCreate.status}`);

  const eventId = eventCreate.body.id;

  const reserve = await request('/api/v1/inventory/reservations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
      'Idempotency-Key': `reserve-${suffix}`
    },
    body: JSON.stringify({ eventId, userId, quantity: 1 })
  });
  assert([200, 201].includes(reserve.status), `reservation failed: ${reserve.status}`);

  const reservationId = reserve.body.reservationId;

  const order = await request('/api/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
      'Idempotency-Key': `order-${suffix}`
    },
    body: JSON.stringify({
      reservationId,
      userId,
      eventId,
      amountCents: 4900,
      currency: 'EUR'
    })
  });
  assert([200, 201].includes(order.status), `order create failed: ${order.status}`);

  const orderId = order.body.orderId;

  const pay = await request(`/api/v1/orders/${orderId}/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`
    },
    body: JSON.stringify({ scenario: 'success' })
  });
  assert(pay.status === 200, `payment failed: ${pay.status}`);

  const tickets = await request('/api/v1/tickets/my', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${userToken}`
    }
  });
  assert(tickets.status === 200, `tickets failed: ${tickets.status}`);
  assert(Array.isArray(tickets.body), 'tickets response is not an array');
  assert(tickets.body.length >= 1, 'no ticket generated');

  console.log('SUCCESS: flow complet valide.');
}

run().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
