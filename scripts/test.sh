#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
#
# Typecheck, then all three suites against a DISPOSABLE database.
#
# The database is dropped and recreated on every run. A test suite that passes
# only against state left behind by the last run is not a test suite.
set -euo pipefail
cd "$(dirname "$0")/.."

COVERAGE=0
[ "${1:-}" = "--coverage" ] && COVERAGE=1

PORT=${CRIMP_DB_PORT:-5434}
export DATABASE_URL="postgres://crimp:crimp@localhost:${PORT}/crimp_test"
export NODE_ENV=test
# A fixed Ed25519 seed (bytes 0..31), so signed records in tests are reproducible.
export SIGNING_KEY="${SIGNING_KEY:-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=}"

bash scripts/dev-db.sh up >/dev/null
docker exec crimp-pg psql -U crimp -d crimp -q \
  -c 'DROP DATABASE IF EXISTS crimp_test' \
  -c 'CREATE DATABASE crimp_test' >/dev/null

echo "▸ typecheck"
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.test.json

# Integration and e2e share one database and the sweeps are global by design,
# so they run serially. Concurrency itself is tested directly, inside the
# suite, rather than by running the suite concurrently and hoping.
run() {
  if [ "$COVERAGE" = "1" ]; then
    npx c8 --include 'src/**' --reporter=text-summary --check-coverage \
      --statements 90 --branches 85 --lines 90 --functions 85 \
      npx tsx --test --test-concurrency=1 "$@"
  else
    npx tsx --test --test-concurrency=1 "$@"
  fi
}

echo "▸ tests"
run test/unit/*.test.ts test/integration/*.test.ts $(ls test/e2e/*.test.ts 2>/dev/null || true)
