/* eslint-disable no-console */
const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
const adminBootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN || 'bootstrap-admin';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_e) {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function run() {
  const fr = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'fr' },
    body: JSON.stringify({})
  });

  const en = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
    body: JSON.stringify({})
  });

  assert(fr.status === 422, `register fr status attendu 422, obtenu ${fr.status}`);
  assert(en.status === 422, `register en status attendu 422, obtenu ${en.status}`);
  assert((fr.body.message || '').includes('sont requis'), 'message FR register invalide');
  assert((en.body.message || '').includes('are required'), 'message EN register invalide');

  const loginFr = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'fr' },
    body: JSON.stringify({})
  });

  const loginEn = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
    body: JSON.stringify({})
  });

  assert(loginFr.status === 422, `login fr status attendu 422, obtenu ${loginFr.status}`);
  assert(loginEn.status === 422, `login en status attendu 422, obtenu ${loginEn.status}`);
  assert((loginFr.body.message || '').includes('sont requis'), 'message FR login invalide');
  assert((loginEn.body.message || '').includes('are required'), 'message EN login invalide');

  const suffix = Date.now();
  const adminEmail = `admin-i18n-${suffix}@test.local`;
  const operatorEmail = `operator-i18n-${suffix}@test.local`;

  const adminRegister = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-bootstrap': adminBootstrapToken
    },
    body: JSON.stringify({
      email: adminEmail,
      password: 'Password123!',
      fullName: 'Admin I18N',
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

  const operatorRegister = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-bootstrap': adminBootstrapToken
    },
    body: JSON.stringify({
      email: operatorEmail,
      password: 'Password123!',
      fullName: 'Operator I18N',
      role: 'OPERATOR',
      locale: 'fr'
    })
  });
  assert(operatorRegister.status === 201, `operator register failed: ${operatorRegister.status}`);

  const createEvent = await request('/api/v1/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: `I18N Event ${suffix}`,
      venue: 'Paris',
      startsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      totalCapacity: 10
    })
  });
  assert(createEvent.status === 201, `create event failed: ${createEvent.status}`);

  const randomId = '00000000-0000-0000-0000-000000000001';
  const eventFr = await request(`/api/v1/events/${randomId}`, {
    headers: { 'Accept-Language': 'fr' }
  });
  const eventEn = await request(`/api/v1/events/${randomId}`, {
    headers: { 'Accept-Language': 'en' }
  });

  assert(eventFr.status === 404, `event fr status attendu 404, obtenu ${eventFr.status}`);
  assert(eventEn.status === 404, `event en status attendu 404, obtenu ${eventEn.status}`);
  assert((eventFr.body.message || '').toLowerCase().includes('introuvable'), 'message FR event invalide');
  assert((eventEn.body.message || '').toLowerCase().includes('not found'), 'message EN event invalide');

  console.log('I18N_AND_ROLE_VALIDATION_OK');
}

run().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
