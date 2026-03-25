-- Bases dediees par service
CREATE DATABASE authdb;
CREATE DATABASE userdb;
CREATE DATABASE eventdb;
CREATE DATABASE inventorydb;
CREATE DATABASE orderdb;
CREATE DATABASE paymentdb;

-- =========================
-- authdb
-- =========================
\connect authdb
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  locale VARCHAR(2) NOT NULL DEFAULT 'fr',
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'EVENT_CREATOR', 'OPERATOR', 'USER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL
);

-- =========================
-- userdb
-- =========================
\connect userdb
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  locale VARCHAR(2) NOT NULL DEFAULT 'fr',
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'EVENT_CREATOR', 'OPERATOR', 'USER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- eventdb
-- =========================
\connect eventdb
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  total_capacity INT NOT NULL CHECK (total_capacity > 0),
  available_capacity INT NOT NULL CHECK (available_capacity >= 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'CLOSED')),
  version INT NOT NULL DEFAULT 0,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- inventorydb
-- =========================
\connect inventorydb
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  total_capacity INT NOT NULL CHECK (total_capacity > 0),
  available_capacity INT NOT NULL CHECK (available_capacity >= 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'CLOSED')),
  version INT NOT NULL DEFAULT 0,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seat_reservations (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id),
  user_id UUID NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_reservation_event_status ON seat_reservations(event_id, status);
CREATE INDEX IF NOT EXISTS idx_reservation_expires_at ON seat_reservations(expires_at);

-- =========================
-- orderdb
-- =========================
\connect orderdb
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  event_id UUID NOT NULL,
  reservation_id UUID NOT NULL UNIQUE,
  total_amount_cents INT NOT NULL CHECK (total_amount_cents >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  event_id UUID NOT NULL,
  user_id UUID NOT NULL,
  ticket_code TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status VARCHAR(20) NOT NULL CHECK (status IN ('VALID', 'CANCELLED', 'USED'))
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  provider VARCHAR(30) NOT NULL DEFAULT 'SIMULATED',
  amount_cents INT NOT NULL,
  currency CHAR(3) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('AUTHORIZED', 'DECLINED', 'TIMEOUT')),
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox_events(published, created_at);

-- =========================
-- paymentdb
-- =========================
\connect paymentdb
CREATE TABLE IF NOT EXISTS payment_audit (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL,
  amount_cents INT NOT NULL,
  currency CHAR(3) NOT NULL,
  scenario VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
