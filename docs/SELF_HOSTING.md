# Self-hosting Ralph (dogfooding)

Ralph can build Ralph: point the AFK loop at this repo and let the implementer →
reviewer pipeline ship changes. This runbook makes that one command.

## What makes self-hosting trustworthy here

- **`CLAUDE.md`** carries the repo's hard constraints (ESM `.js` import extensions,
  "first stage is the gate", the CLI has no build step, `bypassPermissions`). The
  agent reads it automatically via the playbooks' ORIENT step, so it doesn't have to
  rediscover them.
- **The verifying reviewer stage** (`packages/core/templates/review.md`) runs
  `pnpm -r typecheck`, `pnpm -r build`, and `pnpm test`, and refuses to emit
  `<review>OK</review>` while anything is red.
- **CI** (`.github/workflows/ci.yml`) re-runs the same checks on the PR, so a bad
  auto-commit can't merge green.
- **Conventional commits** drive release-please, so a self-hosted change flows into a
  Release PR and a versioned publish without extra steps (see `RELEASING.md`).

## Prerequisites

- Docker, Node ≥20, pnpm ≥9.
- `claude /login` and `gh auth login` completed **in the same shell context** you'll
  run the loop from (see the README "Windows + WSL: credentials" note — PowerShell
  `$HOME` and WSL `$HOME` are separate credential stores).
- The `ralph-sandbox` image is pulled/built automatically on first run.

## Run it

Always run on a throwaway branch — the loop commits to your current branch, and the
sandbox's blast radius is the workspace mount (recoverable via git).

```bash
git switch -c dogfood/run
```

### GitHub-issue loop (default)

The issue playbook works on **AFK** issues only and ignores HITL ones, so label or
title the issues you want the loop to pick accordingly first. Then:

```bash
scripts/dogfood.sh 5         # up to 5 iterations against open issues
```

Each iteration: the implementer picks one issue, implements it, runs the feedback
loops, commits with a Conventional Commit message, and closes/comments the issue; the
reviewer then verifies and either passes or commits a `fix(review):`. The loop stops
early when the agent emits `NO MORE TASKS`.

### Plan/PRD loop

```bash
RALPH_DOGFOOD_MODE=plan RALPH_PLAN="$(cat docs/plans/your-plan.md)" \
  scripts/dogfood.sh 8
```

The agent works the plan task by task and emits `NO MORE TASKS` once every acceptance
criterion is met.

## After a run

```bash
git log --oneline origin/main..HEAD     # what the loop produced
pnpm -r typecheck && pnpm -r build && pnpm test
git push -u origin dogfood/run          # open a PR; CI runs the same gate
```

Review the diff like any human PR. The reviewer stage and CI reduce — but do not
remove — the need for a human merge decision.
