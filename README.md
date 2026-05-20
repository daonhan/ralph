# Ralph — Autonomous Claude Code Loop

Ralph drives [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) against a target repository in an iterating implementer → reviewer pipeline, isolated inside a custom Docker image. The harness ships as two npm packages, with thin bash shims that wire host paths + credentials into the CLI.

- **[`@daonhan/ralph-core`](./packages/core)** — library: iteration loop, docker runner, template renderer, stage registry. Importable from any Node project.
- **[`@daonhan/ralph`](./apps/cli)** — CLI: exposes `ralph-afk` and `ralph-ghafk` bin entries. Depends on `@daonhan/ralph-core`.

Two AFK entry points:

- **`afk.sh`** — plan/PRD-driven loop. Hand it a plan + PRD string; iterates until the agent emits `NO MORE TASKS`.
- **`ghafk.sh`** — GitHub-issue-driven loop. Pulls open issues with `gh issue list` and lets the agent pick the next AFK task.

Agent playbooks: [`prompt.md`](./prompt.md) (for `afk`) and [`ghprompt.md`](./ghprompt.md) (for `ghafk`). Reviewer instructions: [`packages/core/templates/review.md`](./packages/core/templates/review.md).

---

## Architecture (AFK loops)

```
afk.sh / ghafk.sh                    (shell shim — sets RALPH_WORKSPACE/RALPH_DOCKER_CONTEXT, execs CLI)
   │
   ▼
@daonhan/ralph (CLI, apps/cli)        bin: ralph-afk, ralph-ghafk
   │ imports
   ▼
@daonhan/ralph-core (packages/core)
   ├── runAfk / runGhAfk              (env-driven entry: argv → runLoop)
   ├── runLoop                        (drives stage chain per iteration; checks sentinel)
   ├── render                         (template renderer: !`cmd` + {{ INPUTS }})
   ├── stages                         (stage registry: implementer, ghafkImplementer, reviewer)
   └── runner                         (docker run → NDJSON stream → live print → final result)
   │
   ▼
docker run ralph-sandbox claude --verbose --print --output-format stream-json …
```

Each iteration runs the stage chain `[implementer, reviewer]`. The implementer is the "gate": if it emits `<promise>NO MORE TASKS</promise>`, the loop exits before the reviewer runs.

Prompt templates use two expansion forms:

- `` !`<shell cmd>` `` — executed on the host before each iteration; output replaces the tag.
- `{{ INPUTS }}` — replaced with the entry script's input arg (plan/PRD string for `afk.sh`; empty for `ghafk.sh`).

---

## Repo layout

```
ralph/
├── package.json                 monorepo root (private, shared devDeps, pnpm scripts)
├── pnpm-workspace.yaml
├── tsconfig.base.json           shared TS compiler options
├── .npmrc                       link-workspace-packages, prefer-workspace-packages
├── apps/
│   └── cli/                     @daonhan/ralph
│       ├── package.json
│       └── bin/
│           ├── ralph-afk.js
│           └── ralph-ghafk.js
├── packages/
│   └── core/                    @daonhan/ralph-core
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/                 main.ts, gh-main.ts, loop.ts, runner.ts, render.ts, stages.ts, index.ts
│       └── templates/           afk.md, ghafk.md, review.md
├── Dockerfile                   builds ralph-sandbox image (Node + .NET + gh + claude)
├── prompt.md                    agent playbook for afk
├── ghprompt.md                  agent playbook for ghafk
├── afk.sh                       shim for plan/PRD loop
└── ghafk.sh                     shim for GitHub-issue loop
```

At runtime, the host workspace gets a `.ralph-tmp/` directory containing the per-iteration prompt files and `logs/*.ndjson`. This directory is gitignored.

---

## Prerequisites

- **WSL / Bash** on Windows. PowerShell cannot run the shims; call them through `wsl bash …`.
- **Docker** (Docker Desktop with WSL2 backend, or Docker Engine in WSL). The orchestrator shells out to `docker build` / `docker run`.
- **Node.js 20+** on the host (Linux side under WSL).
- **pnpm 9+** (for monorepo development). End users consuming the published package can use `npm`, `pnpm`, or `yarn`.
- **`gh`** authenticated on the host (only `ghafk.sh`): `gh auth login` once.
- **Claude Code** authentication. See "First-run setup" below.

### Windows + WSL: which `~` does Ralph use?

The shims execute under WSL, so `runner.ts` resolves `$HOME` to the **WSL Linux home** (`/home/<linuxname>`), not the Windows profile (`C:\Users\<name>`).

| Where you typed it | `~` resolves to | Used by |
| --- | --- | --- |
| PowerShell | `C:\Users\<name>` | `claude.exe` host installer — **ignored by Ralph** |
| WSL bash | `/home/<linuxname>` | **Ralph (afk.sh / ghafk.sh) — canonical credential store** |

Consequences:

- All `claude /login` and `gh auth login` for Ralph must happen under WSL (directly, or inside a WSL-launched container as in the next section).
- If you already logged in on the Windows side (`C:\Users\<you>\.claude\`), migrate the credentials into WSL once:
  ```bash
  # WSL bash — replace <WINUSER>
  mkdir -p ~/.claude
  cp -r /mnt/c/Users/<WINUSER>/.claude/. ~/.claude/
  cp /mnt/c/Users/<WINUSER>/.claude.json ~/.claude.json 2>/dev/null || true
  mkdir -p ~/.config/gh
  cp -r "/mnt/c/Users/<WINUSER>/AppData/Roaming/GitHub CLI/." ~/.config/gh/ 2>/dev/null || true
  ```
- To launch from PowerShell, always go through `wsl bash`:
  ```powershell
  wsl bash ./ralph/afk.sh "<plan-and-prd>" 3
  ```

---

## First-run setup

### 1. Get the image

The orchestrator resolves the image in three steps on each run:

1. `docker image inspect $RALPH_IMAGE` — short-circuits if the image is already on the host.
2. Otherwise `docker pull $RALPH_IMAGE` — defaults to `docker.io/daonhan/ralph-sandbox:latest`.
3. If pull fails AND `$RALPH_DOCKER_CONTEXT/Dockerfile` exists, falls back to `docker build -t $RALPH_IMAGE $RALPH_DOCKER_CONTEXT`.

For most users step 2 is enough — no local Dockerfile needed. To prime the cache:

```bash
docker pull docker.io/daonhan/ralph-sandbox:latest
```

Build locally (offline, custom changes):

```bash
cd ralph
docker build -t docker.io/daonhan/ralph-sandbox:latest .
```

The image bundles: Node 22, .NET SDK 9, `gh`, `jq`, `git`, the Claude Code CLI.

#### Publishing a new image (maintainers)

The repo ships a GitHub Actions workflow at [`.github/workflows/publish-image.yml`](./.github/workflows/publish-image.yml) that builds + pushes multi-arch (`linux/amd64`, `linux/arm64`) images to Docker Hub.

Triggers:

- **`workflow_dispatch`** — manual run from the Actions tab; pick the tag and whether to also push `:latest`.
- **Git tag `image-v*`** — pushing a tag like `image-v0.1.3` publishes `:0.1.3` plus `:latest`.

Required repo secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (a Docker Hub access token with `Read & Write` scope on the `daonhan/ralph-sandbox` repository).

### 2. Log in to the image (one-off)

The image is stateless. Credentials live on the **host** at `~/.claude` and `~/.config/gh`. The orchestrator bind-mounts those paths into every container.

```bash
mkdir -p ~/.claude ~/.config/gh
touch ~/.claude.json

docker run -it --rm \
  -v "$HOME/.claude:/home/agent/.claude" \
  -v "$HOME/.claude.json:/home/agent/.claude.json" \
  -v "$HOME/.config/gh:/home/agent/.config/gh" \
  docker.io/daonhan/ralph-sandbox:latest bash
```

Inside the container:

```bash
claude /login         # browser flow
gh auth login         # only needed for ghafk.sh
exit
```

Verify back on the host:

```bash
ls -la ~/.claude/.credentials.json ~/.claude.json
cat ~/.config/gh/hosts.yml | head
```

#### Re-login / token expired

Re-run `claude /login` (or `gh auth login`) inside the container. Bind-mounted files are overwritten.

---

## `afk.sh` — plan/PRD loop

### Usage

```bash
./ralph/afk.sh "<plan-and-prd>" <iterations>
```

- `<plan-and-prd>` — a single string forwarded verbatim as `{{ INPUTS }}` in the template. Conventionally paths to plan and PRD files.
- `<iterations>` — max loop iterations. Exits early if implementer emits the sentinel.

### Example

```bash
./ralph/afk.sh "./docs/plans/inventory.md ./docs/prd/PRD-Inventory.md" 10
```

From PowerShell on Windows:

```powershell
wsl bash ./ralph/afk.sh "./docs/plans/inventory.md ./docs/prd/PRD-Inventory.md" 10
```

### What happens per iteration

1. **Render template** `packages/core/templates/afk.md`:
   - `` !`git log -n 5 …` `` → recent commits
   - `{{ INPUTS }}` → the plan/PRD string
   - `` !`cat ralph/prompt.md` `` → the agent playbook
2. **Implementer stage** (gate) — `docker run ralph-sandbox claude …` with the rendered prompt streamed in via a tempfile under `.ralph-tmp/` (avoids Windows 32 KB argv limit). Assistant text is rendered live; final `result` is captured.
3. **Sentinel check** — if `result` contains `<promise>NO MORE TASKS</promise>`, print `Ralph complete after <N> iterations.` and exit 0.
4. **Reviewer stage** — runs `packages/core/templates/review.md`. Inspects HEAD diff. Either commits a `fix(review): …` patch or emits `<review>OK</review>` / `<review>SKIP</review>` and stops.

---

## `ghafk.sh` — GitHub-issue loop

### Usage

```bash
./ralph/ghafk.sh <iterations>
```

No plan/PRD arg — context comes from open GitHub issues.

### What happens per iteration

1. **Render template** `packages/core/templates/ghafk.md`:
   - `` !`git log -n 5 …` `` → recent commits
   - `` !`gh issue list --state open --json number,title,body,comments` `` → open issues
   - `` !`cat ralph/ghprompt.md` `` → the agent playbook
2. **ghafk-implementer stage** (gate) — agent picks one open AFK issue, implements it, commits, closes / comments on the issue.
3. **Sentinel check** — same as `afk.sh`.
4. **Reviewer stage** — same as `afk.sh`.

---

## Consuming the package in another repo

The shims expect `@daonhan/ralph` to be resolvable via `npx`. Two install modes:

### Install once (recommended)

```bash
# in your workspace repo
npm i -D @daonhan/ralph         # or: pnpm add -D @daonhan/ralph
```

Then drop `afk.sh` / `ghafk.sh` into a `ralph/` subdirectory alongside `Dockerfile`, `prompt.md`, `ghprompt.md`. The shims do the rest:

```bash
./ralph/afk.sh "<plan-and-prd>" 5
```

### Bootstrap on demand (no install)

The shims fall back to `npx -y @daonhan/ralph` if no local install is found. Slower first run, no `package.json` required.

### Directly via npx

```bash
RALPH_WORKSPACE="$(pwd)" \
RALPH_DOCKER_CONTEXT="$(pwd)/ralph" \
npx -y @daonhan/ralph ralph-afk "<plan-and-prd>" 5
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RALPH_WORKSPACE` | `process.cwd()` | Host path bind-mounted at `/home/agent/workspace`. Also where `.ralph-tmp/` is written. |
| `RALPH_DOCKER_CONTEXT` | `$RALPH_WORKSPACE` | Build context for the `docker build` fallback. Only consulted if `docker pull` fails. Must contain `Dockerfile`. |
| `RALPH_IMAGE` | `docker.io/daonhan/ralph-sandbox:latest` | Full image reference. `ensureImage` does `inspect` → `pull` → `build` (fallback). |
| `RALPH_IMAGE_TAG` | _(legacy)_ | Deprecated alias for `RALPH_IMAGE`. Honored if `RALPH_IMAGE` unset. |

---

## Local development (this monorepo)

```bash
pnpm install                          # links workspace, hoists devDeps
pnpm -r build                         # compiles packages/core/dist
pnpm -r typecheck                     # no-emit type check
```

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
npm i -D /tmp/daonhan-ralph-core-0.1.0.tgz /tmp/daonhan-ralph-0.1.0.tgz
./node_modules/.bin/ralph-afk           # → prints usage
```

### Publish

```bash
# Bump versions in packages/core/package.json and apps/cli/package.json first.
# pnpm publishes in topological order; workspace:^ specifiers are rewritten to semver.
pnpm -r publish --access public
```

Per-package publish (granular):

```bash
(cd packages/core && pnpm publish --access public)
(cd apps/cli      && pnpm publish --access public)
```

### Use a local checkout in another repo (no publish)

```bash
# from this repo
(cd apps/cli && pnpm link --global)

# from your test workspace
pnpm link --global @daonhan/ralph
./ralph/afk.sh "test" 1
```

---

## Customizing the pipeline

### Add a stage

1. Add an entry to `STAGES` in `packages/core/src/stages.ts`:
   ```ts
   linter: { name: "linter", template: "lint.md", permissionMode: "acceptEdits" } satisfies Stage,
   ```
2. Create `packages/core/templates/lint.md` using the same `` !`cmd` `` + `{{ INPUTS }}` syntax.
3. Wire it into the chain in `main.ts` / `gh-main.ts`:
   ```ts
   stages: [STAGES.implementer, STAGES.linter, STAGES.reviewer],
   ```
4. `pnpm -r build` and republish.

Only the first stage is the gate (sentinel-checked). Subsequent stages always run after a non-sentinel gate result.

### Change the template syntax

Renderer is in `packages/core/src/render.ts`. Tags supported today:

- `` !`<shell cmd>` `` — executed via `bash -c` (Linux/WSL) or `cmd.exe` (Windows) with `cwd = workspaceDir`. stdout (trailing newline trimmed) replaces the tag.
- `{{ INPUTS }}` — replaced with the `inputs` field passed into `runLoop`.

Failures in `` !`…` `` throw and abort the iteration. Use shell-level `|| echo "<fallback>"` in the template if a command is allowed to fail.

### Override the image

Set `RALPH_IMAGE=registry.example.com/my-image:tag` before invoking the shim, or edit the default in `packages/core/src/runner.ts`. The runner does `inspect` → `pull` → `build` against whatever ref is set; legacy `RALPH_IMAGE_TAG` still works for backward compatibility.

### Change feedback loops or task priority

Edit `prompt.md` (and `ghprompt.md`) — the playbooks injected via `` !`cat ralph/prompt.md` ``.

---

## Stopping a run

- **Natural stop:** implementer emits `<promise>NO MORE TASKS</promise>`.
- **Manual stop:** `Ctrl+C`. `set -eo pipefail` in the shim and `exec npx …` propagate the signal cleanly. Tempfiles under `.ralph-tmp/.run-*.md` are removed by the `finally` block in `runner.ts`; SIGKILL may leave them — safe to delete, gitignored.

---

## Troubleshooting

- **`Cannot find module '@daonhan/ralph-core'`** — `@daonhan/ralph` was installed but its dep didn't resolve. Re-run `npm install` (or `pnpm install`) in the workspace, or use `npx -y @daonhan/ralph` to let npx fetch a clean copy.
- **`@esbuild/win32-x64 package is present but this platform needs @esbuild/linux-x64`** — `node_modules/` installed from the wrong OS. Delete `node_modules/` + lockfile and reinstall under WSL.
- **`Not logged in · Please run /login`** — Claude credentials missing inside the container. Run the interactive `docker run … claude /login` step from "First-run setup".
- **`gh issue list` fails with `not a git repository`** — the workspace has no `.git`. The `ghafk.md` template uses `|| echo "[]"` fallback so the iteration still proceeds, but `gh` cannot detect the target repo. Initialize the repo, or push first.
- **`MSB3248` during `dotnet build` / `dotnet test`** — virtiofs/9p quirk on Windows-mounted source. The agent retries automatically per the recipe in `prompt.md`; manual repro:
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

---

## Files in this folder

| File / dir | Purpose |
| --- | --- |
| [`afk.sh`](./afk.sh) | Shim — plan/PRD loop. Sets `RALPH_WORKSPACE`/`RALPH_DOCKER_CONTEXT`, execs `npx @daonhan/ralph ralph-afk`. |
| [`ghafk.sh`](./ghafk.sh) | Shim — GitHub-issue loop. Calls `ralph-ghafk`. |
| [`prompt.md`](./prompt.md) | Agent playbook for `afk.sh`. |
| [`ghprompt.md`](./ghprompt.md) | Agent playbook for `ghafk.sh`. |
| [`Dockerfile`](./Dockerfile) | Builds `ralph-sandbox` image: Node 22 + .NET SDK 9 + `gh` + `claude`. |
| [`.dockerignore`](./.dockerignore) | Shrinks build context. |
| [`package.json`](./package.json) | Monorepo root (private). Shared devDeps + pnpm workspace scripts. |
| [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) | Declares `apps/*` and `packages/*` as workspace members. |
| [`tsconfig.base.json`](./tsconfig.base.json) | Shared TS compiler options inherited by every package. |
| [`apps/cli/`](./apps/cli) | `@daonhan/ralph` — CLI bin entries (`ralph-afk`, `ralph-ghafk`). |
| [`packages/core/src/main.ts`](./packages/core/src/main.ts) | Exports `runAfk(argv)`. |
| [`packages/core/src/gh-main.ts`](./packages/core/src/gh-main.ts) | Exports `runGhAfk(argv)`. |
| [`packages/core/src/loop.ts`](./packages/core/src/loop.ts) | Iteration driver. Runs stage chain; first stage is the gate. |
| [`packages/core/src/render.ts`](./packages/core/src/render.ts) | Template renderer (`` !`cmd` `` + `{{ INPUTS }}`). |
| [`packages/core/src/runner.ts`](./packages/core/src/runner.ts) | `docker run` wrapper + NDJSON stream + credential mounts. Image lookup: inspect → pull → build. Reads `RALPH_IMAGE`. |
| [`.github/workflows/publish-image.yml`](./.github/workflows/publish-image.yml) | CI: build + push multi-arch `ralph-sandbox` to Docker Hub on `workflow_dispatch` or `image-v*` tag. |
| [`packages/core/src/stages.ts`](./packages/core/src/stages.ts) | Stage registry — `implementer`, `ghafkImplementer`, `reviewer`. |
| [`packages/core/src/index.ts`](./packages/core/src/index.ts) | Barrel re-export — `runAfk`, `runGhAfk`, `runLoop`, `STAGES`, `renderTemplate`, … |
| [`packages/core/templates/afk.md`](./packages/core/templates/afk.md) | `afk.sh` prompt template. |
| [`packages/core/templates/ghafk.md`](./packages/core/templates/ghafk.md) | `ghafk.sh` prompt template. |
| [`packages/core/templates/review.md`](./packages/core/templates/review.md) | Reviewer prompt template. |
