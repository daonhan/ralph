# CLAUDE.md

Guidance for Claude Code working in this repo. Behavioral rules: [.claude/CLAUDE.md](.claude/CLAUDE.md).

## What this is

Ralph drives the Claude Code CLI against a target repo in an iterating implementer → reviewer loop, running `claude` directly on the host. pnpm monorepo, two ESM packages:

- `@phamvuhoang/ralph-core` (`packages/core`) — library: loop driver, native-sandbox runner, template renderer, stage registry. TS → `dist/`.
- `@phamvuhoang/ralph` (`apps/cli`) — `ralph-afk` (plan/PRD loop) + `ralph-ghafk` (GitHub-issue loop) bins. Hand-written JS, no build. Depends on core via `workspace:^`.

## Commands

Node ≥20, pnpm ≥9. From repo root:

```bash
pnpm install
pnpm -r build        # compile packages/core/dist (only core builds)
pnpm -r typecheck
pnpm -r test         # core: vitest; cli: none
pnpm test            # root: node --test over scripts/*.test.mjs
```

Verify = `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit hook runs prettier (lint-staged) + typecheck. Releases are automated via release-please ([RELEASING.md](RELEASING.md)) — **never hand-edit `version` fields or `.release-please-manifest.json`; use a `Release-As:` footer.**

## Running the bins

```bash
ralph-afk "<plan-and-prd>" <iterations>
ralph-ghafk <iterations>
ralph-afk --print-config     # resolve workspace/runner/sandbox config
```

Key env: `RALPH_WORKSPACE` (target repo, default cwd), `RALPH_RUNNER` (`sandbox` default = native OS sandbox confining writes to the workspace; `host` = unsandboxed), `RALPH_MODEL` (pass-through `--model`). Notable flags: `--budget <usd>`, `--cooldown <ms>`, `--review-panel`, `--watch`/`--watch-interval` (ghafk only), `--detach`, `--notify`, `--max-retries`. Full env/flag reference: README + `cli-help.ts`.

## Architecture

Core is ~18 files in `packages/core/src/` (+ `__tests__/` vitest). The loop spine:

1. **`main.ts`/`gh-main.ts`** → **`run-bin.ts`** (`runBin`): parse flags (`cli-help.ts`), resolve dirs, call `runLoop`.
2. **`loop.ts`** (`runLoop`): walks the stage chain each iteration. **First stage is the gate** — its result is checked for the sentinel `<promise>NO MORE TASKS</promise>`; on hit the loop exits. Tallies cost (`accountStage`); `--budget` halts at the ceiling, `--cooldown` paces with throttle backoff (`pacing.ts`).
3. **`render.ts`** (`renderTemplate`): expands template tags (below) before each stage.
4. **`stage-exec.ts`** (`executeStage`): wraps `runner.ts` `runStage` in `withRetries` (`retry.ts`). Single entry for `loop.ts` and `panel.ts`.
5. **`runner.ts`** (`runStage`): writes the rendered prompt to `.ralph-tmp/`, spawns `claude --print --output-format stream-json --permission-mode bypassPermissions` with `cwd = workspaceDir`; in sandbox mode writes a transient `--settings` confining writes. Streams NDJSON, returns the `result` payload.
6. **`stages.ts`**: stages `implementer` / `ghafkImplementer` / `reviewer`, each a template + `permissionMode` (always `bypassPermissions`).

Topology (gate = first stage; reviewer never gates):

```
ralph-afk   → [implementer,      reviewer]   inputs = "<plan-and-prd>"
ralph-ghafk → [ghafkImplementer, reviewer]   inputs = ""
```

Support: `keepalive.ts` (wake-lock), `detach.ts` (background run), `notify.ts` (toast+bell), `stream-render.ts` (ANSI UI). `loop.ts` handles SIGINT→130 / SIGTERM→143 via `AbortController`. Internals: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Review panel & watch mode

- `--review-panel` (or `RALPH_REVIEW_LENSES`, default `correctness,security,tests`) replaces the reviewer with `runPanel` (`panel.ts`): read-only per-lens reviewers (`review-lens.md`) write findings, then a synth stage (`review-synth.md`) dedupes them into one `fix(review):` commit.
- `--watch` (ghafk only) → `runWatch` (`watch.ts`): daemon polling open issues labelled `RALPH_WATCH_LABEL` (default `ralph`); `--budget` spans the whole daemon lifetime.

### Template renderer (most likely to bite you)

Templates in `packages/core/templates/`. Tags expand in this order: `@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}`:

- `@include:<path>` — inline a file (no shell). Injects playbooks (`prompt.md`/`ghprompt.md`) into iteration templates (`afk.md`/`ghafk.md`).
- `` @spill[?]:<name>=`cmd` `` — run cmd, write stdout to a spill file, substitute its workspace-relative path (agent `Read`s it). Keeps large output (HEAD patch, issue bodies) out of the prompt. `?` = fallback on non-zero exit.
- `` !?`cmd|||fallback` `` — try-shell; non-zero exit → the literal fallback. Matches before plain `!`. **Prefer this for any command that may be absent on Windows `cmd.exe`.**
- `` !`cmd` `` — plain shell (`cwd = workspaceDir`); failure aborts the iteration.
- `{{ INPUTS }}` — the `inputs` string.

Shell (`resolveShell()`): `/bin/bash` on Linux/macOS; Windows walks `$PATH` for `bash.exe`, else `cmd.exe`.

### Scratch dir & learning loop

- `<workspaceDir>/.ralph-tmp/` (gitignored): rendered prompt `.run-*.md` + per-stage `spill-*/` (both cleaned in `finally`); NDJSON `logs/*.ndjson` (kept; `--detach` adds `detached-<pid>.log`).
- `<workspaceDir>/.ralph/LEARNINGS.md` (**git-tracked**, distinct from `.ralph-tmp/`): durable memory injected into every stage via a `<learnings>` block; playbooks append conventions/gotchas/decisions/dead-ends within the work commit. Created lazily; absent-file safe via `!?`.

### Credentials

`claude` and `gh` read `~/.claude`, `~/.claude.json`, `~/.config/gh` natively. Run `claude /login` + `gh auth login` once.

## Conventions

- **ESM only.** Relative imports in `packages/core/src/` end in `.js` (NodeNext).
- **First stage is the gate.** Place gating stages at index 0; the sentinel is hardcoded in `loop.ts`.
- **No build for `apps/cli`** — hand-written JS importing `@phamvuhoang/ralph-core`. Keep the bin layer flat.
- **Templates ship in the tarball** (`packages/core/package.json` `files`). New stage = (1) add to `STAGES`, (2) add `templates/<name>.md`, (3) wire it into the chain in `main.ts`/`gh-main.ts`.
- **`permissionMode` is always `bypassPermissions`** — AFK requires it; blast radius bounded by the sandbox runner.
- **Never hand-edit release version state** — release-please owns it (RELEASING.md).

## Orientation

- `README.md` — user docs (install, setup, full env/flags, troubleshooting).
- `RELEASING.md` — release flow, version policy, secrets, rollback.
- `CONTRIBUTING.md` / `docs/ARCHITECTURE.md` — contributor guide / runtime internals.
- `templates/prompt.md`, `ghprompt.md` — agent playbooks (edit to change feedback loops / task priority).
- `templates/{afk,ghafk,review,review-lens,review-synth}.md` — iteration + reviewer templates.

## Behavioral

Apply [.claude/CLAUDE.md](.claude/CLAUDE.md): think first, simplest correct change, surgical edits, push back on over-engineering, state a brief plan + success criteria for non-trivial work.
