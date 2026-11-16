#!/usr/bin/env bash
# Tests de la base : règles de sécurité et pointeuse, sur un PostgreSQL local.
set -euo pipefail
cd "$(dirname "$0")/.."
SUPER="${PGSUPER_URL:-postgres://postgres:postgres@127.0.0.1:5432}"
bash scripts/local-db.sh nuba_test
for f in supabase/tests/tests*.sql; do
  psql -q -v ON_ERROR_STOP=1 "$SUPER/nuba_test" -f "$f"
done
echo "Tests de la base : OK"
