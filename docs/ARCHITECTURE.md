# Architecture

Internals reference for **library extenders** of `@daonhan/ralph-core` and **core contributors** who need the runtime model before touching `loop` / `render` / `runner`. For user-facing install/setup, see [`../README.md`](../README.md); for release mechanics, [`../RELEASING.md`](../RELEASING.md).

All source links are relative to this `docs/` directory (e.g. [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts)).

---

## Overview

Ralph ships as a pnpm monorepo (Node >= 20, pnpm >= 9, root `packageManager pnpm@9.12.0`) that produces three release components:

| Component             | Path                      | Version | What it is                                                                                                                                                                        |
| --------------------- | ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@daonhan/ralph-core` | `packages/core`           | 0.6.1   | Library: loop driver, docker runner, template renderer, stage registry, AFK machinery. ESM, TS → `dist/`.                                                                         |
| `@daonhan/ralph`      | `apps/cli`                | 0.6.1   | CLI exposing `ralph-afk` and `ralph-ghafk` bin entries. Hand-written JS bins, **no build step**, depends on core via `workspace:^`.                                               |
| `ralph-sandbox`       | `packages/core/templates` | 0.2.1   | Synthetic component for the Docker image (`docker.io/daonhan/ralph-sandbox:latest`). Built from [`../packages/core/templates/Dockerfile`](../packages/core/templates/Dockerfile). |

Both packages are **ESM only** (`"type": "module"`). Relative imports inside [`../packages/core/src`](../packages/core/src) end in `.js` (compiled-output extension required by `moduleResolution: NodeNext`).

The harness drives the Claude Code CLI against a target repository in an iterating **implementer → reviewer** loop. Every stage runs inside an **ephemeral `--rm` container** with the host workspace bind-mounted; nothing persists between stages except the git history written into that mounted workspace.

---

## End-to-end data flow

```
ralph-afk / ralph-ghafk           bin (apps/cli/bin/*.js → import { runAfk|runGhAfk })
        │
        ▼
runAfk / runGhAfk                 (main.ts / gh-main.ts)
   parseFlags (cli-help.ts)       --help/-V/--print-config/--no-keep-alive/--max-retries/--detach/--log/--notify
   resolve workspaceDir, ralphDir, sandcastleDir from env
   [--detach] detachAndExit       fork-and-exit, parent returns 0
        │
        ▼
runLoop (loop.ts)
   acquire() wake-lock (keepalive.ts)         once, unless --no-keep-alive
   install SIGINT/SIGTERM handlers + AbortController
   ensureImage(ralphDir, {signal})            ONCE before the loop
   for i in 1..iterations:
     for s in 0..stages.length-1:
        renderTemplate(...)  (render.ts)       expand tags → prompt string
        runStage(...)  (runner.ts)             wrapped in withRetries (retry.ts)
           writeFileSync(.run-*.md)
           spawn docker run … claude …
           streamDocker: NDJSON → live print (stdout text / stderr tools)
                                  capture "result" event → return value
        if s == 0 and result ⊇ SENTINEL: print "Ralph complete", return
   finally: release wake-lock, off() signal handlers, [--notify] toast
```

The bin layer is thin: it parses flags, resolves three directories, and calls `runLoop` with a stage chain plus an `inputs` string. `runLoop` owns the iteration, signal handling, wake-lock, retries, and the sentinel gate. `renderTemplate` is a pure-ish synchronous string transform that may shell out to the **host** to expand tags. `runStage` is the only thing that talks to Docker; `streamDocker` parses the container's NDJSON, prints assistant text to stdout and tool/diagnostic events to stderr, and returns the `result` event's payload as the stage value.

`ensureImage` runs exactly once, before the iteration loop, so a missing/floating image is resolved a single time per run.

Three resolved directories drive everything (set in `main.ts` / `gh-main.ts`):

| Dir             | Source                                    | Use                                                                   |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `workspaceDir`  | `RALPH_WORKSPACE` or `process.cwd()`      | Bind-mounted at `/home/agent/workspace`; host root for `.ralph-tmp/`. |
| `ralphDir`      | `RALPH_DOCKER_CONTEXT` or `sandcastleDir` | `docker build` fallback context.                                      |
| `sandcastleDir` | `resolve(dirname(import.meta.url), "..")` | The installed core package dir; `templates/` is read from here.       |

---

## Loop topology

Two chains, both first-stage-gated:

```
ralph-afk   → [STAGES.implementer,      STAGES.reviewer]   inputs = "<plan-and-prd>"
ralph-ghafk → [STAGES.ghafkImplementer, STAGES.reviewer]   inputs = ""
```

- **`ralph-afk` is plan/PRD-driven.** Its first positional arg is forwarded verbatim as the `{{ INPUTS }}` tag.
- **`ralph-ghafk` is GitHub-issue-driven.** No input arg; `inputs = ""` and the issue context is pulled by the template via `gh`.

**The first stage of a chain is always the gate.** After its stage runs, `loop.ts` checks the captured `result` for the exact literal sentinel:

```
<promise>NO MORE TASKS</promise>
```

On a hit the loop prints `Ralph complete` and returns immediately — subsequent stages do **not** run. The sentinel string is hardcoded as `SENTINEL` in [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts), and the agent is told to emit it (see [`../packages/core/templates/prompt.md`](../packages/core/templates/prompt.md)) when no AFK tasks remain. The **reviewer never gates** — only `s === 0` is sentinel-checked.

**Failure handling within an iteration:** each stage is wrapped in `withRetries`. If a stage exhausts its retry budget, `loop.ts` writes a `[failure]` marker to the stage log, prints a failure line, and `break`s out of the stage loop — abandoning the rest of _that_ iteration. The outer iteration loop then proceeds to the next iteration (`i + 1`). A stage failure does **not** abort the whole run.

---

## Module map

[`../packages/core/src`](../packages/core/src) holds 12 TypeScript modules plus `__tests__/`.

| Module                                              | Responsibility                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`main.ts`](../packages/core/src/main.ts)           | `runAfk` bin entry: parse flags, resolve dirs, optionally detach, then `runLoop([implementer, reviewer], inputs=planAndPrd)`.                                            |
| [`gh-main.ts`](../packages/core/src/gh-main.ts)     | `runGhAfk` bin entry: same shape, `runLoop([ghafkImplementer, reviewer], inputs="")`.                                                                                    |
| [`loop.ts`](../packages/core/src/loop.ts)           | `runLoop` — iteration driver: wake-lock, signal handlers, `ensureImage` once, per-stage render→runStage with retries, sentinel gate, notify on terminal events.          |
| [`render.ts`](../packages/core/src/render.ts)       | `renderTemplate` — expand the five tag forms; `resolveShell` picks the host shell for shell/spill tags.                                                                  |
| [`runner.ts`](../packages/core/src/runner.ts)       | Docker plumbing: `ensureImage` (sync + async overloads), `runStage`, `streamDocker`, socket detection/mount, image-ref helpers, `stageLogPath`, TTY-gated color exports. |
| [`stages.ts`](../packages/core/src/stages.ts)       | `STAGES` registry: `implementer` (afk.md), `ghafkImplementer` (ghafk.md), `reviewer` (review.md), all `bypassPermissions`; `Stage` type.                                 |
| [`index.ts`](../packages/core/src/index.ts)         | Public barrel — see exact exports below.                                                                                                                                 |
| [`cli-help.ts`](../packages/core/src/cli-help.ts)   | `parseFlags`, `printHelp`, `printVersion`, `printConfig`, `readCoreVersion`. **Internal** (not exported from `index.ts`).                                                |
| [`retry.ts`](../packages/core/src/retry.ts)         | `withRetries`, `backoffFor`, `DEFAULT_BACKOFF_MS`, `DEFAULT_MAX_RETRIES`. **Internal.**                                                                                  |
| [`keepalive.ts`](../packages/core/src/keepalive.ts) | `acquire` — OS wake-lock, returns a `Releaser`; per-platform inhibitor. **Internal.**                                                                                    |
| [`detach.ts`](../packages/core/src/detach.ts)       | `detachAndExit`, `stripDetachFlags` — fork loop into background, parent exits 0. **Internal.**                                                                           |
| [`notify.ts`](../packages/core/src/notify.ts)       | `notify`, `notifyComplete`, `notifyError` — OS toast + terminal bell. **Internal.**                                                                                      |
| `__tests__/`                                        | Vitest suites: `detach`, `keepalive`, `loop`, `notify`, `retry`, `runner` (6 files).                                                                                     |

`index.ts` re-exports **exactly**:

```ts
export { runAfk } from "./main.js";
export { runGhAfk } from "./gh-main.js";
export { runLoop, type LoopOptions } from "./loop.js";
export { STAGES, type Stage } from "./stages.js";
export {
  renderTemplate,
  type RenderOptions,
  type RenderVars,
} from "./render.js";
export { ensureImage, runStage } from "./runner.js";
```

`keepalive` / `detach` / `notify` / `retry` / `cli-help` are deliberately **not** part of the public surface.

---

## AFK machinery

Designed for unattended overnight runs. Four flags wire it up: `--no-keep-alive`, `--max-retries <N>`, `--detach` (+ `--log <path>`), `--notify`.

### Retries — [`retry.ts`](../packages/core/src/retry.ts)

`withRetries(fn, opts)` calls `fn` up to `max + 1` times. Default `DEFAULT_MAX_RETRIES = 3` (override with `--max-retries`; `0` disables retries / restores fail-fast). The backoff schedule is fixed:

```ts
export const DEFAULT_BACKOFF_MS = [5_000, 30_000, 120_000]; // 5s, 30s, 2m
```

`backoffMs[i]` is the wait **before** attempt `i+1`; once attempts exceed the array length the last value (`120_000`) repeats. `onAttempt(attempt, err)` fires after each failed attempt (before the wait) — `loop.ts` uses it to print a `[retry]` marker and append it to the stage log.

### Wake-lock — [`keepalive.ts`](../packages/core/src/keepalive.ts)

`acquire()` spawns a long-lived child that holds a system-sleep inhibitor for the loop's lifetime; `release()` kills it. Per platform:

| Platform | Mechanism                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Windows  | `powershell` holding `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` in a sleep loop. |
| macOS    | `caffeinate -i -w <parentPid>`.                                                                      |
| Linux    | `systemd-inhibit --what=sleep --mode=block sleep infinity`.                                          |

A missing utility (`ENOENT`) or early child exit degrades to a no-op with a one-time `[keepalive]` warning — the loop never crashes. WSL2 is detected via `/proc/version` and warns that `systemd-inhibit` blocks WSL idle only, not the Windows host. Skip entirely with `--no-keep-alive`.

### Detach — [`detach.ts`](../packages/core/src/detach.ts)

`--detach` forks the bin into a background process (`spawn(execPath, [binEntry, ...argv], { detached: true })`), redirects child stdout+stderr to the log file, prints `detached pid <pid>, log <path>`, and exits the parent **0**. `stripDetachFlags` removes `--detach` and `--log <value>` from the re-spawned argv so the child cannot fork again. Default log path: `<workspace>/.ralph-tmp/logs/detached-<parent-pid>.log` (override with `--log`, only valid with `--detach`).

### Notify — [`notify.ts`](../packages/core/src/notify.ts)

`--notify` fires a best-effort OS toast + a terminal bell (`\x07` to stderr) on terminal events:

- `notifyComplete` on sentinel hit or iteration-cap reached.
- `notifyError` on SIGINT/SIGTERM or an uncaught loop error.

Toast backends: Windows BurntToast (fallback `msg.exe`), macOS `osascript display notification`, Linux `notify-send`. All fire-and-forget; missing utilities are swallowed.

### Signal handling — [`loop.ts`](../packages/core/src/loop.ts)

`runLoop` installs `SIGINT` / `SIGTERM` handlers and an `AbortController` (`stageAbort`):

- **SIGINT** → abort the active stage, `notifyError("interrupted (SIGINT)")` if `--notify`, release wake-lock, `process.exit(130)`.
- **SIGTERM** → abort active stage, `notifyError("terminated (SIGTERM)")` if `--notify`, release wake-lock, `process.exit(143)`.

Aborting flows the `stageAbort.signal` into `runStage` / `ensureImage`; `streamDocker` and `runDockerCommand` listen for `abort` and **kill the docker child**, rejecting with an `AbortError`. The wake-lock is released through a single `releaseOnce` guard shared by both handlers and the `finally` block, so the inhibitor child is killed exactly once. Handlers are removed via `process.off` in `finally`.

---

## Template renderer

[`render.ts`](../packages/core/src/render.ts). Templates live in [`../packages/core/templates`](../packages/core/templates). `renderTemplate(templatePath, vars, opts)` reads the file and applies five tag forms **in this fixed order** (order matters — `@spill` resolves before shell tags, and the try-shell regex matches before the plain one):

| #   | Tag                                        | Behavior                                                                                                                                                                                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `@include:<path>`                          | Inline a file via `readFileSync`. Relative paths resolve against the template's dir. **No shell.** Trailing newline trimmed. Used to inject the playbooks.                                                                                        |
| 2   | `@spill[?]:<name>=`<cmd[\|\|\|fallback]>`` | Run `cmd` on the host shell, write stdout to `spillHostDir/<name>`, and substitute the container-relative path `./<spillRefPath>/<name>` into the prompt. The `?` form treats non-zero exit as success and writes `fallback` instead of throwing. |
| 3   | `!?`<cmd[\|\|\|fallback]>``                | Try-shell. `execSync` with stderr suppressed; non-zero exit substitutes the literal `fallback` string. Matches **before** the plain `!` form.                                                                                                     |
| 4   | `!`<cmd>``                                 | Plain shell. `execSync` with `cwd = workspaceDir`. Failure **throws and aborts the iteration**.                                                                                                                                                   |
| 5   | `{{ INPUTS }}`                             | Replaced with `vars.INPUTS` (the `inputs` string passed to `runLoop`).                                                                                                                                                                            |

`resolveShell()`: `/bin/bash` on Linux/macOS; on Windows it walks `PATH` (`;`-split) for the first `bash.exe` (Git for Windows / WSL passthrough), falling back to `cmd.exe`. **Templates should prefer `!?` over `!`** for any command that may be unavailable on `cmd.exe`. Shell tags cap output at `maxBuffer = 64 MiB`.

**`@spill` security check:** the `<name>` must be a plain filename — any `/`, `\`, `.`, `..`, embedded `..`, or absolute path throws. Templates are trusted (shipped in the tarball) but this is defense-in-depth to keep writes confined to the per-iteration spill dir. `runLoop` supplies a fresh per-stage `spillHostDir` (`<workspace>/.ralph-tmp/spill-<pid>-<iter>-<stageIdx>-<ts>/`) and `spillRefPath` (`.ralph-tmp/spill-…`, POSIX) on every render; using `@spill` without them throws.

### What the shipped templates actually do

**[`afk.md`](../packages/core/templates/afk.md)** — try-shell for recent commits, the `{{ INPUTS }}` block, then `@include:prompt.md`:

```
!?`git log -n 5 --format="%H%n%ad%n%B---" --date=short|||No commits found`
...
{{ INPUTS }}
@include:prompt.md
```

**[`ghafk.md`](../packages/core/templates/ghafk.md)** — a **two-view issue model** to keep the prompt lean: an inline summary index plus a spilled full dump.

```
<issues-summary>
!?`gh issue list --state open --limit 50 --json number,title,labels|||[]`
</issues-summary>

<issues-full-file>
Full issue bodies + comments spilled to:
@spill?:issues.json=`gh issue list --state open --limit 50 --json number,title,body,labels,comments|||[]`
</issues-full-file>
@include:ghprompt.md
```

The agent triages from the inline `<issues-summary>`, then `Read`s the spilled `issues.json` (with `offset`/`limit`) for bodies/comments before picking a task — so large issue bodies never bloat the prompt token count.

**[`review.md`](../packages/core/templates/review.md)** — `HEAD`, recent commits, `git show --stat HEAD` inline, and the **full HEAD patch spilled** to `head.diff`:

```
!?`git rev-parse HEAD|||(no commits)`
!?`git show --stat HEAD|||No diff`
Full patch spilled to: @spill?:head.diff=`git show HEAD|||No diff body`
```

The reviewer reviews only the latest commit; emits `<review>OK</review>` / `<review>SKIP</review>` and stops, or fixes defects and commits a new `fix(review): …` (never amends).

---

## Docker runner

[`runner.ts`](../packages/core/src/runner.ts).

### `docker run` argv shape

`runStage` writes the rendered prompt to `<workspace>/.ralph-tmp/.run-<pid>-<iter>-<ts>.md` (referenced as `./.ralph-tmp/<file>` inside the container, sidestepping the Windows ~32 KB argv limit), then assembles:

```
docker run --rm -i \
  -v <workspaceDir>:/home/agent/workspace \
  -w /home/agent/workspace \
  -e GIT_CONFIG_COUNT=1 \
  -e GIT_CONFIG_KEY_0=safe.directory \
  -e GIT_CONFIG_VALUE_0=* \
  [ -v <HOME>/.claude:/home/agent/.claude ] \
  [ -v <HOME>/.claude.json:/home/agent/.claude.json ] \
  [ -v <HOME>/.config/gh:/home/agent/.config/gh:ro ] \
  [ -v <sock>:/var/run/docker.sock  --group-add <gid|0> ] \
  <IMAGE_REF> \
  claude --verbose --print --output-format stream-json \
         --permission-mode <mode> \
         "Read the full instructions from the file ./.ralph-tmp/<run-file> in the current workspace and execute them."
```

- **Workspace mount + `-w`:** the host workspace is the only writable surface; the container's working dir is set to it.
- **Git env injection:** `GIT_CONFIG_COUNT/KEY_0/VALUE_0` forces `safe.directory=*` so git works against a bind-mount whose UID differs from the container user (a Windows-host pain point).
- **Credential mounts** (only if the host path exists, resolved against `HOME || USERPROFILE`): `~/.claude` (**rw**), `~/.claude.json` (**rw**), `~/.config/gh` (**ro**).
- **`--permission-mode <mode>`** is always `bypassPermissions` (from the stage).

### Docker socket mount (default ON)

`resolveDockerSocketMount()` bind-mounts the host Docker socket into the sandbox so **Testcontainers** (and any Docker API client) inside the container can spawn **sibling** containers on the host daemon.

`detectDockerSocketPath()` candidate order:

1. `RALPH_DOCKER_SOCK_PATH` (explicit).
2. `DOCKER_HOST=unix:///…` (parsed; `tcp://` / `npipe://` / `ssh://` unsupported for bind-mount).
3. `/var/run/docker.sock`
4. `$HOME/.docker/run/docker.sock` (Docker Desktop macOS 4.x+)
5. `$HOME/.colima/default/docker.sock`
6. `$HOME/.rd/docker.sock` (Rancher Desktop)
7. `$XDG_RUNTIME_DIR/docker.sock` (rootless Docker)
8. `$XDG_RUNTIME_DIR/podman/podman.sock`

On Windows only the explicit overrides are considered, then it returns `/var/run/docker.sock` (Docker Desktop translates it via the WSL2 backend). **Group fixup:** on Linux it `statSync`es the socket and passes `--group-add <gid>` matching the host docker group; on Docker Desktop (macOS/Windows) the socket surfaces as `root:root 0660`, so it passes `--group-add 0` (file-access group only — the agent process still runs as UID 1000).

**Opt-out:** `RALPH_DOCKER_SOCK=0`. **Security note:** mounting `docker.sock` grants the sandbox root-equivalent access to the host Docker daemon; combined with `bypassPermissions`, the blast radius is "anything docker can do on this host." Disable it for untrusted prompts.

### Image resolution — `ensureImage`

`docker image inspect` → `docker pull` → `docker build` (fallback). The build fallback runs **only** if pull fails **and** a Dockerfile exists at the build context. `isFloatingRef(ref)` returns `true` for `:latest` or an untagged ref (and `false` for a `@sha256:` digest pin); a **floating ref is always re-pulled even when cached**, so republishing `:latest` (e.g. a newer .NET SDK) reaches users. `resolveDockerfile(ctx)` prefers `ctx/templates/Dockerfile`, then `ctx/Dockerfile`. `IMAGE_REF` = `RALPH_IMAGE` → `RALPH_IMAGE_TAG` (legacy) → `docker.io/daonhan/ralph-sandbox:latest`. `ensureImage` has a sync overload and an async (`{ signal }`) overload; `loop.ts` uses the async one so a signal can abort the pull/build.

### NDJSON streaming — `streamDocker`

`spawn("docker", args, { stdio: ["ignore","pipe","pipe"] })`. stdout is read line-by-line; lines starting with `{` are appended to the NDJSON log and `JSON.parse`d:

- **assistant `text`** → printed to **stdout** with a `●` bullet (the visible answer stream).
- **`tool_use` / `tool_result` / `thinking` / `system:init`** → rendered to **stderr** (tool name + truncated input/result preview + elapsed ms).
- **`result`** event → its `result` string is captured as `finalResult`, the stage's return value.

Color is **TTY-gated and stream-split**: `USE_COLOR` (stderr) and `USE_COLOR_STDOUT` (stdout) are independent, so `ralph-ghafk 1 > out.txt` stays clean even on a TTY. ANSI is disabled when `NO_COLOR` is set or `TERM=dumb`.

**Post-result grace timer:** when the `result` event arrives, a one-shot timer (`RALPH_RESULT_GRACE_MS`, default **30000 ms**; `0` disables) is armed. If the docker child emits its final NDJSON but never exits (a known claude-CLI self-deadlock), the timer kills the child and resolves with the captured result so the loop is not hung. On non-zero exit, `streamDocker` rejects with the last ~40 stderr lines.

---

## Per-iteration scratch layout

Everything lands under `<workspace>/.ralph-tmp/` (gitignored):

```
<workspace>/.ralph-tmp/
├── .run-<pid>-<iter>-<ts>.md             rendered prompt (deleted in finally; may leak on SIGKILL)
├── spill-<pid>-<iter>-<stageIdx>-<ts>/   per-stage @spill outputs (deleted in finally)
│   └── <name>                            e.g. issues.json, head.diff
└── logs/
    ├── <ts>-iter<N>-<stage>.ndjson       full NDJSON stream log (kept)
    └── detached-<pid>.log                child stdout+stderr (only in --detach mode)
```

`.run-*.md` and `spill-*/` are removed in `runStage`'s `finally`; the NDJSON logs are kept for inspection. A leaked `.run-*.md` after a hard kill is safe to delete.

---

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`; relative imports in `packages/core/src` end in `.js` (NodeNext).
- **First stage is the gate.** Place gating stages at index 0 of any chain. The sentinel `<promise>NO MORE TASKS</promise>` is hardcoded in [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts).
- **No build step for `apps/cli`.** Bins are hand-written JS that `import { runAfk } from "@daonhan/ralph-core"`. Keep the bin layer flat — don't add TS there.
- **`permissionMode` is always `bypassPermissions`** for sandbox stages — AFK requires non-interactive bash/edit approval; blast radius is bounded to the bind-mounted workspace tree and is git-recoverable. Never `acceptEdits`.
- **Templates ship in the core tarball.** `packages/core/package.json` `files` includes `dist` and `templates` (the `Dockerfile` lives under `templates/`).
- **Adding a stage** = (1) extend `STAGES` in [`../packages/core/src/stages.ts`](../packages/core/src/stages.ts), (2) drop a new `*.md` in [`../packages/core/templates`](../packages/core/templates), (3) wire it into the chain in `main.ts` / `gh-main.ts`.

---

## Building, testing, and the sandbox image

Verification = typecheck + unit tests + manual bin invocation (no separate lint command; formatting runs via the pre-commit hook).

Build core (`apps/cli` has no build):

```bash
pnpm install
pnpm -r build        # tsc -p packages/core/tsconfig.json → dist/
pnpm -r typecheck    # tsc --noEmit across the workspace
```

```powershell
pnpm install
pnpm -r build
pnpm -r typecheck
```

Run tests (core: vitest; root: `node --test` over `scripts/*.test.mjs`):

```bash
pnpm --filter @daonhan/ralph-core test   # vitest run, src/__tests__/*.test.ts
pnpm test                                # root: node --test scripts/*.test.mjs
```

```powershell
pnpm --filter @daonhan/ralph-core test
pnpm test
```

The pre-commit hook ([`../.husky/pre-commit`](../.husky/pre-commit)) runs `pnpm exec lint-staged` (Prettier `--write` on staged files) then `pnpm typecheck`.

Build the sandbox image locally from [`../packages/core/templates/Dockerfile`](../packages/core/templates/Dockerfile) (`node:22-bookworm` + git/curl/jq + .NET SDK 10 + `gh` + Claude Code CLI; base `node` user renamed to `agent` UID 1000; `safe.directory=*` global; `WORKDIR /home/agent/workspace`; `ENTRYPOINT []`, `CMD ["claude"]`):

```bash
docker build -t docker.io/daonhan/ralph-sandbox:latest \
  -f packages/core/templates/Dockerfile .
```

```powershell
docker build -t docker.io/daonhan/ralph-sandbox:latest `
  -f packages/core/templates/Dockerfile .
```

Diagnose resolved config (workspace / docker context / image / socket) without launching Docker:

```bash
ralph-afk --print-config
```

```powershell
ralph-afk --print-config
```

Release/publishing (release-please → tag-driven npm + image workflows) is the single-source-of-truth concern of [`../RELEASING.md`](../RELEASING.md).

---

## Environment variables

| Variable                 | Default                                  | Effect                                                                    |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------- |
| `RALPH_WORKSPACE`        | `process.cwd()`                          | Host dir bind-mounted at `/home/agent/workspace`; root for `.ralph-tmp/`. |
| `RALPH_DOCKER_CONTEXT`   | bundled core dir                         | `docker build` fallback context (must contain a Dockerfile).              |
| `RALPH_IMAGE`            | `docker.io/daonhan/ralph-sandbox:latest` | Sandbox image ref.                                                        |
| `RALPH_IMAGE_TAG`        | —                                        | Legacy alias for `RALPH_IMAGE`.                                           |
| `RALPH_RESULT_GRACE_MS`  | `30000`                                  | Post-result kill timer; `0` disables. Invalid/negative → default.         |
| `RALPH_DOCKER_SOCK`      | on                                       | `0` disables the host `docker.sock` bind-mount.                           |
| `RALPH_DOCKER_SOCK_PATH` | auto-detect                              | Explicit host socket path.                                                |
| `DOCKER_HOST`            | —                                        | `unix://…` parsed as a socket candidate.                                  |
| `XDG_RUNTIME_DIR`        | —                                        | Rootless Docker/Podman socket candidates.                                 |
| `NO_COLOR` / `TERM=dumb` | —                                        | Disable ANSI on both streams.                                             |
