#!/usr/bin/env bash
# Creates github.com/mdabydeen/stopline (public) and pushes. Needs `gh auth login` done once.
set -euo pipefail
cd "$(dirname "$0")/.."
git init -q -b main 2>/dev/null || true

# Stage only the files this repository publishes. results/ is deliberately
# excluded: eval output and evidence logs are generated locally and may contain
# page content or action values.
git add -- \
  .github \
  .gitignore \
  .env.example \
  CONTRIBUTING.md \
  LICENSE \
  README.md \
  SECURITY.md \
  demo \
  docs \
  eval \
  fixtures \
  package.json \
  package-lock.json \
  scripts \
  src \
  tsconfig.json

git status --short

# Pre-commit checks: whitespace errors and obvious secrets in staged additions.
git diff --cached --check
if git diff --cached -U0 -- . ':(exclude).env.example' ':(exclude)scripts/publish-github.sh' \
  | grep -Eq '^\+.*(AI_GATEWAY_API_KEY=[^[:space:]]|VERCEL_OIDC_TOKEN=[^[:space:]]|sk-[A-Za-z0-9])'; then
  echo "refusing to commit: possible secret in staged changes" >&2
  exit 1
fi

git commit -q -m "stopline: decision gate for browser agents using Jev or Laya" || echo "(nothing new to commit)"
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create mdabydeen/stopline --public --source . \
    --description "A decision gate for browser agents: Jev or Laya classifies each proposed action, a policy in code decides whether it runs." \
    --push
else
  git push -u origin main
fi
gh repo view mdabydeen/stopline --json url -q .url
