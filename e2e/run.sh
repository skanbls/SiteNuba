#!/usr/bin/env bash
# Test de bout en bout : vraie base PostgreSQL locale, vraies règles de sécurité, vrai navigateur.
# Prérequis : PostgreSQL 16 local (voir scripts/local-db.sh) et Playwright (npm i -D playwright si absent).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=e2e/.out
BIN=e2e/.bin
mkdir -p "$OUT/shots" "$BIN"
SUPER="${PGSUPER_URL:-postgres://postgres:postgres@127.0.0.1:5432}"
export JWT_SECRET="nuba-e2e-secret-nuba-e2e-secret-0123456789"

if [ ! -x "$BIN/postgrest" ]; then
  curl -fsSL -o "$BIN/postgrest.tar.xz" https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
  tar -xJf "$BIN/postgrest.tar.xz" -C "$BIN" && rm "$BIN/postgrest.tar.xz"
fi

bash scripts/local-db.sh nuba_e2e >/dev/null 2>&1

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

PGRST_DB_URI="postgres://authenticator:authenticator@127.0.0.1:5432/nuba_e2e" PGRST_DB_SCHEMAS=public \
PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$JWT_SECRET" PGRST_SERVER_PORT=3999 \
  "$BIN/postgrest" >"$OUT/postgrest.log" 2>&1 &
PIDS+=($!)
DB_URL="$SUPER/nuba_e2e" PORT=54321 node e2e/gateway.mjs >"$OUT/gateway.log" 2>&1 &
PIDS+=($!)

ANON=$(node e2e/gateway.mjs --anon-key)
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_KEY="$ANON" npx vite build --outDir "$OUT/dist" --emptyOutDir >"$OUT/build.log" 2>&1
npx vite preview --outDir "$OUT/dist" --port 4173 --strictPort --host 127.0.0.1 >"$OUT/preview.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 60); do
  if curl -fs http://127.0.0.1:4173/ >/dev/null && curl -fs http://127.0.0.1:3999/ >/dev/null 2>&1; then break; fi
  sleep 0.5
done

DB_URL="$SUPER/nuba_e2e" node e2e/flow.cjs
