# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository. See [.Codex/AGENTS.md](.Codex/AGENTS.md) (behavioral rules).

## What this repo is

Ralph is a Node/TypeScript harness that drives the Codex CLI against a target repository in an iterating implementer → reviewer loop, running `Codex` directly on the host. It ships as a pnpm monorepo with two npm packages:

- `@daonhan/ralph-core` (`packages/core`) — library: loop driver, native-sandbox runner, template renderer, stage registry. ESM, TS-compiled to `dist/`.
- `@daonhan/ralph` (`apps/cli`) — CLI exposing `ralph-afk` (plan/PRD loop) and `ralph-ghafk` (GitHub-issue loop) bin entries. Hand-written JS bins, no build step. Depends on `@daonhan/ralph-core` via `workspace:^`.

## Commands

All commands run from the repo root unless noted. Node ≥20, pnpm ≥9.

```bash
pnpm install                 # link workspace, hoist devDeps
pnpm -r build                # compile packages/core/dist (tsc -p tsconfig.json)
pnpm -r typecheck            # tsc --noEmit across workspace
pnpm -r clean                # rm packages/core/dist
pnpm publish-all             # pnpm -r publish --access public --no-git-checks
```

Verification = `pnpm -r typecheck` + `pnpm -r test` (`packages/core` runs `vitest run`; `apps/cli` has no tests) + root `pnpm test` (`node --test` over `scripts/*.test.mjs`). A husky pre-commit hook runs `lint-staged` (`prettier --ignore-unknown --write` on staged files) then `pnpm typecheck`. Full contributor guide: [CONTRIBUTING.md](CONTRIBUTING.md).

Per-package: `pnpm --filter @daonhan/ralph-core build` (only core has a build).

### Smoke-test the published artifacts locally

```bash
pnpm -r build
(cd packages/core && pnpm pack --pack-destination /tmp/ralph-packs)
(cd apps/cli      && pnpm pack --pack-destination /tmp/ralph-packs)
npm i -g /tmp/ralph-packs/daonhan-ralph-core-*.tgz /tmp/ralph-packs/daonhan-ralph-*.tgz
ralph-afk          # → prints usage
```

`pnpm link --global` is brittle inside this workspace (pnpm 9 rewrites the dependent's manifest) — use the pack-then-install path.

### Running the bins against a target workspace

```bash
ralph-afk "<plan-and-prd>" <iterations>          # plan/PRD-driven loop
ralph-ghafk <iterations>                          # GitHub-issue-driven loop
ralph-afk --print-config                          # diagnose: print workspace / runner / sandbox config
```

Bins also accept `--help` / `-h`. `$RALPH_WORKSPACE` overrides cwd as the target workspace; `$RALPH_RUNNER` selects `sandbox` (default — native OS sandbox, writes confined to the workspace) or `host` (unsandboxed); `$RALPH_SANDBOX_NET` is an optional comma-separated egress domain allowlist for the sandbox. Other env knobs: `$RALPH_RESULT_GRACE_MS` (post-result grace timer, default `30000`, `0` disables), `$RALPH_MODEL` (pass-through `--model <value>` to the Codex CLI; unset = CLI default), `$NO_COLOR` / `$TERM=dumb` (disable ANSI). Bins also accept `--version`/`-V`, `--no-keep-alive`, `--max-retries <N>`, `--detach`, `--log <path>`, `--notify` (see README "Running AFK"). Docker is no longer required. npm releases are automated via release-please — see [RELEASING.md](RELEASING.md).

## Architecture

The core library is ~12 source files in `packages/core/src/` (plus a `__tests__/` vitest suite). Read the loop spine in order to understand the system:

1. **`main.ts` / `gh-main.ts`** — thin bin entrypoints. Each just calls `runBin` (`run-bin.ts`) with its stage chain + a `takesInputArg` flag. `runBin` parses flags via `cli-help.ts`, resolves `workspaceDir` / `packageDir` from env vars, then calls `runLoop`.
2. **`loop.ts`** (`runLoop`) — drives the iteration. For each iteration, walks the stage chain. **First stage is the gate**: its `result` string is sentinel-checked for `<promise>NO MORE TASKS</promise>` and the loop exits early on hit. Subsequent stages always run after a non-sentinel gate.
3. **`render.ts`** (`renderTemplate`) — expands the five template tags below before each stage runs. Synchronous, uses host `execSync` for shell tags.
4. **`runner.ts`** (`runStage`) — host runner plumbing.
   - `runStage`: writes the rendered prompt to `<workspaceDir>/.ralph-tmp/.run-<pid>-<iter>-<ts>.md`, spawns `Codex --verbose --print --output-format stream-json --permission-mode <mode> "Read the full instructions from ./.ralph-tmp/<file> …"` with `cwd = workspaceDir`. When `RALPH_RUNNER=sandbox` (default), writes a transient `--settings` JSON enabling the native OS sandbox with writes confined to the workspace. Streams NDJSON from stdout, captures the `result` event's payload as the stage return value. Tempfiles cleaned in `finally`.
5. **`stages.ts`** — three named stages (`implementer`, `ghafkImplementer`, `reviewer`), each pairing a template filename with a Codex `permissionMode` (always `bypassPermissions` — AFK requires non-interactive bash/edit approval; blast radius bounded by the runner sandbox).
6. **AFK machinery** — `cli-help.ts` (flag parsing: `--detach` / `--notify` / `--max-retries` / `--no-keep-alive` / `--log` / `--version` / `--print-config`), `retry.ts` (`withRetries`, default 3 + exponential backoff), `keepalive.ts` (OS wake-lock acquire/release), `detach.ts` (fork-and-exit background run), `notify.ts` (OS toast + bell). `loop.ts` wires these in and handles `SIGINT`→exit 130 / `SIGTERM`→exit 143 by aborting the active stage via an `AbortController`. Full runtime model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Loop topology

```
ralph-afk   → [STAGES.implementer,        STAGES.reviewer]   inputs = "<plan-and-prd>"
ralph-ghafk → [STAGES.ghafkImplementer,   STAGES.reviewer]   inputs = ""
```

Gate = first stage. Reviewer never gates.

### Template renderer (the part most likely to bite you)

Templates live in `packages/core/templates/`. Five tag forms, expanded in this order (`@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}`):

| Tag                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@include:<path>`    | Inline a file via `readFileSync`. Path resolved against the template's dir when relative. **No shell**. Used to inject the agent playbooks (`prompt.md`, `ghprompt.md`) into the iteration templates (`afk.md`, `ghafk.md`).                                                                                                                                                                                                                                                   |
| `@spill[?]:<name>=…` | Run a command, write its stdout to `<spill-dir>/<name>`, and substitute the workspace-relative path `./.ralph-tmp/spill-…/<name>` into the prompt (the agent `Read`s it). The `?` form writes a fallback string on non-zero exit; `<name>` must be a plain filename (no path separators / `..`). Keeps large outputs (HEAD patch in `review.md`, full issue bodies in `ghafk.md`) out of the prompt. Requires `spillHostDir`/`spillRefPath` (supplied per-stage by `runLoop`). |
| `` !?`<cmd>          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |     | <fallback>` `` | Try-shell. `execSync` with stderr suppressed; non-zero exit returns the literal `<fallback>` string. Match order matters: this regex matches before the plain `!` form. Use for cross-platform safety. |
| `` !`<cmd>` ``       | Plain shell. `execSync` with `cwd = workspaceDir`. Failures throw and abort the iteration.                                                                                                                                                                                                                                                                                                                                                                                     |
| `{{ INPUTS }}`       | Replaced with the `inputs` string passed to `runLoop`.                                                                                                                                                                                                                                                                                                                                                                                                                         |

Shell resolution lives in `resolveShell()` in `render.ts`: Linux/macOS → `/bin/bash`. Windows → walks `$PATH` looking for `bash.exe` (Git for Windows or WSL passthrough), falls back to `cmd.exe`. **Templates should prefer `!?` over `!` for any command that might be unavailable on `cmd.exe`** (e.g. `git log` redirects, `gh issue list`).

### Per-iteration scratch dir

Every run writes to `<workspaceDir>/.ralph-tmp/` on the host (gitignored): the rendered prompt as `.run-<pid>-<iter>-<ts>.md` (cleaned in `finally`, may leak on SIGKILL — safe to delete) a per-stage spill dir `spill-<pid>-<iter>-<stageIdx>-<ts>/` holding `@spill` output (also cleaned in `finally`), and the NDJSON stream log as `logs/<ts>-iter<N>-<stageName>.ndjson` (kept; `--detach` adds `logs/detached-<pid>.log`).

### Credentials

`Codex` and `gh` on the host read `~/.Codex`, `~/.Codex.json`, and `~/.config/gh` natively — no mounts needed. Run `Codex /login` and `gh auth login` once in the shell you use to invoke the bins.

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`. Relative imports in `packages/core/src/` end in `.js` (compiled output extension, required by `moduleResolution: NodeNext`).
- **First stage is always the gate.** If you add stages via `STAGES` and wire them into a chain, place gating stages at index 0. The sentinel string `<promise>NO MORE TASKS</promise>` is hardcoded in `loop.ts`.
- **No build step for `apps/cli`.** Bins are hand-written JS that `import { runAfk } from "@daonhan/ralph-core"`. Don't add TS to `apps/cli` — keep the bin layer flat.
- **Templates ship in the npm tarball.** `packages/core/package.json` `files` includes `templates/`. Adding a new stage means: (1) extend `STAGES` in `stages.ts`, (2) drop a new `*.md` in `packages/core/templates/`, (3) reference it from the chain in `main.ts` / `gh-main.ts`.
- **Permission mode is always `bypassPermissions`** for all stages — AFK requires it. Comment in `stages.ts` explains the blast-radius reasoning.

## Files for orientation

- `README.md` — extensive user-facing docs (install paths per OS, first-run setup, troubleshooting). Read for usage/setup questions.
- `RELEASING.md` — single source of truth for releasing both npm packages (release-please flow, version policy, required secrets, rollback runbook). `docs/PUBLISHING.md` is a stub pointing here.
- `CONTRIBUTING.md` — maintainer/contributor guide (dev loop, tests, adding a stage, releasing). `docs/ARCHITECTURE.md` — runtime internals reference.
- `packages/core/templates/prompt.md` / `ghprompt.md` — agent playbooks. Edit these to change feedback loops or task priority.
- `packages/core/templates/{afk,ghafk,review}.md` — iteration templates that `@include` the playbooks above.

## Behavioral

Apply `.Codex/AGENTS.md` (think first, simplicity, surgical changes, goal-driven). Make only changes the user asked for; match existing style; prefer smallest correct change; push back on over-engineering; state a brief plan + success criteria for non-trivial work.
