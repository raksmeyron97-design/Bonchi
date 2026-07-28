#!/usr/bin/env bash
#
# Applies every migration to a throwaway PostgreSQL container and runs the SQL
# test suite against it.
#
# This exists so tenant isolation, ledger immutability and idempotency are proven
# by execution rather than by inspection, and so CI can prove them without
# booting the full Supabase stack. `supabase test db` remains the way to run the
# same suite against a real Supabase instance; see docs/testing/test-strategy.md.
#
# Usage:  ./scripts/db-test.sh [--keep]
#           --keep   leave the container running for manual psql poking

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="bonchi-db-test"
IMAGE="postgres:16-alpine"
DB_NAME="bonchi_test"
DB_USER="postgres"
DB_PASSWORD="postgres"
HOST_PORT="${BONCHI_TEST_DB_PORT:-55432}"
KEEP=0

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cleanup() {
  if [[ "$KEEP" -eq 0 ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  else
    echo ""
    echo "Container kept running. Connect with:"
    echo "  psql postgresql://${DB_USER}:${DB_PASSWORD}@localhost:${HOST_PORT}/${DB_NAME}"
  fi
}
trap cleanup EXIT

echo "==> Starting $IMAGE as $CONTAINER"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "${HOST_PORT}:5432" \
  "$IMAGE" >/dev/null

echo -n "==> Waiting for PostgreSQL"
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 1
done

if ! docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
  echo ""
  echo "PostgreSQL did not become ready in time." >&2
  exit 1
fi

# ON_ERROR_STOP is essential: a migration that half-applies must fail the run.
run_sql_file() {
  local file="$1"
  docker exec -i "$CONTAINER" psql \
    --username "$DB_USER" \
    --dbname "$DB_NAME" \
    --set ON_ERROR_STOP=1 \
    --quiet \
    --no-psqlrc \
    -f - < "$file"
}

echo "==> Loading test auth shim"
run_sql_file "$ROOT_DIR/supabase/tests/00_auth_shim.sql"

echo "==> Applying migrations"
for migration in "$ROOT_DIR"/supabase/migrations/*.sql; do
  echo "    $(basename "$migration")"
  run_sql_file "$migration"
done

echo "==> Loading seed data"
run_sql_file "$ROOT_DIR/supabase/seed.sql"

echo "==> Running tests"
FAILED=0
PASS_COUNT=0
OUTPUT_DIR="$(mktemp -d)"

for test_file in "$ROOT_DIR"/supabase/tests/*.test.sql; do
  name="$(basename "$test_file")"
  echo ""
  echo "--- $name"
  log="$OUTPUT_DIR/$name.log"

  # psql's exit code must be read directly, not through a pipe — a pipeline
  # reports grep's status, which would report a failing migration as a pass.
  if run_sql_file "$test_file" >"$log" 2>&1; then
    sed -e 's/^NOTICE:  //' -e '/^CONTEXT:/d' -e '/^DETAIL:/d' "$log"
    PASS_COUNT=$((PASS_COUNT + $(grep -c "NOTICE:  PASS" "$log" || true)))
  else
    sed -e 's/^NOTICE:  //' "$log"
    echo "!!! $name FAILED"
    FAILED=1
  fi
done

rm -rf "$OUTPUT_DIR"

echo ""
if [[ "$FAILED" -ne 0 ]]; then
  echo "==> DATABASE TESTS FAILED"
  exit 1
fi

echo "==> All database tests passed ($PASS_COUNT assertions)"
