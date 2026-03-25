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

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Acces refuse.' });
    }
    return next();
  };
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'user-service' }));

app.post('/internal/users/sync', async (req, res) => {
  if (req.headers['x-internal-token'] !== internalSyncToken) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token interne invalide.' });
  }

  const { id, email, fullName, locale = 'fr', role = 'USER' } = req.body;
  if (!id || !email || !fullName) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'id, email et fullName sont requis.' });
  }

  const result = await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name, locale, role)
     VALUES ($1, $2, 'managed-by-auth-service', $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
     SET email = EXCLUDED.email,
         full_name = EXCLUDED.full_name,
         locale = EXCLUDED.locale,
         role = EXCLUDED.role,
         updated_at = now()
     RETURNING id, email, full_name, locale, role, created_at, updated_at`,
    [id, email, fullName, locale, role]
  );

  return res.status(200).json(result.rows[0]);
});

app.get('/api/v1/users/me', auth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, email, full_name, locale, role, created_at, updated_at FROM users WHERE id = $1',
    [req.user.sub]
  );
  if (result.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Utilisateur introuvable.' });
  return res.json(result.rows[0]);
});

app.get('/api/v1/users', auth, requireRole('ADMIN'), async (_req, res) => {
  const result = await pool.query('SELECT id, email, full_name, locale, role, created_at, updated_at FROM users ORDER BY created_at DESC');
  return res.json(result.rows);
});

app.get('/api/v1/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'ADMIN' && req.user.sub !== req.params.id) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Acces refuse.' });
  }
  const result = await pool.query('SELECT id, email, full_name, locale, role, created_at, updated_at FROM users WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Utilisateur introuvable.' });
  return res.json(result.rows[0]);
});

app.post('/api/v1/users', auth, requireRole('ADMIN'), async (req, res) => {
  const { email, fullName, locale = 'fr', role = 'USER' } = req.body;
  if (!email || !fullName) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'email et fullName sont requis.' });
  }

  const id = uuidv4();
  const fakePasswordHash = 'managed-by-auth-service';
  try {
    const result = await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, locale, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, full_name, locale, role, created_at`,
      [id, email, fakePasswordHash, fullName, locale, role]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ code: 'EMAIL_ALREADY_EXISTS', message: 'Un compte avec cet email existe deja.' });
    }
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erreur interne.' });
  }
});

app.patch('/api/v1/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'ADMIN' && req.user.sub !== req.params.id) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Acces refuse.' });
  }

  const { fullName, locale } = req.body;
  const result = await pool.query(
    `UPDATE users
     SET full_name = COALESCE($1, full_name),
         locale = COALESCE($2, locale),
         updated_at = now()
     WHERE id = $3
     RETURNING id, email, full_name, locale, role, created_at, updated_at`,
    [fullName, locale, req.params.id]
  );

  if (result.rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Utilisateur introuvable.' });
  return res.json(result.rows[0]);
});

app.delete('/api/v1/users/:id', auth, requireRole('ADMIN'), async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  return res.status(204).send();
});

app.listen(port, () => {
  console.log(`user-service listening on ${port}`);
});
