#!/usr/bin/env bash
# Vérifie que l'appli se met à jour toute seule : une appli restée ouverte (comme sur l'écran d'accueil
# d'un iPhone, ou la borne) doit passer à la nouvelle version dès qu'elle revient à l'écran.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=e2e/.out/update
mkdir -p "$OUT"
export VITE_SUPABASE_URL=http://127.0.0.1:9 VITE_SUPABASE_KEY=test

BUILD_STAMP=2026-01-01T10:00:00.000Z npx vite build --outDir "$OUT/dist" --emptyOutDir >"$OUT/build1.log" 2>&1
npx vite preview --outDir "$OUT/dist" --port 4174 --strictPort --host 127.0.0.1 >"$OUT/preview.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -fs http://127.0.0.1:4174/ >/dev/null && break; sleep 0.5; done

node e2e/update.cjs "$OUT"
