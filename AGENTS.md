# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository. See [.codex/AGENT.md](.codex/AGENT.md) (behavioral rules).

## What this repo is

Ralph is a Node/TypeScript harness that drives a selected coding-agent CLI (Claude Code by default, or Codex) against a target repository in an iterating implementer → reviewer loop, inside an ephemeral Docker container (`ralph-sandbox`). It ships as a pnpm monorepo with two npm packages:

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
ralph-afk --agent codex "<plan-and-prd>" <iterations>
ralph-afk --print-config                          # diagnose: print workspace / docker context / image
```

Bins also accept `--help` / `-h`. `--agent <claude|codex>` overrides `$RALPH_AGENT`; both default to Claude when absent. `--codex-user-config` opts Codex into the mounted `~/.codex/config.toml` and is invalid with Claude; isolated Codex otherwise passes `--ignore-user-config`. `$RALPH_WORKSPACE` overrides cwd as the bind-mounted target; `$RALPH_IMAGE` overrides the default `docker.io/daonhan/ralph-sandbox:latest`; `$RALPH_DOCKER_CONTEXT` is the `docker build` fallback context (default: bundled `@daonhan/ralph-core` dir, whose `templates/` subdirectory ships the `Dockerfile`; a context-root `Dockerfile` is a legacy fallback). Other env knobs: `$RALPH_RESULT_GRACE_MS` (post-result grace timer, default `30000`, `0` disables), `$RALPH_DOCKER_SOCK=0` (disable the docker-socket mount), `$RALPH_DOCKER_SOCK_PATH` (explicit socket path), `$RALPH_MODEL` (trimmed model override for the selected agent; unset/empty uses the Claude CLI default, the Codex user config when enabled, or Ralph's isolated Codex default `gpt-5.6-sol` with high reasoning), `$NO_COLOR` / `$TERM=dumb` (disable ANSI). Bins also accept `--version`/`-V`, `--no-keep-alive`, `--max-retries <N>`, `--detach`, `--log <path>`, `--notify` (see README "Running AFK").

### Building / publishing the sandbox image

```bash
docker build -t docker.io/daonhan/ralph-sandbox:latest -f packages/core/templates/Dockerfile .
```

CI in `.github/workflows/publish-image.yml` builds + pushes a single-arch `linux/amd64` image on `workflow_dispatch`, a `ralph-sandbox-v*` tag (release-please primary; also enriches the GitHub Release with the sha256 digest + SBOM + cosign attestation), or a legacy `image-v*` tag (shim). npm + image releases are automated via release-please — see [RELEASING.md](RELEASING.md).

## Architecture

The core library lives in `packages/core/src/` (plus a `__tests__/` vitest suite). Read the loop spine in order to understand the system:

1. **`main.ts` / `gh-main.ts`** — thin bin entrypoints. Each just calls `runBin` (`run-bin.ts`) with its stage chain + a `takesInputArg` flag. `runBin` parses flags via `cli-help.ts`, resolves `--agent` → `$RALPH_AGENT` → Claude and validates `--codex-user-config`, resolves `workspaceDir` / `ralphDir` / `packageDir`, then calls `runLoop`.
2. **`loop.ts`** (`runLoop`) — drives the iteration. For each iteration, walks the stage chain. **First stage is the gate**: its `result` string is sentinel-checked for `<promise>NO MORE TASKS</promise>` and the loop exits early on hit. Subsequent stages always run after a non-sentinel gate. Calls `ensureImage` once before the loop.
3. **`render.ts`** (`renderTemplate`) — expands the five template tags below before each stage runs. Synchronous, uses host `execSync` for shell tags.
4. **`runner.ts`** (`ensureImage`, `runStage`) — docker plumbing.
   - `ensureImage`: `docker image inspect` → `docker pull` → `docker build` (fallback). Build fallback only runs if pull fails and the resolved Dockerfile exists at `$RALPH_DOCKER_CONTEXT/templates/Dockerfile` (preferred) or `$RALPH_DOCKER_CONTEXT/Dockerfile` (legacy).
   - `runStage`: defaults direct library calls to Claude, selects the adapter requested by `RunStageOptions.agent`, writes the prompt tempfile, appends the adapter-built provider command after the Docker image, and streams provider NDJSON through that adapter's stateful decoder. Decoders normalize provider records into shared render events plus a completion or failure; Docker lifecycle, raw logs, grace handling, and cleanup remain shared.
5. **`agents/`** — the adapter registry and provider-specific command, credential, environment, and decoder contracts. `claude.ts` preserves the legacy `claude --verbose --print --output-format stream-json …` argv; `codex.ts` builds `codex exec --json --ephemeral --dangerously-bypass-approvals-and-sandbox …` and requires a final agent message followed by `turn.completed`.
6. **`stages.ts`** — three named stages (`implementer`, `ghafkImplementer`, `reviewer`), each pairing a template filename with `bypassPermissions` for the Claude adapter. With the default Docker socket mount, the sandbox has root-equivalent access to the host Docker daemon; when the socket is disabled, host writes are limited to the workspace and selected provider's writable credential mount (plus the ephemeral container filesystem).
7. **AFK machinery** — `cli-help.ts` (provider flags plus `--detach` / `--notify` / `--max-retries` / `--no-keep-alive` / `--log` / `--version` / `--print-config`), `retry.ts` (`withRetries`, default 3 + exponential backoff), `keepalive.ts` (OS wake-lock acquire/release), `detach.ts` (fork-and-exit background run), `notify.ts` (OS toast + bell). `loop.ts` wires these in and handles `SIGINT`→exit 130 / `SIGTERM`→exit 143 by aborting the active stage via an `AbortController`. Full runtime model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
| `@spill[?]:<name>=…` | Run a command, write its stdout to `<spill-dir>/<name>`, and substitute the container-relative path `./.ralph-tmp/spill-…/<name>` into the prompt (the agent `Read`s it). The `?` form writes a fallback string on non-zero exit; `<name>` must be a plain filename (no path separators / `..`). Keeps large outputs (HEAD patch in `review.md`, full issue bodies in `ghafk.md`) out of the prompt. Requires `spillHostDir`/`spillRefPath` (supplied per-stage by `runLoop`). |
| `` !?`<cmd>          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |     | <fallback>` `` | Try-shell. `execSync` with stderr suppressed; non-zero exit returns the literal `<fallback>` string. Match order matters: this regex matches before the plain `!` form. Use for cross-platform safety. |
| `` !`<cmd>` ``       | Plain shell. `execSync` with `cwd = workspaceDir`. Failures throw and abort the iteration.                                                                                                                                                                                                                                                                                                                                                                                     |
| `{{ INPUTS }}`       | Replaced with the `inputs` string passed to `runLoop`.                                                                                                                                                                                                                                                                                                                                                                                                                         |

Shell resolution lives in `resolveShell()` in `render.ts`: Linux/macOS → `/bin/bash`. Windows → walks `$PATH` looking for `bash.exe` (Git for Windows or WSL passthrough), falls back to `cmd.exe`. **Templates should prefer `!?` over `!` for any command that might be unavailable on `cmd.exe`** (e.g. `git log` redirects, `gh issue list`).

### Per-iteration scratch dir

Every run writes to `<workspaceDir>/.ralph-tmp/` on the host (gitignored): the rendered prompt as `.run-<pid>-<iter>-<ts>.md` (cleaned in `finally`, may leak on SIGKILL — safe to delete) a per-stage spill dir `spill-<pid>-<iter>-<stageIdx>-<ts>/` holding `@spill` output (also cleaned in `finally`), and the NDJSON stream log as `logs/<ts>-iter<N>-<stageName>.ndjson` (kept; `--detach` adds `logs/detached-<pid>.log`).

### Credential mounts

`runStage` reads `process.env.HOME || USERPROFILE` and mounts only the selected provider's credentials when present:

- Claude: `~/.claude` → `/home/agent/.claude` and `~/.claude.json` → `/home/agent/.claude.json`
- Codex: `~/.codex` → `/home/agent/.codex`, with `CODEX_HOME=/home/agent/.codex`
- Shared when present: `~/.config/gh` → `/home/agent/.config/gh:ro`

`runStage` also injects git env vars (`GIT_CONFIG_COUNT/KEY_0=safe.directory/VALUE_0=*`) so git trusts the bind-mounted workspace, and — **by default** — bind-mounts the host Docker socket (`-v <sock>:/var/run/docker.sock` + a `--group-add` fixup, via `resolveDockerSocketMount`) so Testcontainers inside the sandbox can spawn sibling containers. That grants the sandbox root-equivalent host Docker access; disable with `RALPH_DOCKER_SOCK=0`, or set an explicit path with `RALPH_DOCKER_SOCK_PATH`.

**Same-shell rule:** these paths resolve against the shell that invoked the bin. PowerShell `$HOME` (`C:\Users\<you>`) and WSL `$HOME` (`/home/<you>`) are separate stores — install/login to the selected host CLI and run Ralph from the same environment. Claude supports native Windows or WSL. Codex on Windows is supported only through WSL: install Ralph and Codex, use file-backed Codex credentials, and run both from the same WSL distro. Keep `gh auth login` in that environment too (see README "Windows + WSL: credentials").

### Sandbox image

`packages/core/templates/Dockerfile`. Node 22 + Debian Bookworm Python 3.11 as `python`/`python3` + `python -m venv` + `uv`/`uvx` 0.11.28 + .NET SDK 10 + `gh` + `jq` + `git` + Claude Code CLI + pinned `@openai/codex@0.144.4`. `CMD ["claude"]` preserves direct legacy image use; the runner supplies an explicit provider command. User `agent` (UID 1000, renamed from the base image's `node`). `safe.directory='*'` is globally configured to tolerate bind-mount UID mismatch.

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`. Relative imports in `packages/core/src/` end in `.js` (compiled output extension, required by `moduleResolution: NodeNext`).
- **First stage is always the gate.** If you add stages via `STAGES` and wire them into a chain, place gating stages at index 0. The sentinel string `<promise>NO MORE TASKS</promise>` is hardcoded in `loop.ts`.
- **No build step for `apps/cli`.** Bins are hand-written JS that `import { runAfk } from "@daonhan/ralph-core"`. Don't add TS to `apps/cli` — keep the bin layer flat.
- **Templates ship in the npm tarball.** `packages/core/package.json` `files` includes `templates/` and `Dockerfile`. Adding a new stage means: (1) extend `STAGES` in `stages.ts`, (2) drop a new `*.md` in `packages/core/templates/`, (3) reference it from the chain in `main.ts` / `gh-main.ts`.
- **AFK providers bypass interactive approvals.** Stage `permissionMode` remains `bypassPermissions` for Claude; Codex uses `--dangerously-bypass-approvals-and-sandbox`. The comments in `stages.ts` explain the blast-radius reasoning.

## Files for orientation

- `README.md` — extensive user-facing docs (install paths per OS, first-run setup, troubleshooting). Read for usage/setup questions.
- `RELEASING.md` — single source of truth for releasing all three components (release-please flow, version policy, required secrets, rollback runbook). `docs/PUBLISHING.md` is a stub pointing here.
- `CONTRIBUTING.md` — maintainer/contributor guide (dev loop, tests, adding a stage, releasing). `docs/ARCHITECTURE.md` — runtime internals reference.
- `packages/core/templates/prompt.md` / `ghprompt.md` — agent playbooks. Edit these to change feedback loops or task priority.
- `packages/core/templates/{afk,ghafk,review}.md` — iteration templates that `@include` the playbooks above.

## Behavioral

Apply `.codex/AGENT.md` (think first, simplicity, surgical changes, goal-driven). Make only changes the user asked for; match existing style; prefer smallest correct change; push back on over-engineering; state a brief plan + success criteria for non-trivial work.

## Imported Claude Cowork project instructions

Ralph — Autonomous Coding Agent Loop
Ralph drives Claude Code (default) or Codex against a target repository in an iterating implementer → reviewer pipeline, isolated inside a custom Docker image. The harness ships as two npm packages, with thin bash shims that wire host paths + selected-provider credentials into the CLI.

@daonhan/ralph-core — library: iteration loop, docker runner, template renderer, stage registry. Importable from any Node project.
@daonhan/ralph — CLI: exposes ralph-afk and ralph-ghafk bin entries. Depends on @daonhan/ralph-core.
Two AFK entry points (both installed globally after npm i -g @daonhan/ralph):

ralph-afk — plan/PRD-driven loop. Hand it a plan + PRD string; iterates until the agent emits NO MORE TASKS.
ralph-ghafk — GitHub-issue-driven loop. Pulls open issues with gh issue list and lets the agent pick the next AFK task.
Convenience shims live at apps/cli/scripts/afk.sh and apps/cli/scripts/ghafk.sh — thin wrappers that fall back to npx @daonhan/ralph if not installed.
