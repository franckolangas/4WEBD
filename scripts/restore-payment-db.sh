#!/usr/bin/env sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <fichier_dump>"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DUMP_FILE="$1"

if [ ! -f "$DUMP_FILE" ]; then
  echo "Fichier introuvable: $DUMP_FILE"
  exit 1
fi

cd "$ROOT_DIR"
POSTGRES_USER="${POSTGRES_USER:-ticket}"

cat "$DUMP_FILE" | docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d paymentdb --clean --if-exists --no-owner --no-privileges

echo "Restauration terminee depuis: $DUMP_FILE"
