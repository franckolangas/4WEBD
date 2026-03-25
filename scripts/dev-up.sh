#!/usr/bin/env bash
set -euo pipefail

docker compose up -d --build

echo "Stack demarree. API Gateway: http://localhost:${GATEWAY_HTTP_PORT:-80}"
