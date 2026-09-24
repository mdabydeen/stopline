#!/usr/bin/env bash
# Creates github.com/mdabydeen/stopline (public) and pushes. Needs `gh auth login` done once.
set -euo pipefail
cd "$(dirname "$0")/.."
git init -q -b main 2>/dev/null || true
git add -A
git status --short
git commit -q -m "stopline: decision gate for browser agents using Jev or Laya

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PiLsCdYwvGUYtrZjvwZfqi" || echo "(nothing new to commit)"
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create mdabydeen/stopline --public --source . \
    --description "A decision gate for browser agents: Jev or Laya classifies each proposed action, a policy in code decides whether it runs." \
    --push
else
  git push -u origin main
fi
gh repo view mdabydeen/stopline --json url -q .url
