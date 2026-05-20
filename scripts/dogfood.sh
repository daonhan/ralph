#!/usr/bin/env bash
# Run Ralph against its OWN repo (dogfood / self-hosting).
#
# Uses the locally-built workspace (not the published packages), so you exercise
# your working changes. See docs/SELF_HOSTING.md for the full runbook.
#
# Usage:
#   scripts/dogfood.sh [iterations]            # GitHub-issue loop (default)
#   RALPH_DOGFOOD_MODE=plan RALPH_PLAN="$(cat docs/plans/foo.md)" \
#     scripts/dogfood.sh [iterations]          # plan/PRD loop
#
# Env:
#   RALPH_DOGFOOD_MODE  gh (default) | plan
#   RALPH_PLAN          required when MODE=plan: the plan+PRD string
set -euo pipefail

ITER="${1:-5}"
MODE="${RALPH_DOGFOOD_MODE:-gh}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[dogfood] building the local workspace…"
pnpm install --frozen-lockfile
pnpm -r build

# Safety: don't churn main. Suggest a throwaway branch if we're on it.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
if [ "$BRANCH" = "main" ]; then
  echo "[dogfood] refusing to run on 'main'. Create a branch first, e.g.:" >&2
  echo "          git switch -c dogfood/run" >&2
  exit 1
fi

echo "[dogfood] mode=$MODE iterations=$ITER branch=$BRANCH"
case "$MODE" in
  gh)
    exec node apps/cli/bin/ralph-ghafk.js "$ITER"
    ;;
  plan)
    : "${RALPH_PLAN:?set RALPH_PLAN to your plan+PRD string (or: RALPH_PLAN=\"\$(cat plan.md)\")}"
    exec node apps/cli/bin/ralph-afk.js "$RALPH_PLAN" "$ITER"
    ;;
  *)
    echo "[dogfood] unknown RALPH_DOGFOOD_MODE='$MODE' (use gh|plan)" >&2
    exit 1
    ;;
esac
