const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || 'dev-secret';
const accessTtl = Number(process.env.JWT_ACCESS_TTL_SECONDS || 900);
const refreshTtl = Number(process.env.JWT_REFRESH_TTL_SECONDS || 2592000);
const adminBootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN || 'bootstrap-admin';
const userServiceUrl = process.env.USER_SERVICE_URL || 'http://user-service:3000';
const internalSyncToken = process.env.INTERNAL_SYNC_TOKEN || 'internal-sync-token';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ticket:ticket@postgres:5432/ticketing'
});

const refreshHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const allowedRoles = new Set(['ADMIN', 'EVENT_CREATOR', 'OPERATOR', 'USER']);

function localeFromRequest(req) {
  const value = String(req.headers['accept-language'] || '').toLowerCase();
  return value.startsWith('en') ? 'en' : 'fr';
}

function msg(req, fr, en) {
  return localeFromRequest(req) === 'en' ? en : fr;
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    jwtSecret,
    { expiresIn: accessTtl }
  );
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'auth-service' }));

app.post('/api/v1/auth/register', async (req, res) => {
  const { email, password, fullName, locale = 'fr', role } = req.body;
  if (!email || !password || !fullName) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: msg(req, 'email, password et fullName sont requis.', 'email, password and fullName are required.')
    });
  }

  let finalRole = 'USER';
  if (role && req.headers['x-admin-bootstrap'] === adminBootstrapToken) {
    if (!allowedRoles.has(role)) {
      return res.status(422).json({
        code: 'INVALID_ROLE',
        message: msg(req, 'Role invalide.', 'Invalid role.')
      });
    }
    finalRole = role;
  }

  try {
    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    const query = `
      INSERT INTO users (id, email, password_hash, full_name, locale, role)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, email, full_name, locale, role, created_at
    `;
    const result = await pool.query(query, [id, email, passwordHash, fullName, locale, finalRole]);

    const syncRes = await fetch(`${userServiceUrl}/internal/users/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': internalSyncToken
      },
      body: JSON.stringify({
        id,
        email,
        fullName,
        locale,
        role: finalRole
      })
    });

    if (!syncRes.ok) {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
      return res.status(502).json({
        code: 'SYNC_ERROR',
        message: msg(req, 'Echec de synchronisation utilisateur.', 'User synchronization failed.')
      });
    }

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        code: 'EMAIL_ALREADY_EXISTS',
        message: msg(req, 'Un compte avec cet email existe deja.', 'An account with this email already exists.')
      });
    }
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: msg(req, 'Erreur interne.', 'Internal error.') });
  }
});

app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: msg(req, 'email et password sont requis.', 'email and password are required.')
    });
  }

  try {
    const result = await pool.query('SELECT id, email, password_hash, role FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: msg(req, 'Identifiants invalides.', 'Invalid credentials.')
      });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: msg(req, 'Identifiants invalides.', 'Invalid credentials.')
      });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = uuidv4() + '.' + uuidv4();
    const refreshTokenHash = refreshHash(refreshToken);
    const refreshId = uuidv4();

    await pool.query(
      "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)",
      [refreshId, user.id, refreshTokenHash, refreshTtl]
    );

    return res.json({ accessToken, refreshToken, expiresIn: accessTtl });
  } catch (_error) {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: msg(req, 'Erreur interne.', 'Internal error.') });
  }
});

app.post('/api/v1/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: msg(req, 'refreshToken est requis.', 'refreshToken is required.')
    });
  }

  try {
    const tokenHash = refreshHash(refreshToken);
    const result = await pool.query(
      `SELECT rt.user_id, u.email, u.role
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1
         AND rt.revoked_at IS NULL
         AND rt.expires_at > now()`,
      [tokenHash]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        code: 'INVALID_REFRESH_TOKEN',
        message: msg(req, 'Refresh token invalide ou expire.', 'Invalid or expired refresh token.')
      });
    }

    const user = { id: result.rows[0].user_id, email: result.rows[0].email, role: result.rows[0].role };
    const accessToken = signAccessToken(user);
    return res.json({ accessToken, expiresIn: accessTtl });
  } catch (_error) {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: msg(req, 'Erreur interne.', 'Internal error.') });
  }
});

app.post('/api/v1/auth/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: msg(req, 'refreshToken est requis.', 'refreshToken is required.')
    });
  }

  try {
    const tokenHash = refreshHash(refreshToken);
    await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [tokenHash]);
    return res.status(204).send();
  } catch (_error) {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: msg(req, 'Erreur interne.', 'Internal error.') });
  }
});

app.listen(port, () => {
  console.log(`auth-service listening on ${port}`);
});
