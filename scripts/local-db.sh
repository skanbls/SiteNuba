#!/usr/bin/env bash
# Recrée une base locale « façon Supabase » et y applique toutes les migrations.
# Usage : scripts/local-db.sh <nom_de_base>
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${1:?nom de base manquant}"
SUPER="${PGSUPER_URL:-postgres://postgres:postgres@127.0.0.1:5432}"
psql -q -v ON_ERROR_STOP=1 "$SUPER/postgres" -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 "$SUPER/$DB" -f supabase/tests/local_stub.sql
for f in supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 "$SUPER/$DB" -f "$f"
done
echo "Base $DB prête."
