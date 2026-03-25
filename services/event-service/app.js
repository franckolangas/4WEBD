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
const inventoryServiceUrl = process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3000';
const internalSyncToken = process.env.INTERNAL_SYNC_TOKEN || 'internal-sync-token';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ticket:ticket@postgres:5432/ticketing'
});

function localeFromRequest(req) {
  const value = String(req.headers['accept-language'] || '').toLowerCase();
  return value.startsWith('en') ? 'en' : 'fr';
}

function msg(req, fr, en) {
  return localeFromRequest(req) === 'en' ? en : fr;
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ code: 'UNAUTHORIZED', message: msg(req, 'Token manquant.', 'Missing token.') });

  try {
    req.user = jwt.verify(token, jwtSecret);
    return next();
  } catch (_error) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: msg(req, 'Token invalide.', 'Invalid token.') });
  }
}

function canManageEvent(user, event) {
  return user.role === 'ADMIN' || user.sub === event.created_by;
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'event-service' }));

app.get('/api/v1/events', async (_req, res) => {
  const result = await pool.query('SELECT * FROM events ORDER BY starts_at ASC');
  return res.json(result.rows);
});

app.get('/api/v1/events/:id', async (req, res) => {
  const result = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: msg(req, 'Evenement introuvable.', 'Event not found.') });
  return res.json(result.rows[0]);
});

app.post('/api/v1/events', auth, async (req, res) => {
  if (!['ADMIN', 'EVENT_CREATOR', 'OPERATOR'].includes(req.user.role)) {
    return res.status(403).json({ code: 'FORBIDDEN', message: msg(req, 'Acces refuse.', 'Access denied.') });
  }

  const { name, venue, startsAt, totalCapacity } = req.body;
  if (!name || !venue || !startsAt || !totalCapacity || totalCapacity <= 0) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: msg(req, 'Donnees evenement invalides.', 'Invalid event data.') });
  }

  const id = uuidv4();
  const result = await pool.query(
    `INSERT INTO events (id, name, venue, starts_at, total_capacity, available_capacity, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $5, 'PUBLISHED', $6)
     RETURNING *`,
    [id, name, venue, startsAt, totalCapacity, req.user.sub]
  );

  const created = result.rows[0];
  const syncRes = await fetch(`${inventoryServiceUrl}/internal/events/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': internalSyncToken
    },
    body: JSON.stringify({
      id: created.id,
      name: created.name,
      venue: created.venue,
      startsAt: created.starts_at,
      totalCapacity: created.total_capacity,
      availableCapacity: created.available_capacity,
      status: created.status,
      createdBy: created.created_by
    })
  });

  if (!syncRes.ok) {
    await pool.query('DELETE FROM events WHERE id = $1', [created.id]);
    return res.status(502).json({ code: 'SYNC_ERROR', message: msg(req, 'Echec de synchronisation inventory.', 'Inventory synchronization failed.') });
  }

  return res.status(201).json(created);
});

app.patch('/api/v1/events/:id', auth, async (req, res) => {
  const existing = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (existing.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: msg(req, 'Evenement introuvable.', 'Event not found.') });
  if (!canManageEvent(req.user, existing.rows[0])) {
    return res.status(403).json({ code: 'FORBIDDEN', message: msg(req, 'Acces refuse.', 'Access denied.') });
  }

  const { name, venue, startsAt, status } = req.body;
  const result = await pool.query(
    `UPDATE events
     SET name = COALESCE($1, name),
         venue = COALESCE($2, venue),
         starts_at = COALESCE($3, starts_at),
         status = COALESCE($4, status),
         version = version + 1
     WHERE id = $5
     RETURNING *`,
    [name, venue, startsAt, status, req.params.id]
  );

  const updated = result.rows[0];
  await fetch(`${inventoryServiceUrl}/internal/events/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': internalSyncToken
    },
    body: JSON.stringify({
      id: updated.id,
      name: updated.name,
      venue: updated.venue,
      startsAt: updated.starts_at,
      totalCapacity: updated.total_capacity,
      availableCapacity: updated.available_capacity,
      status: updated.status,
      createdBy: updated.created_by
    })
  });

  return res.json(updated);
});

app.delete('/api/v1/events/:id', auth, async (req, res) => {
  const existing = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (existing.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: msg(req, 'Evenement introuvable.', 'Event not found.') });
  if (!canManageEvent(req.user, existing.rows[0])) {
    return res.status(403).json({ code: 'FORBIDDEN', message: msg(req, 'Acces refuse.', 'Access denied.') });
  }

  await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
  await fetch(`${inventoryServiceUrl}/internal/events/${req.params.id}`, {
    method: 'DELETE',
    headers: {
      'x-internal-token': internalSyncToken
    }
  });
  return res.status(204).send();
});

app.listen(port, () => {
  console.log(`event-service listening on ${port}`);
});
