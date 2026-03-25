const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || 'dev-secret';
const reservationTtlMin = Number(process.env.RESERVATION_TTL_MIN || 5);
const internalSyncToken = process.env.INTERNAL_SYNC_TOKEN || 'internal-sync-token';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ticket:ticket@postgres:5432/ticketing'
});

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token manquant.' });

  try {
    req.user = jwt.verify(token, jwtSecret);
    return next();
  } catch (_error) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token invalide.' });
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'inventory-service' }));

app.post('/internal/events/sync', async (req, res) => {
  if (req.headers['x-internal-token'] !== internalSyncToken) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token interne invalide.' });
  }

  const {
    id,
    name,
    venue,
    startsAt,
    totalCapacity,
    availableCapacity,
    status,
    createdBy
  } = req.body;

  if (!id || !name || !venue || !startsAt || totalCapacity == null || !status || !createdBy) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Payload sync invalide.' });
  }

  const result = await pool.query(
    `INSERT INTO events (id, name, venue, starts_at, total_capacity, available_capacity, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         venue = EXCLUDED.venue,
         starts_at = EXCLUDED.starts_at,
         total_capacity = EXCLUDED.total_capacity,
         available_capacity = EXCLUDED.available_capacity,
         status = EXCLUDED.status,
         created_by = EXCLUDED.created_by,
         version = events.version + 1
     RETURNING *`,
    [id, name, venue, startsAt, totalCapacity, availableCapacity, status, createdBy]
  );

  return res.json(result.rows[0]);
});

app.delete('/internal/events/:eventId', async (req, res) => {
  if (req.headers['x-internal-token'] !== internalSyncToken) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token interne invalide.' });
  }

  await pool.query('DELETE FROM events WHERE id = $1', [req.params.eventId]);
  return res.status(204).send();
});

app.get('/api/v1/inventory/events/:eventId/availability', async (req, res) => {
  const event = await pool.query('SELECT id, total_capacity, available_capacity FROM events WHERE id = $1', [req.params.eventId]);
  if (event.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Evenement introuvable.' });
  return res.json({
    eventId: event.rows[0].id,
    totalCapacity: event.rows[0].total_capacity,
    availableCapacity: event.rows[0].available_capacity
  });
});

app.get('/api/v1/inventory/reservations/:reservationId', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM seat_reservations WHERE id = $1', [req.params.reservationId]);
  if (result.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Reservation introuvable.' });
  return res.json({
    reservationId: result.rows[0].id,
    eventId: result.rows[0].event_id,
    userId: result.rows[0].user_id,
    quantity: result.rows[0].quantity,
    status: result.rows[0].status,
    expiresAt: result.rows[0].expires_at
  });
});

app.post('/api/v1/inventory/reservations', auth, async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];
  const { eventId, userId, quantity } = req.body;

  if (!idempotencyKey || !eventId || !userId || !quantity || quantity <= 0) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Donnees invalides.' });
  }

  if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Acces refuse.' });
  }

  const existing = await pool.query('SELECT * FROM seat_reservations WHERE idempotency_key = $1', [idempotencyKey]);
  if (existing.rowCount > 0) {
    const row = existing.rows[0];
    return res.status(200).json({
      reservationId: row.id,
      eventId: row.event_id,
      userId: row.user_id,
      quantity: row.quantity,
      status: row.status,
      expiresAt: row.expires_at
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eventLock = await client.query('SELECT available_capacity FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    if (eventLock.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Evenement introuvable.' });
    }

    if (eventLock.rows[0].available_capacity < quantity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'STOCK_UNAVAILABLE', message: 'Stock insuffisant.' });
    }

    const update = await client.query(
      'UPDATE events SET available_capacity = available_capacity - $1, version = version + 1 WHERE id = $2 AND available_capacity >= $1',
      [quantity, eventId]
    );

    if (update.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'STOCK_UNAVAILABLE', message: 'Stock insuffisant.' });
    }

    const reservationId = uuidv4();
    const insert = await client.query(
      `INSERT INTO seat_reservations (id, event_id, user_id, quantity, status, expires_at, idempotency_key)
       VALUES ($1, $2, $3, $4, 'PENDING', now() + ($5 || ' minutes')::interval, $6)
       RETURNING *`,
      [reservationId, eventId, userId, quantity, reservationTtlMin, idempotencyKey]
    );

    await client.query('COMMIT');
    const row = insert.rows[0];
    return res.status(201).json({
      reservationId: row.id,
      eventId: row.event_id,
      userId: row.user_id,
      quantity: row.quantity,
      status: row.status,
      expiresAt: row.expires_at
    });
  } catch (_error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erreur interne.' });
  } finally {
    client.release();
  }
});

app.post('/api/v1/inventory/reservations/:reservationId/confirm', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reservation = await client.query('SELECT * FROM seat_reservations WHERE id = $1 FOR UPDATE', [req.params.reservationId]);
    if (reservation.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Reservation introuvable.' });
    }

    const row = reservation.rows[0];
    if (row.status === 'CONFIRMED') {
      await client.query('COMMIT');
      return res.json({ reservationId: row.id, eventId: row.event_id, userId: row.user_id, quantity: row.quantity, status: row.status, expiresAt: row.expires_at });
    }

    if (row.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_STATUS', message: 'Reservation non confirmable.' });
    }

    if (new Date(row.expires_at) <= new Date()) {
      await client.query("UPDATE seat_reservations SET status = 'EXPIRED' WHERE id = $1", [row.id]);
      await client.query('UPDATE events SET available_capacity = available_capacity + $1, version = version + 1 WHERE id = $2', [row.quantity, row.event_id]);
      await client.query('COMMIT');
      return res.status(410).json({ code: 'RESERVATION_EXPIRED', message: 'Reservation expiree.' });
    }

    const confirmed = await client.query("UPDATE seat_reservations SET status = 'CONFIRMED' WHERE id = $1 RETURNING *", [row.id]);
    await client.query('COMMIT');
    const out = confirmed.rows[0];
    return res.json({ reservationId: out.id, eventId: out.event_id, userId: out.user_id, quantity: out.quantity, status: out.status, expiresAt: out.expires_at });
  } catch (_error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erreur interne.' });
  } finally {
    client.release();
  }
});

app.post('/api/v1/inventory/reservations/:reservationId/release', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reservation = await client.query('SELECT * FROM seat_reservations WHERE id = $1 FOR UPDATE', [req.params.reservationId]);
    if (reservation.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Reservation introuvable.' });
    }

    const row = reservation.rows[0];
    if (row.status === 'RELEASED' || row.status === 'EXPIRED') {
      await client.query('COMMIT');
      return res.json({ reservationId: row.id, eventId: row.event_id, userId: row.user_id, quantity: row.quantity, status: row.status, expiresAt: row.expires_at });
    }

    if (row.status === 'CONFIRMED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_STATUS', message: 'Reservation deja confirmee.' });
    }

    const released = await client.query("UPDATE seat_reservations SET status = 'RELEASED' WHERE id = $1 RETURNING *", [row.id]);
    await client.query('UPDATE events SET available_capacity = available_capacity + $1, version = version + 1 WHERE id = $2', [row.quantity, row.event_id]);

    await client.query('COMMIT');
    const out = released.rows[0];
    return res.json({ reservationId: out.id, eventId: out.event_id, userId: out.user_id, quantity: out.quantity, status: out.status, expiresAt: out.expires_at });
  } catch (_error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erreur interne.' });
  } finally {
    client.release();
  }
});

async function expireReservations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expired = await client.query(
      `SELECT id, event_id, quantity
       FROM seat_reservations
       WHERE status = 'PENDING' AND expires_at <= now()
       FOR UPDATE SKIP LOCKED`
    );

    for (const row of expired.rows) {
      await client.query("UPDATE seat_reservations SET status = 'EXPIRED' WHERE id = $1", [row.id]);
      await client.query('UPDATE events SET available_capacity = available_capacity + $1, version = version + 1 WHERE id = $2', [row.quantity, row.event_id]);
    }

    await client.query('COMMIT');
  } catch (_error) {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

setInterval(expireReservations, 30000);

app.listen(port, () => {
  console.log(`inventory-service listening on ${port}`);
});
