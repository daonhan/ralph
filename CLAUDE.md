# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. See [.claude/CLAUDE.md](.claude/CLAUDE.md) (behavioral rules).

## What this repo is

Ralph is a Node/TypeScript harness that drives the Claude Code CLI against a target repository in an iterating implementer → reviewer loop, inside an ephemeral Docker container (`ralph-sandbox`). It ships as a pnpm monorepo with two npm packages:

- `@daonhan/ralph-core` (`packages/core`) — library: loop driver, docker runner, template renderer, stage registry. ESM, TS-compiled to `dist/`.
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

No test suite, no linter configured. Verification = `pnpm -r typecheck` + manually invoking the bins.

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
ralph-afk --print-config                          # diagnose: print workspace / docker context / image
```

Bins also accept `--help` / `-h`. `$RALPH_WORKSPACE` overrides cwd as the bind-mounted target; `$RALPH_IMAGE` overrides the default `docker.io/daonhan/ralph-sandbox:latest`; `$RALPH_DOCKER_CONTEXT` is the `docker build` fallback context (default: bundled `@daonhan/ralph-core` dir, which ships the `Dockerfile`).

### Building / publishing the sandbox image

```bash
docker build -t docker.io/daonhan/ralph-sandbox:latest -f packages/core/templates/Dockerfile .
```

CI in `.github/workflows/publish-image.yml` publishes multi-arch images on `workflow_dispatch` or a `image-v*` tag push.

## Architecture

The whole thing is small (~7 source files in `packages/core/src/`). Read these in order to understand the system:

1. **`main.ts` / `gh-main.ts`** — bin entrypoints. Both parse flags via `cli-help.ts`, resolve `workspaceDir` / `ralphDir` / `sandcastleDir` from env vars, then call `runLoop` with a different stage chain.
2. **`loop.ts`** (`runLoop`) — drives the iteration. For each iteration, walks the stage chain. **First stage is the gate**: its `result` string is sentinel-checked for `<promise>NO MORE TASKS</promise>` and the loop exits early on hit. Subsequent stages always run after a non-sentinel gate. Calls `ensureImage` once before the loop.
3. **`render.ts`** (`renderTemplate`) — expands the four template tags below before each stage runs. Synchronous, uses host `execSync` for shell tags.
4. **`runner.ts`** (`ensureImage`, `runStage`) — docker plumbing.
   - `ensureImage`: `docker image inspect` → `docker pull` → `docker build` (fallback). Build fallback only runs if pull fails AND `$RALPH_DOCKER_CONTEXT/Dockerfile` exists.
   - `runStage`: writes the rendered prompt to `<workspaceDir>/.ralph-tmp/.run-<pid>-<iter>-<ts>.md`, spawns `docker run --rm -i … claude --verbose --print --output-format stream-json --permission-mode <mode> "Read the full instructions from ./.ralph-tmp/<file> …"`. Streams NDJSON from stdout, captures the `result` event's payload as the stage return value. Tempfile cleaned in `finally`.
5. **`stages.ts`** — three named stages (`implementer`, `ghafkImplementer`, `reviewer`), each pairing a template filename with a Claude `permissionMode` (always `bypassPermissions` — AFK requires non-interactive bash/edit approval; blast radius bounded to the workspace mount).

### Loop topology

```
ralph-afk   → [STAGES.implementer,        STAGES.reviewer]   inputs = "<plan-and-prd>"
ralph-ghafk → [STAGES.ghafkImplementer,   STAGES.reviewer]   inputs = ""
```

Gate = first stage. Reviewer never gates.

### Template renderer (the part most likely to bite you)

Templates live in `packages/core/templates/`. Four tag forms, expanded in this order:

| Tag               | Behavior                                                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@include:<path>` | Inline a file via `readFileSync`. Path resolved against the template's dir when relative. **No shell**. Used to inject the agent playbooks (`prompt.md`, `ghprompt.md`) into the iteration templates (`afk.md`, `ghafk.md`). |
| `` !?`<cmd>       |                                                                                                                                                                                                                              |     | <fallback>` `` | Try-shell. `execSync` with stderr suppressed; non-zero exit returns the literal `<fallback>` string. Match order matters: this regex matches before the plain `!` form. Use for cross-platform safety. |
| `` !`<cmd>` ``    | Plain shell. `execSync` with `cwd = workspaceDir`. Failures throw and abort the iteration.                                                                                                                                   |
| `{{ INPUTS }}`    | Replaced with the `inputs` string passed to `runLoop`.                                                                                                                                                                       |

Shell resolution lives in `resolveShell()` in `render.ts`: Linux/macOS → `/bin/bash`. Windows → walks `$PATH` looking for `bash.exe` (Git for Windows or WSL passthrough), falls back to `cmd.exe`. **Templates should prefer `!?` over `!` for any command that might be unavailable on `cmd.exe`** (e.g. `git log` redirects, `gh issue list`).

### Per-iteration scratch dir

Every run writes to `<workspaceDir>/.ralph-tmp/` on the host (gitignored): the rendered prompt as `.run-<pid>-<iter>-<ts>.md` (cleaned in `finally`, may leak on SIGKILL — safe to delete) and the NDJSON stream log as `logs/<ts>-iter<N>-<stageName>.ndjson`.

### Credential mounts

`runStage` reads `process.env.HOME || USERPROFILE` and bind-mounts (read-only for gh) if present:

- `~/.claude` → `/home/agent/.claude`
- `~/.claude.json` → `/home/agent/.claude.json`
- `~/.config/gh` → `/home/agent/.config/gh:ro`

**Same-shell rule:** these paths resolve against the shell that invoked the bin. PowerShell `$HOME` (`C:\Users\<you>`) and WSL `$HOME` (`/home/<you>`) are separate stores — don't mix. `claude /login` and `gh auth login` must be run from a shell context that matches your eventual invocation context (or copied across — see README "Windows + WSL: credentials").

### Sandbox image

`packages/core/templates/Dockerfile`. Node 22 + .NET SDK 10 + `gh` + `jq` + `git` + Claude Code CLI. User `agent` (UID 1000, renamed from base image's `node`). `safe.directory='*'` globally configured to tolerate bind-mount UID mismatch on Windows.

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`. Relative imports in `packages/core/src/` end in `.js` (compiled output extension, required by `moduleResolution: NodeNext`).
- **First stage is always the gate.** If you add stages via `STAGES` and wire them into a chain, place gating stages at index 0. The sentinel string `<promise>NO MORE TASKS</promise>` is hardcoded in `loop.ts`.
- **No build step for `apps/cli`.** Bins are hand-written JS that `import { runAfk } from "@daonhan/ralph-core"`. Don't add TS to `apps/cli` — keep the bin layer flat.
- **Templates ship in the npm tarball.** `packages/core/package.json` `files` includes `templates/` and `Dockerfile`. Adding a new stage means: (1) extend `STAGES` in `stages.ts`, (2) drop a new `*.md` in `packages/core/templates/`, (3) reference it from the chain in `main.ts` / `gh-main.ts`.
- **Permission mode is always `bypassPermissions`** for stages running inside `ralph-sandbox` — AFK requires it. Comment in `stages.ts` explains the blast-radius reasoning.

## Files for orientation

- `README.md` — extensive user-facing docs (install paths per OS, first-run setup, troubleshooting). Read for usage/setup questions.
- `docs/PUBLISHING.md` — npm publish notes.
- `packages/core/templates/prompt.md` / `ghprompt.md` — agent playbooks. Edit these to change feedback loops or task priority.
- `packages/core/templates/{afk,ghafk,review}.md` — iteration templates that `@include` the playbooks above.

## Behavioral

Apply `.claude/CLAUDE.md` (think first, simplicity, surgical changes, goal-driven). Make only changes the user asked for; match existing style; prefer smallest correct change; push back on over-engineering; state a brief plan + success criteria for non-trivial work.
