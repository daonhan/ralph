# CLAUDE.md

Guidance for AI agents working in this repo. Read this first, then [`CONTEXT.md`](CONTEXT.md) (one-page map), [`README.md`](README.md), [.claude/CLAUDE.md](.claude/CLAUDE.md) (behavioral rules), and [`docs/`](docs/) for the why. [`AGENTS.md`](AGENTS.md) is the Codex twin of this file — keep the two in sync when editing either.

## What this repo is

Ralph is a Node/TypeScript harness that drives a coding-agent CLI (Claude Code by default, or Codex) against a target repository in an iterating implementer → reviewer loop, inside an ephemeral Docker container (`ralph-sandbox`). It ships as a pnpm monorepo with two npm packages:

- `@daonhan/ralph-core` (`packages/core`) — library: loop driver, docker runner, template renderer, stage registry, provider adapters, iteration history. ESM, TS-compiled to `dist/`.
- `@daonhan/ralph` (`apps/cli`) — CLI exposing `ralph-afk` (plan/PRD loop) and `ralph-ghafk` (GitHub-issue loop) bin entries. Hand-written JS bins, no build step. Depends on `@daonhan/ralph-core` via `workspace:^`.

## Commands

All commands run from the repo root unless noted. Node ≥20, pnpm ≥9.

```bash
pnpm install                 # link workspace, hoist devDeps
pnpm -r build                # compile packages/core/dist (tsc -p tsconfig.json)
pnpm -r typecheck            # tsc --noEmit across workspace
pnpm -r test                 # packages/core: vitest run (apps/cli has no tests)
pnpm test                    # root: node --test over scripts/*.test.mjs
pnpm -r clean                # rm packages/core/dist
pnpm publish-all             # pnpm -r publish --access public --no-git-checks
```

Verification = `pnpm -r typecheck` + `pnpm -r test` + root `pnpm test`. A husky pre-commit hook runs `lint-staged` (`prettier --ignore-unknown --write` on staged files) then `pnpm typecheck`. Full contributor guide: [CONTRIBUTING.md](CONTRIBUTING.md).

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
ralph-afk "<plan-and-prd>" <iterations>          # plan/PRD-driven loop (Claude)
ralph-afk --agent codex "<plan-and-prd>" <iterations>
ralph-ghafk <iterations>                          # GitHub-issue-driven loop
ralph-afk --print-config                          # diagnose: workspace / docker context / image / agent / model
```

Bins also accept `--help` / `-h`, `--version` / `-V`, `--no-keep-alive`, `--max-retries <N>`, `--detach`, `--log <path>`, `--notify` (see README "Running AFK").

**Provider selection:** `--agent <claude|codex>` → `$RALPH_AGENT` → `claude`. `--codex-user-config` opts Codex into the mounted host `~/.codex/config.toml`; it is invalid with Claude (error text lives in `CODEX_USER_CONFIG_REQUIRES_CODEX` in `agents/index.ts`). Isolated Codex (the default) passes `--ignore-user-config`.

**Env knobs:** `$RALPH_WORKSPACE` overrides cwd as the bind-mounted target; `$RALPH_IMAGE` overrides `docker.io/daonhan/ralph-sandbox:latest` (`$RALPH_IMAGE_TAG` is a legacy alias); `$RALPH_DOCKER_CONTEXT` is the `docker build` fallback context (default: bundled `@daonhan/ralph-core` dir; `resolveDockerfile` looks for `<ctx>/templates/Dockerfile` first, then `<ctx>/Dockerfile`); `$RALPH_RESULT_GRACE_MS` (post-result grace timer, default `30000`, `0` disables); `$RALPH_DOCKER_SOCK=0` (disable the docker-socket mount); `$RALPH_DOCKER_SOCK_PATH` (explicit socket path); `$RALPH_ISOLATE_NODE_MODULES` (`0` shares the host `node_modules/` with the sandbox, `1` isolates on Linux too; default: container-local volumes everywhere but Linux); `$NO_COLOR` / `$TERM=dumb` (disable ANSI).

**Model resolution (`$RALPH_MODEL`):** Claude: `RALPH_MODEL` → host `~/.claude/settings.json` (`env.ANTHROPIC_MODEL`, else `model`) → `DEFAULT_CLAUDE_MODEL` in `agents/claude.ts`. `--model` is always sent because the sandbox CLI's own default is frozen at image build — omitted only when host settings enable `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`. Codex: `RALPH_MODEL` → user config (with `--codex-user-config`) → `DEFAULT_CODEX_MODEL` / `DEFAULT_CODEX_REASONING_EFFORT` in `agents/codex.ts`. Full table: [docs/ARCHITECTURE.md § Environment variables](docs/ARCHITECTURE.md#environment-variables).

### Building / publishing the sandbox image

```bash
docker build -t docker.io/daonhan/ralph-sandbox:latest -f packages/core/templates/Dockerfile .
```

CI in `.github/workflows/publish-image.yml` builds + pushes a single-arch `linux/amd64` image on `workflow_dispatch`, a `ralph-sandbox-v*` tag (release-please primary; also enriches the GitHub Release with the sha256 digest + SBOM + cosign attestation), or a legacy `image-v*` tag (shim). npm + image releases are automated via release-please — see [RELEASING.md](RELEASING.md).

A project-neutral variant with PostgreSQL 17 + PostGIS lives in `images/pg17/` (not published; build locally and point `RALPH_IMAGE` / `RALPH_DOCKER_CONTEXT` at it — see its README).

## Architecture

The core library lives in `packages/core/src/` (plus a `__tests__/` vitest suite). Read the loop spine in order to understand the system:

1. **`main.ts` / `gh-main.ts`** — thin bin entrypoints. Each just calls `runBin` (`run-bin.ts`) with its stage chain + a `takesInputArg` flag. `runBin` parses flags via `cli-help.ts`, resolves the agent (`--agent` → `$RALPH_AGENT` → Claude) and validates `--codex-user-config`, resolves `workspaceDir` / `ralphDir` / `packageDir` from env vars, then calls `runLoop`.
2. **`loop.ts`** (`runLoop`) — drives the iteration. For each iteration, walks the stage chain. **First stage is the gate**: its `text` is sentinel-checked (`hasSentinel`) for `<promise>NO MORE TASKS</promise>` on a line of its own and the loop exits early on hit; a prose mention only warns on stderr. Later stages run only when the gate stage moved HEAD; otherwise the loop records a `skipped` history entry for each and starts no container. Calls `ensureImage` once before the loop, then opens the history file (image failure must not leave a stray history entry).
3. **`render.ts`** (`renderTemplate`) — expands the six template tags below before each stage runs. Synchronous, uses host `execSync` for shell tags.
4. **`runner.ts`** (`ensureImage`, `runStage`, `streamDocker`) — docker plumbing.
   - `ensureImage`: `docker image inspect` → `docker pull` → `docker build` (fallback). Build fallback only runs if pull fails AND `resolveDockerfile($RALPH_DOCKER_CONTEXT)` exists.
   - `runStage`: writes the rendered prompt to `<workspaceDir>/.ralph-tmp/.run-<pid>-<iter>-<ts>.md`, builds `docker run --rm -i …` with mounts + env, then appends the provider command from the selected adapter (`buildCommand`). Streams provider JSONL from stdout through the adapter's decoder, resolves `{ text, meta }` (completion text + `StageMeta`: cost, turns, tokens, error flags, `graceTimerFired`). Also mounts the container-local `node_modules` volumes `sandbox-volumes.ts` resolves for the workspace, created and root-chowned once per process. Tempfile cleaned in `finally`.
5. **`agents/`** — provider adapter registry. `types.ts` defines `AgentAdapter` (`containerEnv`, `credentialMounts`, `buildCommand`, `createDecoder`) and `StageMeta`. `claude.ts` builds `claude --verbose --print --output-format stream-json --permission-mode <mode> …` and owns Claude model resolution. `codex.ts` builds `codex exec --json --ephemeral --dangerously-bypass-approvals-and-sandbox …` and requires a final agent message followed by `turn.completed`. `index.ts` is the registry + `resolveAgentSelection`.
6. **`stages.ts`** — three named stages (`implementer`, `ghafkImplementer`, `reviewer`), each pairing a template filename with a Claude `permissionMode` (always `bypassPermissions` — AFK requires non-interactive bash/edit approval; Codex gets the equivalent bypass flag from its adapter).
7. **`history.ts`** — harness-owned per-run Markdown log under `<workspaceDir>/.ralph/history/<ts>-<afk|ghafk>[-<branch>].md` (self-gitignored via a `*` `.gitignore` written once). Header on open, one entry per completed stage (duration, HEAD, `StageMeta`), footer with run totals on exit (`no-more-tasks` / `cap` / `failed`), plus a `warning: sandbox-install` suffix when the host check fired. Pure `fs` + tolerant `git` reads, never docker.
8. **`stream-render.ts`** — TTY-gated ANSI styling + `renderEvent` pretty-printer for decoded `AgentRenderEvent`s (assistant text → stdout, tools/diagnostics → stderr). No docker dependency.
9. **`host-check.ts`** — `detectSandboxInstall(workspaceDir)` reports the traces a sandbox install leaves in the bind-mounted tree (a `node_modules/.modules.yaml` store path under `/home/agent/`, a stray `.pnpm-store/`); `loop.ts` calls it at each footer write and warns on stderr. Pure `node:fs`, never throws.
10. **AFK machinery** — `cli-help.ts` (flag parsing), `retry.ts` (`withRetries`, default 3 + exponential backoff), `keepalive.ts` (OS wake-lock acquire/release), `detach.ts` (fork-and-exit background run), `notify.ts` (OS toast + bell). `loop.ts` wires these in and handles `SIGINT`→exit 130 / `SIGTERM`→exit 143 by aborting the active stage via an `AbortController`. Full runtime model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Loop topology

```
ralph-afk   → [STAGES.implementer,        STAGES.reviewer]   inputs = "<plan-and-prd>"
ralph-ghafk → [STAGES.ghafkImplementer,   STAGES.reviewer]   inputs = ""
```

Gate = first stage. Reviewer never gates.

### Template renderer (the part most likely to bite you)

Templates live in `packages/core/templates/`. Six tag forms, expanded in this order (`@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}` → `{{ HISTORY }}`):

| Tag                             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@include:<path>`               | Inline a file via `readFileSync`. Path resolved against the template's dir when relative. **No shell**. Used to inject the agent playbooks (`prompt.md`, `ghprompt.md`) into the iteration templates (`afk.md`, `ghafk.md`).                                                                                                                                                                                                                                                   |
| `` @spill[?]:<name>=`<cmd>` ``  | Run a command, write its stdout to `<spill-dir>/<name>`, and substitute the container-relative path `./.ralph-tmp/spill-…/<name>` into the prompt (the agent `Read`s it). The `?` form writes a fallback string on non-zero exit; `<name>` must be a plain filename (no path separators / `..`). Keeps large outputs (HEAD patch in `review.md`, full issue bodies in `ghafk.md`) out of the prompt. Requires `spillHostDir`/`spillRefPath` (supplied per-stage by `runLoop`). |
| `` !?`<cmd>\|\|\|<fallback>` `` | Try-shell. `execSync` with stderr suppressed; non-zero exit returns the literal `<fallback>` string. Match order matters: this regex matches before the plain `!` form. Use for cross-platform safety.                                                                                                                                                                                                                                                                         |
| `` !`<cmd>` ``                  | Plain shell. `execSync` with `cwd = workspaceDir`. Failures throw and abort the iteration.                                                                                                                                                                                                                                                                                                                                                                                     |
| `{{ INPUTS }}`                  | Replaced with the `inputs` string passed to `runLoop`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `{{ HISTORY }}`                 | Replaced with the last ten `.ralph/history/` stage entries (non-empty only for the implementer stage). Substituted last, alongside `{{ INPUTS }}`; carries prior agent output verbatim, never re-shelled.                                                                                                                                                                                                                                                                      |

Shell resolution lives in `resolveShell()` in `render.ts`: Linux/macOS → `/bin/bash`. Windows → walks `$PATH` looking for `bash.exe` (Git for Windows or WSL passthrough), falls back to `cmd.exe`. **Templates should prefer `!?` over `!` for any command that might be unavailable on `cmd.exe`** (e.g. `git log` redirects, `gh issue list`). Tag command bodies are trusted template content, never user input — see the security invariant comment at the top of `render.ts` and [SECURITY.md § Template authoring](SECURITY.md).

### Per-run files in the target workspace

- `<workspaceDir>/.ralph-tmp/` (gitignored): rendered prompt `.run-<pid>-<iter>-<ts>.md` (cleaned in `finally`, may leak on SIGKILL — safe to delete), per-stage spill dir `spill-<pid>-<iter>-<stageIdx>-<ts>/` (also cleaned), and the kept NDJSON stream log `logs/<ts>-iter<N>-<stageName>.ndjson` (`--detach` adds `logs/detached-<pid>.log`).
- `<workspaceDir>/.ralph/history/` (self-gitignored): one Markdown file per run, written by `history.ts`.

### Credential mounts

`runStage` reads `process.env.HOME || USERPROFILE` (`resolveHostHome` in `agents/shared.ts`, shared with `--print-config`) and mounts only the selected provider's credentials when present:

- Claude: `~/.claude` → `/home/agent/.claude`, `~/.claude.json` → `/home/agent/.claude.json`
- Codex: `~/.codex` → `/mnt/codex-creds:ro` with `CODEX_HOME=/home/agent/.codex`; a setup script copies `auth.json`/`config.toml`/`AGENTS.md` into the container-local `CODEX_HOME` before exec'ing `codex` (a bind-mounted `CODEX_HOME` fails with EPERM on Windows). Codex needs file-backed credentials (`cli_auth_credentials_store = "file"`).
- Shared: `~/.config/gh` → `/home/agent/.config/gh:ro`

`runStage` also injects git env vars (`GIT_CONFIG_COUNT/KEY_0=safe.directory/VALUE_0=*`) so git trusts the bind-mounted workspace, and — **by default** — bind-mounts the host Docker socket (`-v <sock>:/var/run/docker.sock` + a `--group-add` fixup, via `resolveDockerSocketMount`) so Testcontainers inside the sandbox can spawn sibling containers. That grants the sandbox root-equivalent host Docker access; disable with `RALPH_DOCKER_SOCK=0`, or set an explicit path with `RALPH_DOCKER_SOCK_PATH`. Threat model: [SECURITY.md](SECURITY.md).

**Same-shell rule:** these paths resolve against the shell that invoked the bin. PowerShell `$HOME` (`C:\Users\<you>`) and WSL `$HOME` (`/home/<you>`) are separate stores — don't mix. `claude /login`, `codex login`, and `gh auth login` must be run from a shell context that matches your eventual invocation context (or copied across — see README "Windows + WSL: credentials").

### Sandbox image

`packages/core/templates/Dockerfile`. `node:22-bookworm` + Python 3.11 (`python`/`python3`, `venv`) + `uv`/`uvx` + .NET SDK 10 + `gh` + `jq` + `git` + Claude Code CLI + pinned `@openai/codex` (`ARG CODEX_VERSION`). `CMD ["claude"]` preserves direct legacy image use; the runner always supplies an explicit provider command. User `agent` (UID 1000, renamed from base image's `node`). `safe.directory='*'` globally configured to tolerate bind-mount UID mismatch on Windows.

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`. Relative imports in `packages/core/src/` end in `.js` (compiled output extension, required by `moduleResolution: NodeNext`).
- **First stage is always the gate.** If you add stages via `STAGES` and wire them into a chain, place gating stages at index 0. The sentinel string `<promise>NO MORE TASKS</promise>` is hardcoded in `loop.ts` and gates only on a line of its own.
- **No build step for `apps/cli`.** Bins are hand-written JS that `import { runAfk } from "@daonhan/ralph-core"`. Don't add TS to `apps/cli` — keep the bin layer flat.
- **Templates ship in the npm tarball.** `packages/core/package.json` `files` includes `templates/` and `Dockerfile`. Adding a new stage means: (1) extend `STAGES` in `stages.ts`, (2) drop a new `*.md` in `packages/core/templates/`, (3) reference it from the chain in `main.ts` / `gh-main.ts`.
- **Adding a provider** means a new `agents/<name>.ts` implementing `AgentAdapter`, registered in `agents/index.ts` (`ADAPTERS` + `parseAgentName`), plus a Dockerfile install and a decoder test in `__tests__/agent-decoders.test.ts`. See CONTRIBUTING "Adding a coding-agent provider".
- **AFK providers bypass interactive approvals.** Claude stages use `bypassPermissions`; Codex uses `--dangerously-bypass-approvals-and-sandbox`. Comment in `stages.ts` explains the blast-radius reasoning.
- **History is harness-owned.** Only `loop.ts` writes `.ralph/history/`; templates and agents never do.
- **`CLAUDE.md` and `AGENTS.md` mirror each other.** Edit both when changing repo guidance.

## Files for orientation

- `CONTEXT.md` — one-page orientation map (read path, invariants, gotchas). Start here if new.
- `README.md` — extensive user-facing docs (install paths per OS, provider choice, first-run setup, troubleshooting). Read for usage/setup questions.
- `SECURITY.md` — threat model for `bypassPermissions` + docker.sock; template-authoring rules.
- `RELEASING.md` — single source of truth for releasing all three components (release-please flow, version policy, required secrets, rollback runbook). `docs/PUBLISHING.md` is a stub pointing here.
- `CONTRIBUTING.md` — maintainer/contributor guide (dev loop, tests, adding a stage or provider, releasing). `docs/ARCHITECTURE.md` — runtime internals reference incl. env-var table and `docker run` argv shape.
- `docs/prd/` + `docs/plans/` — PRDs and tracer-bullet plans per feature (same basename in both; e.g. `iteration-history.md`). `docs/superpowers/{specs,plans}/` — dated design docs (Codex provider, pg17 sandbox).
- `packages/core/templates/prompt.md` / `ghprompt.md` — agent playbooks. Edit these to change feedback loops or task priority.
- `packages/core/templates/{afk,ghafk,review}.md` — iteration templates that `@include` the playbooks above.
- `images/pg17/` — PostgreSQL 17 sandbox variant (Dockerfile + README).

## Behavioral

Apply `.claude/CLAUDE.md` (think first, simplicity, surgical changes, goal-driven). Make only changes the user asked for; match existing style; prefer smallest correct change; push back on over-engineering; state a brief plan + success criteria for non-trivial work.
