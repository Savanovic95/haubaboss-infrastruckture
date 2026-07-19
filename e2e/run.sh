#!/usr/bin/env bash
# End-to-end critical path: seeds a shop, boots the Laravel API and the
# storefront locally, then runs the Playwright suite against them.
#
# Assumes sibling checkouts (../haubaboss-backend, ../haubaboss-store),
# PostgreSQL reachable with the env below, and Playwright's Chromium
# available (PLAYWRIGHT_BROWSERS_PATH or a prior `playwright install`).
set -euo pipefail

cd "$(dirname "$0")"
E2E_DIR="$(pwd)"
BACKEND_DIR="${BACKEND_DIR:-$E2E_DIR/../../haubaboss-backend}"
STORE_DIR="${STORE_DIR:-$E2E_DIR/../../haubaboss-store}"

export DB_CONNECTION=pgsql
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5433}"
export DB_DATABASE="${DB_DATABASE:-haubaboss_e2e}"
export DB_USERNAME="${DB_USERNAME:-haubaboss}"
export DB_PASSWORD="${DB_PASSWORD:-secret}"

API_PORT="${API_PORT:-8010}"
STORE_PORT="${STORE_PORT:-3010}"

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${STORE_PID:-}" ]] && kill "$STORE_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== migrate + seed =="
(cd "$BACKEND_DIR" && php artisan migrate:fresh --force \
  && php artisan tinker --execute "require '$E2E_DIR/seed.php';")

echo "== start Laravel API on :$API_PORT =="
(cd "$BACKEND_DIR" && php artisan serve --host 127.0.0.1 --port "$API_PORT" >/tmp/e2e-api.log 2>&1) &
API_PID=$!

echo "== build + start storefront on :$STORE_PORT =="
(cd "$STORE_DIR" && npm run build >/tmp/e2e-store-build.log 2>&1)
(cd "$STORE_DIR" && API_URL="http://127.0.0.1:$API_PORT" PORT="$STORE_PORT" npm start >/tmp/e2e-store.log 2>&1) &
STORE_PID=$!

echo "== wait for services =="
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 \
    && curl -sf "http://localhost:$STORE_PORT" >/dev/null 2>&1 && break
  sleep 1
done

echo "== run playwright =="
STORE_URL="http://localhost:$STORE_PORT" API_URL="http://127.0.0.1:$API_PORT" npx playwright test "$@"
