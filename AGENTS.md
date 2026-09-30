# Agent guidance

Ralph is a Node/TypeScript harness that runs Claude Code (default) or Codex in an
ephemeral Docker sandbox against a target repository, using an implementer →
reviewer loop. These instructions apply to work on Ralph itself.

Read [CONTEXT.md](CONTEXT.md) for orientation, [README.md](README.md) for usage,
and the behavioral rules in [.codex/AGENT.md](.codex/AGENT.md) or
[.claude/CLAUDE.md](.claude/CLAUDE.md) for your agent. `AGENTS.md` and `CLAUDE.md`
must stay identical. Link to the documents that own details rather than copying
their runtime tables into this file.

## Repository map

| Path                           | Responsibility                                                     |
| ------------------------------ | ------------------------------------------------------------------ |
| `packages/core/`               | `@daonhan/ralph-core`: ESM TypeScript library; compiled to `dist/` |
| `packages/core/src/loop.ts`    | Iteration gate, retries, signals, history and run-log writes       |
| `packages/core/src/runner.ts`  | Image resolution, Docker mounts, process streaming and cleanup     |
| `packages/core/src/agents/`    | Provider adapters, commands, credentials and JSONL decoders        |
| `packages/core/src/render.ts`  | Host-side template expansion                                       |
| `packages/core/src/__tests__/` | Vitest suite with mocked I/O                                       |
| `packages/core/templates/`     | Shipped playbooks, iteration templates, skills and Dockerfile      |
| `apps/cli/`                    | `@daonhan/ralph`: flat hand-written JS bins; no build step         |
| `scripts/`                     | Root contract tests, smoke checks and contributor tooling          |
| `images/pg17/`                 | Local PostgreSQL 17 + PostGIS sandbox variant                      |
| `.github/workflows/`           | Verification, release-please, npm and image publishing             |
| `docs/`                        | Runtime architecture, PRDs, plans and design decisions             |

Read the loop spine in order: `main.ts` / `gh-main.ts` → `run-bin.ts` → `loop.ts`
→ `render.ts` → `runner.ts` → `agents/types.ts` and the selected adapter.
`stages.ts`, `history.ts`, `run-log.ts` and `stream-render.ts` own the remaining
contracts. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full runtime model.

## Development and verification

Run from the repository root with Node ≥20 and the pinned pnpm 9 version.

```bash
pnpm install
pnpm hooks:install           # install prek pre-commit and pre-push hooks
git diff --check             # cheapest check first
pnpm -r typecheck
pnpm -r build                # root tests and smoke scripts import built dist/
pnpm -r test                 # core Vitest; CLI has no test script
pnpm test                    # root scripts/*.test.mjs contracts
```

Stop on a failed check, fix it, then rerun the relevant verification. For agent
runs, execute Node tests only in the background, without visible terminal
windows, capture their output, and report **pending**, **passed**, **failed** or
**skipped** with reasons. Never describe a pending or skipped check as passing.

Offline smoke checks are listed in [CONTRIBUTING.md](CONTRIBUTING.md#verify).
Sandbox-image changes require `pnpm smoke:image`, including the network check,
before publishing. A `--skip-network` diagnostic does not satisfy that gate.
Review the final diff, configuration syntax and changed documentation links.
Use [the review checklist](docs/REVIEW_CHECKLIST.md) and report limitations.

The pre-push hook skips only ordinary documentation changes. Templates, skills,
agent guidance and other behavior-controlling prose require checks. Mixed
changes and deleted code require checks too. See
[local hooks](CONTRIBUTING.md#pre-push-hook-with-prek) for setup and classification.

## Architectural constraints

- **ESM only.** Relative imports in core TypeScript end in `.js` for NodeNext.
  Keep `apps/cli` in plain JS with no build step.
- **First stage gates.** `ralph-afk` is implementer → reviewer; `ralph-ghafk` is
  ghafk-implementer → reviewer. Only index 0 checks the exact sentinel
  `<promise>NO MORE TASKS</promise>` on its own line. Reviewer never gates;
  later stages run only when the gate moved HEAD.
- **Provider-neutral loop.** Provider differences belong in `agents/`, never
  agent-name branches in `loop.ts` or `render.ts`. New providers implement
  `AgentAdapter`, register in `agents/index.ts`, install in the Dockerfile and
  get decoder coverage; see [adding a provider](CONTRIBUTING.md#adding-a-coding-agent-provider).
- **Templates ship.** A stage change needs the `STAGES` entry, its template and
  chain wiring. Keep templates in the core tarball. Shipped skills live in
  `templates/skills/<name>/`; frontmatter name matches the directory and starts
  with `ralph-`. Reference skills from playbooks, not the loop, and extend the
  shipped-skills contract coverage.
- **History is harness-owned.** Only `loop.ts`, through `history.ts` and
  `run-log.ts`, writes `.ralph/history/`; agents and templates never do.
- **Run log is durable state.** Records are fsynced before acting. Add no new
  `await` before the first `runStage` (`ensureImage` is the only existing one;
  tests count microtask turns). New event types are additive within v1; a new
  required field on a known event type bumps `v`. Preserve live-run claims,
  container labels and cleanup; see [run event log](docs/ARCHITECTURE.md#run-event-log).
- **Template expansion order matters.** `@include` → `@spill` → `!?` → `!` →
  `{{ INPUTS }}` / `{{ HISTORY }}`. Includes are single-pass. User inputs and
  prior agent output are substituted last and must never be re-shelled.

## Safety and scope

- Inspect branch and working-tree status first. Preserve unrelated local edits,
  match existing style, make the smallest correct change and state a brief plan
  plus success criteria for non-trivial work. Avoid speculative abstractions.
- Never commit, push, merge, publish or alter account budgets without the user's
  authorization. Do not bump package versions or the release manifest by hand;
  release-please owns them. See [RELEASING.md](RELEASING.md).
- Template shell tags execute on the **host**. Keep their command bodies static;
  never interpolate inputs, issue/commit text or branch names. Prefer `!?`
  for commands that may be unavailable on Windows `cmd.exe`.
- Every sandbox stage bypasses interactive approvals: Claude
  `bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox`.
  The Docker socket is mounted by default and grants host-Docker access; disable
  with `RALPH_DOCKER_SOCK=0`. Read [SECURITY.md](SECURITY.md) before changing mounts.
- Mount only the selected provider's credentials. PowerShell and WSL homes are
  distinct; authenticate from the same shell context used to launch Ralph.
  Codex credentials are copied into a container-local `CODEX_HOME` because a
  Windows bind mount fails with EPERM. Never expose credential contents in logs.
- Commit identity belongs to the harness: do not set `git config user.*`, pass
  `-c user.*=`, or use `--author`. If identity is missing, report it instead of
  inventing one. Preserve node_modules isolation and sandbox-install warnings.
- `.ralph-tmp/` prompts and spill files are scratch; kept NDJSON logs and
  `.ralph/history/` are diagnostic records. Do not remove them indiscriminately.

## Documentation and ownership

When a change affects architecture, interfaces, or invariants, update the relevant docs before finishing. Delegate the docs pass to a sub-agent.

The primary agent must review the sub-agent's documentation diff for accuracy,
scope and links before declaring completion. The docs delegate owns only that
documentation pass; the implementer retains red → green implementation, and the
reviewer retains refactoring and defect-review ownership. Do not delegate code
changes or expand a task merely because a docs pass was requested.

Use [CONTRIBUTING.md](CONTRIBUTING.md) for practical checks and contribution
rules, [ARCHITECTURE.md](docs/ARCHITECTURE.md) for interfaces/invariants,
[README.md](README.md) for user-visible behavior, and [RELEASING.md](RELEASING.md)
for release changes. Update an existing source of truth instead of duplicating it.

When a commit is authorized, use a short conventional `type(scope): subject`
(≤72 characters), with at most three body bullets for decisions or blockers.
No file lists, `Co-Authored-By` / `Co-authored-by`, or generated-by footers.
