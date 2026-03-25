#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${1:-$ROOT_DIR/backups/payment}"
TS="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="$BACKUP_DIR/paymentdb_${TS}.dump"

mkdir -p "$BACKUP_DIR"
cd "$ROOT_DIR"

POSTGRES_USER="${POSTGRES_USER:-ticket}"

docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d paymentdb -F c > "$OUT_FILE"

echo "Backup cree: $OUT_FILE"
