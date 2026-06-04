# Ralph — Autonomous Claude Code Loop

[![@daonhan/ralph](https://img.shields.io/npm/v/@daonhan/ralph?label=%40daonhan%2Fralph)](https://www.npmjs.com/package/@daonhan/ralph)
[![@daonhan/ralph-core](https://img.shields.io/npm/v/@daonhan/ralph-core?label=%40daonhan%2Fralph-core)](https://www.npmjs.com/package/@daonhan/ralph-core)
[![CI](https://github.com/daonhan/ralph/actions/workflows/ci.yml/badge.svg)](https://github.com/daonhan/ralph/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Ralph drives [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) against a target repository in an iterating implementer → reviewer pipeline, isolated inside a custom Docker image. The harness ships as two npm packages, with thin bash shims that wire host paths + credentials into the CLI.

> ⚠️ **Security:** Ralph runs Claude with `--permission-mode bypassPermissions` inside the sandbox and, **by default, bind-mounts the host Docker socket — granting root-equivalent access to the host Docker daemon.** Point it only at repositories, plans, and GitHub issues you trust. Disable the socket mount with `RALPH_DOCKER_SOCK=0`. See **[SECURITY.md](./SECURITY.md)** for the full threat model.

> **New here?** Start with **[QUICKSTART.md](./QUICKSTART.md)** (zero-to-first-loop). Hacking on Ralph itself → **[CONTRIBUTING.md](./CONTRIBUTING.md)**. Internals → **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

- **[`@daonhan/ralph-core`](./packages/core)** — library: iteration loop, docker runner, template renderer, stage registry. Importable from any Node project.
- **[`@daonhan/ralph`](./apps/cli)** — CLI: exposes `ralph-afk` and `ralph-ghafk` bin entries. Depends on `@daonhan/ralph-core`.

Two AFK entry points (both installed globally after `npm i -g @daonhan/ralph`):

- **`ralph-afk`** — plan/PRD-driven loop. Hand it a plan + PRD string; iterates until the agent emits the sentinel `<promise>NO MORE TASKS</promise>`.
- **`ralph-ghafk`** — GitHub-issue-driven loop. Pulls open issues with `gh issue list` and lets the agent pick the next AFK task.

Convenience shims live at [`apps/cli/scripts/afk.sh`](./apps/cli/scripts/afk.sh) and [`apps/cli/scripts/ghafk.sh`](./apps/cli/scripts/ghafk.sh) — thin wrappers that fall back to `npx @daonhan/ralph` if not installed.

Agent playbooks: [`packages/core/templates/prompt.md`](./packages/core/templates/prompt.md) (for `ralph-afk`) and [`packages/core/templates/ghprompt.md`](./packages/core/templates/ghprompt.md) (for `ralph-ghafk`). Reviewer instructions: [`packages/core/templates/review.md`](./packages/core/templates/review.md). All three ship inside `@daonhan/ralph-core`.

---

## Architecture (AFK loops)

```
ralph-afk / ralph-ghafk               (bin entries from @daonhan/ralph, on PATH after `npm i -g`)
   │
   ▼
@daonhan/ralph (CLI, apps/cli)        bin: ralph-afk, ralph-ghafk; scripts: afk.sh, ghafk.sh shims
   │ imports
   ▼
@daonhan/ralph-core (packages/core)
   ├── runAfk / runGhAfk              (env-driven entry: argv → runLoop)
   ├── runLoop                        (drives stage chain per iteration; checks sentinel)
   ├── render                         (renderer: @include / @spill / !? / !`cmd` / {{ INPUTS }})
   ├── stages                         (stage registry: implementer, ghafkImplementer, reviewer)
   └── runner                         (docker run → NDJSON stream → live print → final result)
   │
   ▼
docker run ralph-sandbox claude --verbose --print --output-format stream-json …
```

Each iteration runs the stage chain `[implementer, reviewer]`. The implementer is the "gate": if it emits `<promise>NO MORE TASKS</promise>`, the loop exits before the reviewer runs.

Prompt templates expand five tag forms before each stage runs, in order — `@include:` (inline a file, no shell), `@spill[?]:` (run a command, write its output to a side file the agent `Read`s), `` !?`cmd|||fallback` `` (try-shell), `` !`cmd` `` (host shell), and `{{ INPUTS }}` (the entry CLI's input arg — the plan/PRD string for `ralph-afk`, empty for `ralph-ghafk`). Full semantics under [Change the template syntax](#change-the-template-syntax); the runtime model lives in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Repo layout

```
ralph/
├── package.json                 monorepo root (private, shared devDeps, pnpm scripts)
├── pnpm-workspace.yaml
├── tsconfig.base.json           shared TS compiler options
├── .npmrc                       link-workspace-packages, prefer-workspace-packages
├── .dockerignore                shrinks build context (consumed at repo root)
├── apps/
│   └── cli/                     @daonhan/ralph
│       ├── package.json
│       ├── bin/
│       │   ├── ralph-afk.js
│       │   └── ralph-ghafk.js
│       └── scripts/             optional bash shims (ship in npm tarball)
│           ├── afk.sh
│           └── ghafk.sh
├── packages/
│   └── core/                    @daonhan/ralph-core
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/                 main.ts, gh-main.ts, loop.ts, runner.ts, render.ts, stages.ts, index.ts, cli-help.ts, retry.ts, keepalive.ts, detach.ts, notify.ts + __tests__/
│       └── templates/           afk.md, ghafk.md, review.md, prompt.md, ghprompt.md, CHANGELOG.md, Dockerfile (builds ralph-sandbox image)
└── (playbooks live in packages/core/templates/ alongside the prompt templates)
```

At runtime, the host workspace gets a `.ralph-tmp/` directory containing the per-iteration prompt files and `logs/*.ndjson`. This directory is gitignored.

---

## Prerequisites

- **Docker** — Docker Desktop (Windows/macOS) or Docker Engine (Linux). The orchestrator shells out to `docker build` / `docker run`.
- **Node.js 20+** + **npm 9+** (or `pnpm`/`yarn`). For Windows: native nvm-for-windows, nvm-windows, or directly from nodejs.org; for macOS/Linux: nvm, asdf, or distro package.
- **`gh`** authenticated (only required for `ralph-ghafk`): `gh auth login` once.
- **Claude Code** authentication. See "First-run setup" below.
- **(Windows only, optional but recommended)** `bash.exe` on PATH — comes free with [Git for Windows](https://git-scm.com/download/win). The renderer prefers it over `cmd.exe` because POSIX redirects + utilities (`git log`, `gh issue list`) are smoother. If absent, the renderer falls back to `cmd.exe` and uses the built-in try-shell tag (`!?\`cmd|||fallback\``) so commands that fail return their fallback string cleanly — no broken render.

### Supported shells / OS combinations

| Where you invoke `ralph-afk` | Status | Notes                                                                                                   |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| Linux native (Ubuntu, etc.)  | ✓      | `/bin/bash` used for shell tags. Confirmed via WSL Ubuntu.                                              |
| macOS native                 | ✓      | `/bin/bash` used. Identical to Linux path.                                                              |
| Windows PowerShell / cmd     | ✓      | Renderer probes `bash.exe`; falls back to `cmd.exe`. Use `npm i -g @daonhan/ralph` against native Node. |
| Windows + WSL bash           | ✓      | Install inside WSL with a user-local prefix (`npm config set prefix ~/.npm-global`) to avoid sudo.      |
| Windows + Git Bash           | ✓      | Resolves shell to its own `bash.exe`.                                                                   |

### Windows + WSL: credentials

Credentials live on the **host** at `~/.claude` and `~/.config/gh` and get bind-mounted into the container. The path resolves per the shell that launches `ralph-afk`:

| Launch from              | `$HOME` is                        | Mounted into container                                                                                    |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Windows PowerShell / cmd | `C:\Users\<name>`                 | Yes, if `claude /login` was run inside a WSL/native shell on Windows or via the bootstrap container below |
| WSL bash                 | `/home/<linuxname>`               | Yes — canonical WSL credential store                                                                      |
| Linux / macOS            | `/home/<name>` or `/Users/<name>` | Yes                                                                                                       |

If you already logged in via PowerShell `claude.exe` and want WSL to use those creds too:

```bash
# WSL bash — replace <WINUSER>
mkdir -p ~/.claude
cp -r /mnt/c/Users/<WINUSER>/.claude/. ~/.claude/
cp /mnt/c/Users/<WINUSER>/.claude.json ~/.claude.json 2>/dev/null || true
mkdir -p ~/.config/gh
cp -r "/mnt/c/Users/<WINUSER>/AppData/Roaming/GitHub CLI/." ~/.config/gh/ 2>/dev/null || true
```

- Launching from PowerShell after a global install — just call the bin directly:
  ```powershell
  ralph-afk "<plan-and-prd>" 3
  ```
- Or from inside WSL bash:
  ```bash
  ralph-afk "<plan-and-prd>" 3
  ```

---

## First-run setup

### 1. Get the image

The orchestrator resolves the image in three steps on each run:

1. `docker image inspect $RALPH_IMAGE` — short-circuits if the image is already on the host (a floating tag like `:latest` is re-pulled anyway, so a republished sandbox isn't pinned to a stale local copy).
2. Otherwise `docker pull $RALPH_IMAGE` — defaults to `docker.io/daonhan/ralph-sandbox:latest`.
3. If pull fails AND `$RALPH_DOCKER_CONTEXT/Dockerfile` exists, falls back to `docker build -t $RALPH_IMAGE $RALPH_DOCKER_CONTEXT`.

For most users step 2 is enough — no local Dockerfile needed. To prime the cache:

```bash
docker pull docker.io/daonhan/ralph-sandbox:latest
```

Build locally (offline, custom changes):

```bash
cd ralph
docker build -t docker.io/daonhan/ralph-sandbox:latest -f packages/core/templates/Dockerfile .
```

The image bundles: Node 22, .NET SDK 10, `gh`, `jq`, `git`, the Claude Code CLI.

#### Publishing a new image (maintainers)

The repo ships a GitHub Actions workflow at [`.github/workflows/publish-image.yml`](./.github/workflows/publish-image.yml) that builds + pushes `linux/amd64` images to Docker Hub.

Triggers:

- **`workflow_dispatch`** — manual run from the Actions tab; pick the tag and whether to also push `:latest`.
- **Git tag `ralph-sandbox-v*`** — pushing a tag like `ralph-sandbox-v0.1.3` (cut by release-please) publishes `:v0.1.3` plus `:latest`, and enriches the matching GitHub Release with the image digest, an SBOM, and a keyless cosign attestation.
- **Git tag `image-v*`** — legacy compatibility shim; publishes `:vX.Y.Z` plus `:latest` but does **not** enrich a GitHub Release. Slated for removal after one release cycle through the new path.

Required repo secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (a Docker Hub access token with `Read & Write` scope on the `daonhan/ralph-sandbox` repository).

### 2. Log in to the image (one-off)

The image is stateless. Credentials live on the **host** at `~/.claude` and `~/.config/gh`. The orchestrator bind-mounts those paths into every container.

> **Same-shell rule.** `ralph-afk` / `ralph-ghafk` read `$HOME` of the shell that launched them. Auth from the same shell context you intend to run the bins in. PowerShell host (`C:\Users\<you>\.config\gh\`) and WSL host (`\\wsl$\Ubuntu\home\<you>\.config\gh\`) are separate stores — don't mix.

#### Linux / macOS / WSL bash

```bash
mkdir -p ~/.claude ~/.config/gh
touch ~/.claude.json

docker run -it --rm \
  -v "$HOME/.claude:/home/agent/.claude" \
  -v "$HOME/.claude.json:/home/agent/.claude.json" \
  -v "$HOME/.config/gh:/home/agent/.config/gh" \
  docker.io/daonhan/ralph-sandbox:latest bash
```

#### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude","$HOME\.config\gh" | Out-Null
if (-not (Test-Path "$HOME\.claude.json")) { New-Item -ItemType File "$HOME\.claude.json" | Out-Null }

docker run -it --rm `
  -v "${HOME}\.claude:/home/agent/.claude" `
  -v "${HOME}\.claude.json:/home/agent/.claude.json" `
  -v "${HOME}\.config\gh:/home/agent/.config/gh" `
  docker.io/daonhan/ralph-sandbox:latest bash
```

#### Inside the container

```bash
claude /login         # browser flow
gh auth login         # only needed for ralph-ghafk
```

For `gh auth login` pick: `GitHub.com` → `HTTPS` → `Y` (authenticate Git) → `Login with web browser`. Copy the one-time code, open `https://github.com/login/device` on the host browser, paste, approve. Container prints `✓ Authentication complete`.

```bash
gh auth status        # verify
exit
```

#### Verify back on the host

Linux / macOS / WSL:

```bash
ls -la ~/.claude/.credentials.json ~/.claude.json
cat ~/.config/gh/hosts.yml | head
```

PowerShell:

```powershell
Get-ChildItem "$HOME\.claude\.credentials.json","$HOME\.claude.json"
Get-Content "$HOME\.config\gh\hosts.yml"
```

Expected `hosts.yml` content: a `github.com:` block with `user:` and `oauth_token:` keys.

#### Re-login / token expired

Re-run `claude /login` (or `gh auth login`) inside the container. Bind-mounted files are overwritten.

---

## `ralph-afk` — plan/PRD loop

### Usage

```bash
ralph-afk "<plan-and-prd>" <iterations>
```

(Or via the shim: `./node_modules/@daonhan/ralph/scripts/afk.sh "<plan-and-prd>" <iterations>`.)

Also supports:

- `ralph-afk --help` (or `-h`) — usage, flags, env vars.
- `ralph-afk --version` (or `-V`) — print bin + core version and exit.
- `ralph-afk --print-config` — print resolved workspace / docker context / image / docker-socket status and exit. Use for diagnostics before launching a real loop.

- `<plan-and-prd>` — a single string forwarded verbatim as `{{ INPUTS }}` in the template. Conventionally paths to plan and PRD files.
- `<iterations>` — max loop iterations. Exits early if implementer emits the sentinel.

### Example

```bash
ralph-afk "./docs/plans/inventory.md ./docs/prd/PRD-Inventory.md" 10
```

From PowerShell on Windows:

```powershell
wsl bash -c "ralph-afk './docs/plans/inventory.md ./docs/prd/PRD-Inventory.md' 10"
```

### What happens per iteration

1. **Render template** `packages/core/templates/afk.md`:
   - `` !?`git log -n 5 …|||No commits found` `` → recent commits (try-shell)
   - `{{ INPUTS }}` → the plan/PRD string
   - `@include:prompt.md` → the agent playbook (inlined by the Node renderer, no shell)
2. **Implementer stage** (gate) — `docker run ralph-sandbox claude …` with the rendered prompt streamed in via a tempfile under `.ralph-tmp/` (avoids Windows 32 KB argv limit). Assistant text is rendered live; final `result` is captured.
3. **Sentinel check** — if `result` contains `<promise>NO MORE TASKS</promise>`, print `Ralph complete after <N> iterations.` and exit 0.
4. **Reviewer stage** — runs `packages/core/templates/review.md`. Reads the HEAD commit (the `git show --stat` summary inline, the full patch spilled to `.ralph-tmp/spill-…/head.diff` via `@spill?:head.diff`), then either commits a `fix(review): …` patch or emits `<review>OK</review>` / `<review>SKIP</review>` and stops. Single pass; never amends the implementer's commit.

---

## `ralph-ghafk` — GitHub-issue loop

### Usage

```bash
ralph-ghafk <iterations>
```

No plan/PRD arg — context comes from open GitHub issues.

### What happens per iteration

1. **Render template** `packages/core/templates/ghafk.md`:
   - `` !?`git log -n 5 …|||No commits found` `` → recent commits (try-shell)
   - `` !?`gh issue list --state open --limit 50 --json number,title,labels|||[]` `` → a lean inline index of open issues (number / title / labels)
   - `` @spill?:issues.json=`gh issue list … --json number,title,body,labels,comments` `` → full issue bodies + comments written to `.ralph-tmp/spill-…/issues.json`; the agent `Read`s that file before picking a task
   - `@include:ghprompt.md` → the agent playbook (inlined by the Node renderer, no shell)
2. **ghafk-implementer stage** (gate) — agent picks one open AFK issue, implements it, commits, closes / comments on the issue.
3. **Sentinel check** — same as `ralph-afk`.
4. **Reviewer stage** — same as `ralph-afk`.

---

## Running AFK

Both bins are designed to chew through long runs unattended. Five AFK flags wire that up:

| Flag                | Default                                                 | What it does                                                             |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `--no-keep-alive`   | off (wake-lock acquired)                                | Skip the OS wake-lock for the loop's lifetime.                           |
| `--max-retries <N>` | `3`                                                     | Per-stage retry budget on transient failures. `0` restores fail-fast.    |
| `--detach`          | off                                                     | Fork the loop into a background process, print pid + log path, and exit. |
| `--log <path>`      | `<workspace>/.ralph-tmp/logs/detached-<parent-pid>.log` | Override the detached log target. Only meaningful with `--detach`.       |
| `--notify`          | off                                                     | OS toast + terminal bell on loop completion or unrecoverable failure.    |

Canonical overnight recipe:

```bash
ralph-afk --detach --notify "<plan-and-prd>" 50
```

This forks into the background, holds an OS wake-lock so the host doesn't sleep, retries transient stage failures up to 3× with exponential backoff (`5s / 30s / 2m`), and raises a toast + bell when the run finishes (sentinel hit or iteration cap reached) or fails (signal, uncaught exception). Tail the log from any shell:

```bash
tail -f <workspace>/.ralph-tmp/logs/detached-*.log
```

Full per-OS notes (wake-lock mechanism, BurntToast install, WSL2 caveat, etc.) live in [`docs/keep-alive.md`](./docs/keep-alive.md).

---

## Consuming the package in another repo

### Global install (recommended — run from anywhere)

```bash
npm i -g @daonhan/ralph
```

After install, both bins are on your `$PATH`:

```bash
cd /path/to/some/workspace
ralph-afk "<plan-and-prd>" 5
ralph-ghafk 5
```

The bundled Dockerfile (shipped inside `@daonhan/ralph-core`) is the default `RALPH_DOCKER_CONTEXT`, so the `docker build` fallback works even when you invoke from a workspace that has no `Dockerfile` of its own.

### Per-repo install

```bash
# in your workspace repo
npm i -D @daonhan/ralph         # or: pnpm add -D @daonhan/ralph
./node_modules/.bin/ralph-afk "<plan-and-prd>" 5
```

### Bootstrap on demand (no install)

```bash
npx -y @daonhan/ralph ralph-afk "<plan-and-prd>" 5
```

### Environment variables

| Variable                 | Default                                  | Purpose                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALPH_WORKSPACE`        | `process.cwd()`                          | Host path bind-mounted at `/home/agent/workspace`. Also where `.ralph-tmp/` is written.                                                                                                                                                                                                        |
| `RALPH_DOCKER_CONTEXT`   | bundled `@daonhan/ralph-core` dir        | Build context for the `docker build` fallback. Only consulted if `docker pull` fails. Must contain `Dockerfile`. Defaults to the npm-installed core dir, which ships `Dockerfile`.                                                                                                             |
| `RALPH_IMAGE`            | `docker.io/daonhan/ralph-sandbox:latest` | Full image reference. `ensureImage` does `inspect` → `pull` → `build` (fallback).                                                                                                                                                                                                              |
| `RALPH_IMAGE_TAG`        | _(legacy)_                               | Deprecated alias for `RALPH_IMAGE`. Honored if `RALPH_IMAGE` unset.                                                                                                                                                                                                                            |
| `RALPH_RESULT_GRACE_MS`  | `30000`                                  | Milliseconds to wait after the final NDJSON `result` event before force-killing a docker child that fails to exit on its own. `0` disables the timer (original wait-forever behavior). Invalid values (non-finite, negative) fall back to the default.                                         |
| `RALPH_DOCKER_SOCK`      | _(on if a socket is found)_              | Set to `0` to disable bind-mounting the host Docker socket into the sandbox. Mounted by default so Testcontainers inside the container can spawn sibling containers — this grants the sandbox **root-equivalent access to the host Docker daemon**. Disable when running untrusted prompts.    |
| `RALPH_DOCKER_SOCK_PATH` | _(auto-detected)_                        | Explicit host `docker.sock` path. Auto-detection (when unset) tries `DOCKER_HOST` (`unix://` only), then `/var/run/docker.sock`, Docker Desktop, Colima, Rancher Desktop, and rootless Docker/Podman socket locations.                                                                         |
| `RALPH_MODEL`            | _(unset → sandbox CLI default)_          | Pins the Claude model used inside the sandbox. When non-empty, `--model <value>` is passed through to the in-container `claude` CLI for every stage. Empty/whitespace = unset. Pass-through: the `claude` CLI owns validation (any spec it accepts — `opus`, `sonnet`, full model id — works). |
| `DOCKER_HOST`            | _(unset)_                                | A `unix:///…` value is parsed for the docker-socket bind-mount; `tcp://` / `npipe://` / `ssh://` are not bind-mountable.                                                                                                                                                                       |
| `XDG_RUNTIME_DIR`        | _(unset)_                                | Searched for rootless Docker/Podman sockets during auto-detection.                                                                                                                                                                                                                             |
| `NO_COLOR` / `TERM=dumb` | _(unset)_                                | Disable ANSI color in Ralph's own output. Color is also auto-disabled when stdout/stderr is not a TTY, so piping to a file stays clean.                                                                                                                                                        |

---

## Local development (this monorepo)

Full contributor guide — dev loop, tests, adding a stage, releasing — lives in **[CONTRIBUTING.md](./CONTRIBUTING.md)**. The essentials:

```bash
pnpm install                          # links workspace, hoists devDeps
pnpm -r build                         # compiles packages/core/dist
pnpm -r typecheck                     # no-emit type check
pnpm -r test                          # packages/core runs `vitest run` (apps/cli has no tests)
pnpm test                             # root: `node --test` over scripts/*.test.mjs
```

A husky pre-commit hook runs `lint-staged` (`prettier --ignore-unknown --write` on staged files) then `pnpm typecheck` on every commit.

### Build artifacts

- `packages/core/dist/` — compiled `.js` + `.d.ts`. Required for both `pnpm pack` and `pnpm publish`.
- `apps/cli` has no build step — bin shims are hand-written JS.

### Pack tarballs (smoke-test before publish)

```bash
(cd packages/core && pnpm pack --pack-destination /tmp)
(cd apps/cli      && pnpm pack --pack-destination /tmp)

# Install both in a throwaway repo to verify the published artifacts work
mkdir /tmp/ralph-test && cd /tmp/ralph-test
npm init -y
npm i -D /tmp/daonhan-ralph-core-*.tgz /tmp/daonhan-ralph-*.tgz
./node_modules/.bin/ralph-afk           # → prints usage
```

### Global install from local checkout (dev shortcut)

`pnpm link --global` is brittle inside this workspace (pnpm 9 rewrites the dependent's manifest). Use the pack-then-install path instead:

```bash
pnpm -r build
(cd packages/core && pnpm pack --pack-destination /tmp/ralph-packs)
(cd apps/cli      && pnpm pack --pack-destination /tmp/ralph-packs)
npm i -g /tmp/ralph-packs/daonhan-ralph-core-*.tgz \
         /tmp/ralph-packs/daonhan-ralph-*.tgz
ralph-afk          # → Usage: ralph-afk <plan-and-prd> <iterations>
```

Re-run after each source change. To uninstall: `npm uninstall -g @daonhan/ralph @daonhan/ralph-core`.

### Publish

Publishing is **automated** — you don't run `pnpm publish` by hand. Land work on `main` with [Conventional Commits](./RELEASING.md#3-conventional-commit-guide); [release-please](./.github/workflows/release-please.yml) opens one Release PR per component, and **merging that PR** cuts the component tag (`ralph-core-v*` / `ralph-v*` / `ralph-sandbox-v*`) that triggers [`publish-npm.yml`](./.github/workflows/publish-npm.yml) / [`publish-image.yml`](./.github/workflows/publish-image.yml). See **[RELEASING.md](./RELEASING.md)** for the full flow, required secrets, version policy, and rollback runbook.

Escape hatch (only if the pipeline is unavailable):

```bash
pnpm -r publish --access public   # topological order; workspace:^ rewritten to semver
```

### Use a local checkout in another repo (no publish)

Use the pack-then-install path above. It exposes `ralph-afk` / `ralph-ghafk` globally; no per-workspace step needed.

---

## Customizing the pipeline

### Add a stage

1. Add an entry to `STAGES` in `packages/core/src/stages.ts`:
   ```ts
   linter: { name: "linter", template: "lint.md", permissionMode: "bypassPermissions" } satisfies Stage,
   ```
2. Create `packages/core/templates/lint.md` using the same `` !`cmd` `` + `{{ INPUTS }}` syntax.
3. Wire it into the chain in `main.ts` / `gh-main.ts`:
   ```ts
   stages: [STAGES.implementer, STAGES.linter, STAGES.reviewer],
   ```
4. `pnpm -r build` and republish.

Only the first stage is the gate (sentinel-checked). Subsequent stages always run after a non-sentinel gate result. Sandbox stages always use `permissionMode: "bypassPermissions"` — AFK runs non-interactively, so bash/edit approval must be automatic; the blast radius is bounded to the workspace mount and is git-recoverable.

### Change the template syntax

Renderer is in `packages/core/src/render.ts`. Tags supported today:

- `` !`<shell cmd>` `` — executed via `bash` (Linux/macOS/WSL/Git Bash) or `cmd.exe` (Windows native fallback) with `cwd = workspaceDir`. stdout (trailing newline trimmed) replaces the tag. Failures throw and abort the iteration.
- `` !?`<shell cmd>|||<fallback>` `` — try-shell. Same as `!` but stderr is suppressed and a non-zero exit returns the literal fallback string. Use this for cross-platform safety — avoids depending on shell-specific `2>/dev/null || echo "…"` idioms.
- `` @spill[?]:<name>=`<shell cmd>[|||<fallback>]` `` — run `<cmd>` and write its **stdout to a file** `<name>` in the per-stage spill dir (`.ralph-tmp/spill-…/`), substituting the container-relative path `./.ralph-tmp/spill-…/<name>` into the prompt for the agent to `Read`. The `?` form suppresses stderr and writes `<fallback>` on non-zero exit; `<name>` must be a plain filename (no path separators, no `..`). Use for large outputs that would bloat the prompt — `review.md` spills the full HEAD patch, `ghafk.md` the full issue bodies.
- `@include:<rel-or-abs-path>` — inline a file (via Node `readFileSync`). Path resolved against the template's own directory when relative. No shell. Use this for bundled playbooks, not for live shell output.
- `{{ INPUTS }}` — replaced with the `inputs` field passed into `runLoop`.

Tags expand in a fixed order: `@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}`.

On Windows, the renderer prefers `bash.exe` (Git for Windows / WSL passthrough) over `cmd.exe`. The `!?` tag makes commands tolerant either way.

### Override the image

Set `RALPH_IMAGE=registry.example.com/my-image:tag` before invoking the shim, or edit the default in `packages/core/src/runner.ts`. The runner does `inspect` → `pull` → `build` against whatever ref is set; legacy `RALPH_IMAGE_TAG` still works for backward compatibility.

### Change feedback loops or task priority

The agent playbooks are self-contained: `packages/core/templates/prompt.md` (plan/PRD source + progress recording, for `ralph-afk`) and `ghprompt.md` (issue triage + close/comment, for `ralph-ghafk`). Each carries its own task-priority ladder, feedback loops, commit rules, and final rules. `afk.md` / `ghafk.md` each `@include` their respective playbook. Edit the playbook for a loop to change its task priority or feedback loops.

---

## Stopping a run

- **Natural stop:** implementer emits `<promise>NO MORE TASKS</promise>`.
- **Manual stop:** `Ctrl+C`. `runLoop` installs `SIGINT` / `SIGTERM` handlers that abort the active stage (via `AbortController`, killing the docker child), release the OS wake-lock, fire the `--notify` toast if enabled, and exit `130` (SIGINT) / `143` (SIGTERM). Tempfiles under `.ralph-tmp/.run-*.md` and the per-stage `spill-*/` dir are removed by the `finally` block in `runner.ts`; a hard `SIGKILL` may leave them — safe to delete, gitignored.

---

## Troubleshooting

- **`Cannot find module '@daonhan/ralph-core'`** — `@daonhan/ralph` was installed but its dep didn't resolve. Re-run `npm install` (or `pnpm install`) in the workspace, or use `npx -y @daonhan/ralph` to let npx fetch a clean copy.
- **`@esbuild/win32-x64 package is present but this platform needs @esbuild/linux-x64`** — `node_modules/` installed from the wrong OS. Delete `node_modules/` + lockfile and reinstall under WSL.
- **`Not logged in · Please run /login`** — Claude credentials missing inside the container. Run the interactive `docker run … claude /login` step from "First-run setup".
- **`gh issue list` fails with `not a git repository`** — the workspace has no `.git`. The `ghafk.md` template uses `|| echo "[]"` fallback so the iteration still proceeds, but `gh` cannot detect the target repo. Initialize the repo, or push first.
- **`MSB3248` during `dotnet build` / `dotnet test`** — virtiofs/9p quirk on Windows-mounted source. The agent retries automatically per the recipe in `packages/core/templates/prompt.md`; manual repro:
  ```bash
  dotnet test <path-to-test-csproj> \
    -m:1 \
    /p:UseSharedCompilation=false \
    /p:BuildInParallel=false \
    /p:BaseIntermediateOutputPath=/tmp/ralph-obj/<name>/ \
    /p:BaseOutputPath=/tmp/ralph-bin/<name>/
  ```
- **`docker run` exit 1 with no claude output** — image stale. Force refresh:
  ```bash
  docker rmi docker.io/daonhan/ralph-sandbox:latest
  docker pull docker.io/daonhan/ralph-sandbox:latest
  ```
- **`docker pull failed … and no Dockerfile at …`** — the default image ref isn't reachable (offline, registry down, or you set a custom `$RALPH_IMAGE` that doesn't exist) AND no Dockerfile is at `$RALPH_DOCKER_CONTEXT`. Fix one of: connectivity, `RALPH_IMAGE`, or place a Dockerfile at `$RALPH_DOCKER_CONTEXT`.
- **`pull access denied … repository does not exist`** — `$RALPH_IMAGE` points at a private repo or a typo. Either `docker login`, switch to a public image, or unset `RALPH_IMAGE` to use the default.
- **Loop hangs after a stage's final assistant message (no next iteration, no error)** — the claude CLI inside the sandbox emitted its final NDJSON `result` event but failed to exit. On `@daonhan/ralph-core ≥ 0.6.1` the runner self-recovers within `RALPH_RESULT_GRACE_MS` (default 30000ms) — bump or disable via env var. On `@daonhan/ralph-core ≤ 0.6.0` there is no timer; recover manually from a second shell:
  ```bash
  docker ps --filter ancestor=docker.io/daonhan/ralph-sandbox:latest
  docker kill <container-id>
  ```
  The sandbox runs with `--rm` so the container is removed; ralph rejects the current stage with `docker run exited with <code>` and aborts that iteration. Work already committed in prior iterations is preserved.

---

## Files in this folder

| File / dir                                                                       | Purpose                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/cli/scripts/afk.sh`](./apps/cli/scripts/afk.sh)                           | Optional shim — plan/PRD loop. Falls back to `npx @daonhan/ralph ralph-afk`. Shipped in the npm tarball.                                                                     |
| [`apps/cli/scripts/ghafk.sh`](./apps/cli/scripts/ghafk.sh)                       | Optional shim — GitHub-issue loop. Calls `ralph-ghafk`.                                                                                                                      |
| [`packages/core/templates/prompt.md`](./packages/core/templates/prompt.md)       | Agent playbook for `ralph-afk`. Shipped in core tarball.                                                                                                                     |
| [`packages/core/templates/ghprompt.md`](./packages/core/templates/ghprompt.md)   | Agent playbook for `ralph-ghafk`. Shipped in core tarball.                                                                                                                   |
| [`packages/core/templates/Dockerfile`](./packages/core/templates/Dockerfile)     | Builds `ralph-sandbox` image: Node 22 + .NET SDK 10 + `gh` + `claude`. Shipped in `@daonhan/ralph-core` tarball.                                                             |
| [`.dockerignore`](./.dockerignore)                                               | Shrinks build context (consumed at repo root for CI builds).                                                                                                                 |
| [`package.json`](./package.json)                                                 | Monorepo root (private). Shared devDeps + pnpm workspace scripts.                                                                                                            |
| [`pnpm-workspace.yaml`](./pnpm-workspace.yaml)                                   | Declares `apps/*` and `packages/*` as workspace members.                                                                                                                     |
| [`tsconfig.base.json`](./tsconfig.base.json)                                     | Shared TS compiler options inherited by every package.                                                                                                                       |
| [`apps/cli/`](./apps/cli)                                                        | `@daonhan/ralph` — CLI bin entries (`ralph-afk`, `ralph-ghafk`).                                                                                                             |
| [`packages/core/src/main.ts`](./packages/core/src/main.ts)                       | Exports `runAfk(argv)`.                                                                                                                                                      |
| [`packages/core/src/gh-main.ts`](./packages/core/src/gh-main.ts)                 | Exports `runGhAfk(argv)`.                                                                                                                                                    |
| [`packages/core/src/loop.ts`](./packages/core/src/loop.ts)                       | Iteration driver. Runs stage chain; first stage is the gate.                                                                                                                 |
| [`packages/core/src/render.ts`](./packages/core/src/render.ts)                   | Template renderer (`` !`cmd` `` + `{{ INPUTS }}`).                                                                                                                           |
| [`packages/core/src/runner.ts`](./packages/core/src/runner.ts)                   | `docker run` wrapper + NDJSON stream + credential mounts. Image lookup: inspect → pull → build. Reads `RALPH_IMAGE`.                                                         |
| [`.github/workflows/publish-image.yml`](./.github/workflows/publish-image.yml)   | CI: build + push `linux/amd64` `ralph-sandbox` to Docker Hub on `workflow_dispatch`, `ralph-sandbox-v*` tag (release-please primary), or legacy `image-v*` tag.              |
| [`.github/workflows/publish-npm.yml`](./.github/workflows/publish-npm.yml)       | CI: publish `@daonhan/ralph-core` / `@daonhan/ralph` to npm on `ralph-core-v*` / `ralph-v*` tags; enriches the GitHub Release with the `.tgz`, SBOM, and cosign attestation. |
| [`.github/workflows/release-please.yml`](./.github/workflows/release-please.yml) | CI: on push to `main`, opens a per-component Release PR; merging it cuts the tag that triggers the publish workflows.                                                        |
| [`RELEASING.md`](./RELEASING.md)                                                 | Single source of truth for releasing all three components (npm packages + image): release-please flow, version policy, secrets, rollback runbook.                            |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                           | Maintainer / contributor guide: dev loop, tests, adding a stage, release pipeline.                                                                                           |
| [`QUICKSTART.md`](./QUICKSTART.md)                                               | Zero-to-first-loop getting-started guide for new users.                                                                                                                      |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)                                 | Internals / runtime data-flow reference for library extenders and core contributors.                                                                                         |
| [`packages/core/src/cli-help.ts`](./packages/core/src/cli-help.ts)               | Flag parsing (`parseFlags`); `--help` / `--version` / `--print-config` output.                                                                                               |
| [`packages/core/src/retry.ts`](./packages/core/src/retry.ts)                     | `withRetries` — per-stage retry with exponential backoff (default 3).                                                                                                        |
| [`packages/core/src/keepalive.ts`](./packages/core/src/keepalive.ts)             | OS wake-lock acquire/release for the loop's lifetime (`--no-keep-alive` to skip).                                                                                            |
| [`packages/core/src/detach.ts`](./packages/core/src/detach.ts)                   | `--detach` fork-and-exit into a background process.                                                                                                                          |
| [`packages/core/src/notify.ts`](./packages/core/src/notify.ts)                   | `--notify` OS toast + terminal bell on loop terminal events.                                                                                                                 |
| [`packages/core/src/stages.ts`](./packages/core/src/stages.ts)                   | Stage registry — `implementer`, `ghafkImplementer`, `reviewer`.                                                                                                              |
| [`packages/core/src/index.ts`](./packages/core/src/index.ts)                     | Barrel re-export — `runAfk`, `runGhAfk`, `runLoop`, `STAGES`, `renderTemplate`, …                                                                                            |
| [`packages/core/templates/afk.md`](./packages/core/templates/afk.md)             | `ralph-afk` prompt template.                                                                                                                                                 |
| [`packages/core/templates/ghafk.md`](./packages/core/templates/ghafk.md)         | `ralph-ghafk` prompt template.                                                                                                                                               |
| [`packages/core/templates/review.md`](./packages/core/templates/review.md)       | Reviewer prompt template.                                                                                                                                                    |

---

## License

[MIT](./LICENSE) (c) Paul Nguyen.
