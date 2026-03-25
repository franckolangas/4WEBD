#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

POSTGRES_USER="${POSTGRES_USER:-ticket}"

SQL="
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'EVENT_CREATOR', 'OPERATOR', 'USER'));
"

echo "$SQL" | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d authdb
echo "$SQL" | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d userdb

echo "Migration OPERATOR appliquee sur authdb et userdb."
