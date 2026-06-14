# Ralph — Autonomous Claude Code Loop

[![@daonhan/ralph](https://img.shields.io/npm/v/@daonhan/ralph?label=%40daonhan%2Fralph)](https://www.npmjs.com/package/@daonhan/ralph)
[![@daonhan/ralph-core](https://img.shields.io/npm/v/@daonhan/ralph-core?label=%40daonhan%2Fralph-core)](https://www.npmjs.com/package/@daonhan/ralph-core)
[![CI](https://github.com/daonhan/ralph/actions/workflows/ci.yml/badge.svg)](https://github.com/daonhan/ralph/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Ralph drives [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) against a target repository in an iterating implementer → reviewer pipeline, running `claude` directly on the host. The harness ships as two npm packages. Docker is not required.

> ⚠️ **Security:** Ralph runs Claude with `--permission-mode bypassPermissions`. The default `RALPH_RUNNER=sandbox` uses Claude Code's native OS sandbox (Seatbelt on macOS) to confine writes to the workspace; `RALPH_RUNNER=host` runs unsandboxed. Point it only at repositories, plans, and GitHub issues you trust. See **[SECURITY.md](./SECURITY.md)** for the full threat model.

> **New here?** Start with **[QUICKSTART.md](./QUICKSTART.md)** (zero-to-first-loop). Hacking on Ralph itself → **[CONTRIBUTING.md](./CONTRIBUTING.md)**. Internals → **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

- **[`@daonhan/ralph-core`](./packages/core)** — library: iteration loop, native-sandbox runner, template renderer, stage registry. Importable from any Node project.
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
   └── runner                         (spawn claude → NDJSON stream → live print → final result)
   │
   ▼
claude --verbose --print --output-format stream-json … (cwd = workspace, native OS sandbox)
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
│       └── templates/           afk.md, ghafk.md, review.md, prompt.md, ghprompt.md
└── (playbooks live in packages/core/templates/ alongside the prompt templates)
```

At runtime, the host workspace gets a `.ralph-tmp/` directory containing the per-iteration prompt files and `logs/*.ndjson`. This directory is gitignored.

---

## Prerequisites

- **Node.js 20+** + **npm 9+** (or `pnpm`/`yarn`). For macOS/Linux: nvm, asdf, or distro package.
- **Claude Code** authenticated: `claude /login` once. macOS is the primary supported target (Seatbelt sandbox). Linux works with the default sandbox runner if `bubblewrap` + `socat` are installed; otherwise use `RALPH_RUNNER=host`.
- **`gh`** authenticated (only required for `ralph-ghafk`): `gh auth login` once.

Docker is not required. `claude` and `gh` on the host read `~/.claude`, `~/.claude.json`, and `~/.config/gh` natively.

### Supported OS combinations

| Where you invoke `ralph-afk` | Status | Notes                                                                            |
| ---------------------------- | ------ | -------------------------------------------------------------------------------- |
| macOS native                 | ✓      | Primary target. Native Seatbelt sandbox via `RALPH_RUNNER=sandbox` (default).    |
| Linux native (Ubuntu, etc.)  | ✓      | Sandbox runner requires `bubblewrap`+`socat`; otherwise use `RALPH_RUNNER=host`. |

---

## First-run setup

### 1. Authenticate on the host (one-off)

Ralph runs `claude` directly on the host. Credentials are read natively — no Docker mounts.

```bash
claude /login       # browser flow; writes ~/.claude + ~/.claude.json
gh auth login       # only needed for ralph-ghafk
```

For `gh auth login` pick: `GitHub.com` → `HTTPS` → `Y` (authenticate Git) → `Login with web browser`. Copy the one-time code, open `https://github.com/login/device` on the host browser, paste, approve.

#### Verify

```bash
ls -la ~/.claude/.credentials.json ~/.claude.json
gh auth status
```

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
- `ralph-afk --print-config` — print resolved workspace / runner / sandbox config and exit. Use for diagnostics before launching a real loop.

- `<plan-and-prd>` — a single string forwarded verbatim as `{{ INPUTS }}` in the template. Conventionally paths to plan and PRD files.
- `<iterations>` — max loop iterations. Exits early if implementer emits the sentinel.

### Example

```bash
ralph-afk "./docs/plans/inventory.md ./docs/prd/PRD-Inventory.md" 10
```

### What happens per iteration

1. **Render template** `packages/core/templates/afk.md`:
   - `` !?`git log -n 5 …|||No commits found` `` → recent commits (try-shell)
   - `{{ INPUTS }}` → the plan/PRD string
   - `@include:prompt.md` → the agent playbook (inlined by the Node renderer, no shell)
2. **Implementer stage** (gate) — `claude` is spawned on the host with the rendered prompt via a tempfile under `.ralph-tmp/`. The default `RALPH_RUNNER=sandbox` enables the native OS sandbox (Seatbelt on macOS). Assistant text is rendered live; final `result` is captured.
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

Full per-OS notes (wake-lock mechanism, etc.) live in [`docs/keep-alive.md`](./docs/keep-alive.md).

### Cost control, pacing & review panel

| Flag              | Default | What it does                                                                                                                    |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--budget <usd>`  | off     | Stop the loop once cumulative Claude spend reaches this dollar amount (committed work is kept). Cost is printed per stage.      |
| `--cooldown <ms>` | `0`     | Sleep between iterations; grows automatically (×2, capped) when the API signals throttling.                                     |
| `--review-panel`  | off     | Replace the single reviewer with a paced panel — read-only `correctness`/`security`/`tests` lenses → one `fix(review):` commit. |

```bash
# cap spend, pace iterations, and use the reviewer panel
ralph-afk --budget 10 --cooldown 2000 --review-panel "<plan-and-prd>" 30
```

### Watch mode (`ralph-ghafk` only)

Run as a daemon that idles, polls GitHub for labelled open issues, and runs the loop when work appears:

```bash
ralph-ghafk --watch --watch-interval 300 5     # poll every 5 min, ≤5 iterations per trigger
```

The trigger label defaults to `ralph` (`RALPH_WATCH_LABEL` to change it). Under `--watch`, `--budget` caps total spend across the whole session; `Ctrl+C` stops cleanly.

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

| Variable                 | Default                      | Purpose                                                                                                                                                                                                               |
| ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALPH_WORKSPACE`        | `process.cwd()`              | Host path Claude runs against (`cwd`). Also where `.ralph-tmp/` is written.                                                                                                                                           |
| `RALPH_RUNNER`           | `sandbox`                    | `sandbox` (default) — enables the native OS sandbox (Seatbelt on macOS), confining writes to the workspace. `host` — runs claude unsandboxed (only safe in a git-recoverable, throwaway tree).                        |
| `RALPH_SANDBOX_NET`      | _(unset — unrestricted)_     | Comma-separated domain allowlist for sandbox network egress. Unset = unrestricted (filesystem confinement is the blast-radius control; network commands fall back to the bypass-approved escape hatch automatically). |
| `RALPH_RESULT_GRACE_MS`  | `30000`                      | Milliseconds to wait after the final NDJSON `result` event before force-killing a `claude` child that fails to exit on its own. `0` disables the timer. Invalid values fall back to the default.                      |
| `RALPH_MODEL`            | _(unset → CLI default)_      | Pins the Claude model. When non-empty, `--model <value>` is passed through to the `claude` CLI for every stage. Empty/whitespace = unset. Pass-through: the `claude` CLI owns validation.                             |
| `RALPH_REVIEW_LENSES`    | `correctness,security,tests` | Comma-separated lens list for the reviewer panel. Setting it implies `--review-panel`.                                                                                                                                |
| `RALPH_WATCH_LABEL`      | `ralph`                      | Issue label that gates a `--watch` run (`ralph-ghafk`).                                                                                                                                                               |
| `NO_COLOR` / `TERM=dumb` | _(unset)_                    | Disable ANSI color in Ralph's own output. Color is also auto-disabled when stdout/stderr is not a TTY, so piping to a file stays clean.                                                                               |

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

Publishing is **automated** — you don't run `pnpm publish` by hand. Land work on `main` with [Conventional Commits](./RELEASING.md#3-conventional-commit-guide); [release-please](./.github/workflows/release-please.yml) opens one Release PR per npm package, and **merging that PR** cuts the component tag (`ralph-core-v*` / `ralph-v*`) that triggers [`publish-npm.yml`](./.github/workflows/publish-npm.yml). See **[RELEASING.md](./RELEASING.md)** for the full flow, required secrets, version policy, and rollback runbook.

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

Only the first stage is the gate (sentinel-checked). Subsequent stages always run after a non-sentinel gate result. All stages use `permissionMode: "bypassPermissions"` — AFK runs non-interactively, so bash/edit approval must be automatic; blast radius is bounded by the runner sandbox and the workspace is git-recoverable.

### Change the template syntax

Renderer is in `packages/core/src/render.ts`. Tags supported today:

- `` !`<shell cmd>` `` — executed via `bash` (Linux/macOS/WSL/Git Bash) or `cmd.exe` (Windows native fallback) with `cwd = workspaceDir`. stdout (trailing newline trimmed) replaces the tag. Failures throw and abort the iteration.
- `` !?`<shell cmd>|||<fallback>` `` — try-shell. Same as `!` but stderr is suppressed and a non-zero exit returns the literal fallback string. Use this for cross-platform safety — avoids depending on shell-specific `2>/dev/null || echo "…"` idioms.
- `` @spill[?]:<name>=`<shell cmd>[|||<fallback>]` `` — run `<cmd>` and write its **stdout to a file** `<name>` in the per-stage spill dir (`.ralph-tmp/spill-…/`), substituting the workspace-relative path `./.ralph-tmp/spill-…/<name>` into the prompt for the agent to `Read`. The `?` form suppresses stderr and writes `<fallback>` on non-zero exit; `<name>` must be a plain filename (no path separators, no `..`). Use for large outputs that would bloat the prompt — `review.md` spills the full HEAD patch, `ghafk.md` the full issue bodies.
- `@include:<rel-or-abs-path>` — inline a file (via Node `readFileSync`). Path resolved against the template's own directory when relative. No shell. Use this for bundled playbooks, not for live shell output.
- `{{ INPUTS }}` — replaced with the `inputs` field passed into `runLoop`.

Tags expand in a fixed order: `@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}`.

On Windows, the renderer prefers `bash.exe` (Git for Windows / WSL passthrough) over `cmd.exe`. The `!?` tag makes commands tolerant either way.

### Change feedback loops or task priority

The agent playbooks are self-contained: `packages/core/templates/prompt.md` (plan/PRD source + progress recording, for `ralph-afk`) and `ghprompt.md` (issue triage + close/comment, for `ralph-ghafk`). Each carries its own task-priority ladder, feedback loops, commit rules, and final rules. `afk.md` / `ghafk.md` each `@include` their respective playbook. Edit the playbook for a loop to change its task priority or feedback loops.

---

## Stopping a run

- **Natural stop:** implementer emits `<promise>NO MORE TASKS</promise>`.
- **Manual stop:** `Ctrl+C`. `runLoop` installs `SIGINT` / `SIGTERM` handlers that abort the active stage (via `AbortController`, killing the `claude` child), release the OS wake-lock, fire the `--notify` toast if enabled, and exit `130` (SIGINT) / `143` (SIGTERM). Tempfiles under `.ralph-tmp/.run-*.md` and the per-stage `spill-*/` dir are removed by the `finally` block in `runner.ts`; a hard `SIGKILL` may leave them — safe to delete, gitignored.

---

## Troubleshooting

- **`Cannot find module '@daonhan/ralph-core'`** — `@daonhan/ralph` was installed but its dep didn't resolve. Re-run `npm install` (or `pnpm install`) in the workspace, or use `npx -y @daonhan/ralph` to let npx fetch a clean copy.
- **`Not logged in · Please run /login`** — Claude credentials missing. Run `claude /login` on the host (see "First-run setup").
- **`gh issue list` fails with `not a git repository`** — the workspace has no `.git`. The `ghafk.md` template uses `|| echo "[]"` fallback so the iteration still proceeds, but `gh` cannot detect the target repo. Initialize the repo, or push first.
- **Loop hangs after a stage's final assistant message (no next iteration, no error)** — the `claude` CLI emitted its final NDJSON `result` event but failed to exit. The runner self-recovers within `RALPH_RESULT_GRACE_MS` (default 30000ms) — bump or disable via env var. Work already committed in prior iterations is preserved.

---

## Files in this folder

| File / dir                                                                       | Purpose                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/cli/scripts/afk.sh`](./apps/cli/scripts/afk.sh)                           | Optional shim — plan/PRD loop. Falls back to `npx @daonhan/ralph ralph-afk`. Shipped in the npm tarball.                                                                     |
| [`apps/cli/scripts/ghafk.sh`](./apps/cli/scripts/ghafk.sh)                       | Optional shim — GitHub-issue loop. Calls `ralph-ghafk`.                                                                                                                      |
| [`packages/core/templates/prompt.md`](./packages/core/templates/prompt.md)       | Agent playbook for `ralph-afk`. Shipped in core tarball.                                                                                                                     |
| [`packages/core/templates/ghprompt.md`](./packages/core/templates/ghprompt.md)   | Agent playbook for `ralph-ghafk`. Shipped in core tarball.                                                                                                                   |
| [`package.json`](./package.json)                                                 | Monorepo root (private). Shared devDeps + pnpm workspace scripts.                                                                                                            |
| [`pnpm-workspace.yaml`](./pnpm-workspace.yaml)                                   | Declares `apps/*` and `packages/*` as workspace members.                                                                                                                     |
| [`tsconfig.base.json`](./tsconfig.base.json)                                     | Shared TS compiler options inherited by every package.                                                                                                                       |
| [`apps/cli/`](./apps/cli)                                                        | `@daonhan/ralph` — CLI bin entries (`ralph-afk`, `ralph-ghafk`).                                                                                                             |
| [`packages/core/src/main.ts`](./packages/core/src/main.ts)                       | Exports `runAfk(argv)`.                                                                                                                                                      |
| [`packages/core/src/gh-main.ts`](./packages/core/src/gh-main.ts)                 | Exports `runGhAfk(argv)`.                                                                                                                                                    |
| [`packages/core/src/loop.ts`](./packages/core/src/loop.ts)                       | Iteration driver. Runs stage chain; first stage is the gate.                                                                                                                 |
| [`packages/core/src/render.ts`](./packages/core/src/render.ts)                   | Template renderer (`` !`cmd` `` + `{{ INPUTS }}`).                                                                                                                           |
| [`packages/core/src/runner.ts`](./packages/core/src/runner.ts)                   | Native-sandbox runner: spawn `claude` + NDJSON stream + sandbox settings. Reads `RALPH_RUNNER`.                                                                              |
| [`.github/workflows/publish-npm.yml`](./.github/workflows/publish-npm.yml)       | CI: publish `@daonhan/ralph-core` / `@daonhan/ralph` to npm on `ralph-core-v*` / `ralph-v*` tags; enriches the GitHub Release with the `.tgz`, SBOM, and cosign attestation. |
| [`.github/workflows/release-please.yml`](./.github/workflows/release-please.yml) | CI: on push to `main`, opens a per-component Release PR; merging it cuts the tag that triggers the publish workflows.                                                        |
| [`RELEASING.md`](./RELEASING.md)                                                 | Single source of truth for releasing the npm packages: release-please flow, version policy, secrets, rollback runbook.                                                       |
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
