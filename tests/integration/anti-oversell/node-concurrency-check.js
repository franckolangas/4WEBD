/* eslint-disable no-console */
const base = process.env.BASE_URL || 'http://localhost:8080';
const bootstrap = process.env.ADMIN_BOOTSTRAP_TOKEN || 'bootstrap-admin';

async function req(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_error) {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function main() {
  const stamp = Date.now();
  const adminEmail = `admin-${stamp}@test.local`;
  const userEmail = `user-${stamp}@test.local`;

  let result = await req('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-bootstrap': bootstrap },
    body: JSON.stringify({
      email: adminEmail,
      password: 'Password123!',
      fullName: 'Admin Load',
      role: 'ADMIN',
      locale: 'fr'
    })
  });
  if (result.status !== 201) throw new Error(`admin register failed: ${result.status}`);

  result = await req('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: 'Password123!' })
  });
  if (result.status !== 200) throw new Error(`admin login failed: ${result.status}`);
  const adminToken = result.body.accessToken;

  result = await req('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
      password: 'Password123!',
      fullName: 'User Load',
      locale: 'fr'
    })
  });
  if (result.status !== 201) throw new Error(`user register failed: ${result.status}`);
  const userId = result.body.id;

  result = await req('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: 'Password123!' })
  });
  if (result.status !== 200) throw new Error(`user login failed: ${result.status}`);
  const userToken = result.body.accessToken;

  result = await req('/api/v1/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      name: `Stress Event ${stamp}`,
      venue: 'Paris',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      totalCapacity: 5
    })
  });
  if (result.status !== 201) throw new Error(`event create failed: ${result.status}`);
  const eventId = result.body.id;

  const attempts = 30;
  const calls = [];
  for (let i = 0; i < attempts; i += 1) {
    calls.push(
      req('/api/v1/inventory/reservations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
          'Idempotency-Key': `stress-${stamp}-${i}`
        },
        body: JSON.stringify({ eventId, userId, quantity: 1 })
      })
    );
  }

  const responses = await Promise.all(calls);
  const successes = responses.filter((r) => r.status === 201 || r.status === 200).length;
  const conflicts = responses.filter((r) => r.status === 409).length;

  const availability = await req(`/api/v1/inventory/events/${eventId}/availability`);
  const available = availability.body.availableCapacity;

  console.log(JSON.stringify({ attempts, successes, conflicts, available }, null, 2));

  if (successes > 5) {
    throw new Error(`oversell detected: successes=${successes}`);
  }

  if (available < 0) {
    throw new Error(`negative stock detected: available=${available}`);
  }

  console.log('ANTI_OVERSELL_OK');
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
