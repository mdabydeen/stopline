#!/usr/bin/env bash
# One-shot local run: install, auth Jev through the Vercel CLI, test, eval, demo.
# Optional Laya comparison: SKIP_LAYA=1 to skip it.
#
#   bash scripts/run-local.sh 2>&1 | tee results/run-local.log
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p results

echo "== node $(node --version), npm $(npm --version)"
npm install --no-audit --no-fund
npx playwright install chromium

echo "== vercel auth"
command -v vercel >/dev/null || { echo "vercel CLI not found (npm i -g vercel)"; exit 1; }
vercel whoami
if [ ! -f .vercel/project.json ]; then
  vercel link --yes
fi
vercel env pull .env.local --yes
grep -q '^VERCEL_OIDC_TOKEN=' .env.local && echo "VERCEL_OIDC_TOKEN present in .env.local"

echo "== typecheck and unit tests"
npx tsc --noEmit
npm test

echo "== eval: keyword baseline"
STOPLINE_BACKEND=keyword npm run eval | tail -40

echo "== eval: jev via AI Gateway (3 repeats)"
STOPLINE_BACKEND=jev REPEATS=3 npm run eval

echo "== demo: jev"
STOPLINE_BACKEND=jev npm run demo

if [ "${SKIP_LAYA:-0}" != "1" ]; then
  echo "== laya: install and serve locally"
  PY=""
  for c in python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then PY="$c"; break; fi
  done
  if [ -z "$PY" ]; then echo "No Python 3.10+ found; skipping Laya"; exit 0; fi
  [ -d .venv-laya ] || "$PY" -m venv .venv-laya
  .venv-laya/bin/python -m pip install --quiet --upgrade pip
  .venv-laya/bin/python -m pip install --quiet "laya[serve]"
  .venv-laya/bin/python -c "import laya; print('laya', getattr(laya, '__version__', '?'))"
  LAYA_DEVICE="${LAYA_DEVICE:-mps}" LAYA_PRELOAD=1 LAYA_HOST=127.0.0.1 LAYA_PORT=8000 \
    .venv-laya/bin/laya-serve > results/laya-serve.log 2>&1 &
  LAYA_PID=$!
  trap 'kill $LAYA_PID 2>/dev/null || true' EXIT
  echo "waiting for laya-serve (first run downloads checkpoints)..."
  for i in $(seq 1 180); do
    if curl -sf -o /dev/null -X POST localhost:8000/v1/systemone -H 'content-type: application/json' \
      -d '{"state":"ping","questions":{"x":{"type":"noul","instructions":"Is this a ping?"}}}'; then break; fi
    sleep 5
  done
  echo "== eval: laya (3 repeats)"
  STOPLINE_BACKEND=laya REPEATS=3 npm run eval
  echo "== demo: laya"
  STOPLINE_BACKEND=laya npm run demo
fi

echo "== done"
