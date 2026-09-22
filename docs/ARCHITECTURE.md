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

The harness drives a selectable Claude Code or Codex CLI against a target repository in an iterating **implementer → reviewer** loop. Claude is the default; `--agent codex` opts into Codex, and `RALPH_AGENT` is the fallback when the flag is absent. Every stage runs inside an **ephemeral `--rm` container** whose container filesystem is discarded. The host-mounted workspace, including scratch logs and uncommitted changes, and the selected provider's credential store persist across stages.

---

## End-to-end data flow

```
ralph-afk / ralph-ghafk           bin (apps/cli/bin/*.js → import { runAfk|runGhAfk })
        │
        ▼
runAfk / runGhAfk                 (main.ts / gh-main.ts → runBin in run-bin.ts)
   parseFlags (cli-help.ts)       --agent/--codex-user-config/--help/-V/--print-config/AFK flags
   resolve workspaceDir, ralphDir, packageDir from env
   [--detach] detachAndExit       fork-and-exit, parent returns 0
        │
        ▼
runLoop (loop.ts)
   openRunLog (run-log.ts)                    .ralph/history/<runId>.jsonl, run.started fsynced
   claim: findLiveRun → findRunContainer      another live run or its container → run.ended refused, exit 75
   acquire() wake-lock (keepalive.ts)         once, unless --no-keep-alive
   install SIGINT/SIGTERM handlers + AbortController
   start heartbeat timer                      HEARTBEAT_MS = 30 s, appends to the run log
   validateAgentTuning (agents/index.ts)      a bad effort → run.ended error, exit 1, no container
   ensureImage(ralphDir, {signal})            ONCE before the loop
   for i in 1..iterations:
     for s in 0..stages.length-1:
        withRetries(...)                       attempt numbers restart per stage
          resolveAgentConfigSnapshot(...)      fresh synchronous provider snapshot
          print attempt config to stderr       same snapshot that argv will use
          renderTemplate(...)  (render.ts)     expand tags → prompt string
          runStage(...)  (runner.ts)
            writeFileSync(.run-*.md)
            select agents/{claude,codex} adapter
            spawn docker run … <provider command> …
            streamDocker: provider JSONL → normalized events → live print
                                   capture completion → return value
        if s == 0 and hasSentinel(result): print run summary, return
   finally: release wake-lock, off() signal handlers, [--notify] toast
```

The bin layer is thin: it parses flags, resolves three directories and the provider selection, and calls `runLoop` with a stage chain plus an `inputs` string. `runLoop` owns the iteration, signal handling, wake-lock, retries, and the sentinel gate without provider-specific branches. `renderTemplate` is a pure-ish synchronous string transform that may shell out to the **host** to expand tags. `runStage` is the only thing that talks to Docker; an agent adapter supplies the command, selected-provider credentials, environment, and JSONL decoder. `streamDocker` renders normalized assistant/tool/diagnostic events and returns the decoder's completion as the stage value.

`ensureImage` runs exactly once, before the iteration loop, so a missing/floating image is resolved a single time per run.

Three resolved directories drive everything (set in `run-bin.ts`, shared by both bins):

| Dir            | Source                                    | Use                                                                   |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `workspaceDir` | `RALPH_WORKSPACE` or `process.cwd()`      | Bind-mounted at `/home/agent/workspace`; host root for `.ralph-tmp/`. |
| `ralphDir`     | `RALPH_DOCKER_CONTEXT` or `packageDir`    | `docker build` fallback context.                                      |
| `packageDir`   | `resolve(dirname(import.meta.url), "..")` | The installed core package dir; `templates/` is read from here.       |

---

## Loop topology

Two chains, both first-stage-gated:

```
ralph-afk   → [STAGES.implementer,      STAGES.reviewer]   inputs = "<plan-and-prd>"
ralph-ghafk → [STAGES.ghafkImplementer, STAGES.reviewer]   inputs = ""
```

- **`ralph-afk` is plan/PRD-driven.** Its first positional arg is forwarded verbatim as the `{{ INPUTS }}` tag.
- **`ralph-ghafk` is GitHub-issue-driven.** No input arg; `inputs = ""` and the issue context is pulled by the template via `gh`.

**The first stage of a chain is always the gate.** After its stage runs, `loop.ts` checks the captured `result` for the exact literal sentinel on a line of its own:

```
<promise>NO MORE TASKS</promise>
```

On a hit the loop prints the `Ralph ended · no-more-tasks · …` summary line and returns immediately — subsequent stages do **not** run. The sentinel string is hardcoded as `SENTINEL` in [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts) and matched by the exported `hasSentinel` predicate — surrounding whitespace and a wrapping pair of backticks are allowed, nothing else on the line — and the agent is told to emit it (see [`../packages/core/templates/prompt.md`](../packages/core/templates/prompt.md)) when no AFK tasks remain. A mention inside prose does not gate: the loop writes one `[warning] iteration <i>: the gate mentioned … without emitting it on a line of its own; the loop continues` line to stderr and keeps going. The **reviewer never gates** — only `s === 0` is sentinel-checked.

**Failure handling within an iteration:** each stage is wrapped in `withRetries`.
The attempt counter increments and its configuration line is written before
template rendering, so a render failure consumes and reports an attempt just
like a runner failure. Each retry resolves and prints a fresh configuration
snapshot; numbering restarts at 1 for the next stage. A later stage skipped
because the gate left HEAD unchanged does not enter `withRetries`, resolve a
snapshot, or print an attempt line. If a stage exhausts its retry budget,
`loop.ts` writes a `[failure]` marker to the stage log, prints a failure line,
and `break`s out of the stage loop — abandoning the rest of _that_ iteration.
The outer iteration loop then proceeds to the next iteration (`i + 1`). A stage
failure does **not** abort the whole run.

---

## Module map

[`../packages/core/src`](../packages/core/src) holds the orchestration modules, provider adapters, and `__tests__/`.

| Module                                                      | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`main.ts`](../packages/core/src/main.ts)                   | `runAfk` bin entry: parse flags, resolve dirs, optionally detach, then `runLoop([implementer, reviewer], inputs=planAndPrd)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`gh-main.ts`](../packages/core/src/gh-main.ts)             | `runGhAfk` bin entry: same shape, `runLoop([ghafkImplementer, reviewer], inputs="")`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [`loop.ts`](../packages/core/src/loop.ts)                   | `runLoop` — iteration driver: run log + claim check, wake-lock, signal handlers, `ensureImage` once, per-stage render→runStage with retries, sentinel gate, notify on terminal events.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [`run-log.ts`](../packages/core/src/run-log.ts)             | Per-run event log ([Run event log](#run-event-log)): writer, reducer, liveness, claim (`findLiveRun`, `findRunContainer`), retention (`pruneRunLogs`). Fully synchronous. **Internal.**                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [`render.ts`](../packages/core/src/render.ts)               | `renderTemplate` — expand the five tag forms; `resolveShell` picks the host shell for shell/spill tags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [`runner.ts`](../packages/core/src/runner.ts)               | Docker plumbing: `ensureImage` (sync + async overloads), `runStage`, `streamDocker`, socket detection/mount, provider volume mounts (`resolveAgentVolumeArgs`), stage containers ([Containers](#containers): `resolveContainerArgs` names `ralph-<runId>-i<iter>-s<stageIndex>-a<attempt>` and labels `ralph.run=<runId>`; `parseRunContainers` / `runningRunContainers` feed the claim check from one `docker ps --filter label=ralph.run`, 10 s timeout; `removeContainer` runs a detached `docker rm -f` on abort, decoder failure or grace-timer kill), image-ref helpers, `stageLogPath`, TTY-gated color exports. |
| [`stages.ts`](../packages/core/src/stages.ts)               | `STAGES` registry: `implementer` (afk.md), `ghafkImplementer` (ghafk.md), `reviewer` (review.md), all `bypassPermissions`; `Stage` type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [`agents/types.ts`](../packages/core/src/agents/types.ts)   | Provider-neutral adapter, command context, mount, decoder, and normalized render-event contracts, including `skillsMount`, `skillsMounted`, and `volumeMounts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [`agents/claude.ts`](../packages/core/src/agents/claude.ts) | Claude command/model resolution, the per-stage `claude update` wrapper + `ralph-claude-home` volume (`RALPH_CLAUDE_UPDATE`), selected credential mounts, `skillsMount` + the `--add-dir` skills root, and stream-json decoder.                                                                                                                                                                                                                                                                                                                                                                                          |
| [`agents/codex.ts`](../packages/core/src/agents/codex.ts)   | Codex command/model/config resolution, `CODEX_HOME`, per-stage `codex update` + `ralph-codex-cli` volume (`RALPH_CODEX_UPDATE`), selected credential mount, `skillsMount` (`~/.agents/skills`), and JSONL terminal contract.                                                                                                                                                                                                                                                                                                                                                                                            |
| [`agents/index.ts`](../packages/core/src/agents/index.ts)   | Provider registry plus `--agent`/`RALPH_AGENT` selection and validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [`index.ts`](../packages/core/src/index.ts)                 | Public barrel — see exact exports below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [`cli-help.ts`](../packages/core/src/cli-help.ts)           | `parseFlags`, `printHelp`, `printVersion`, `printConfig`, `readCoreVersion`. **Internal** (not exported from `index.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [`retry.ts`](../packages/core/src/retry.ts)                 | `withRetries`, `backoffFor`, `DEFAULT_BACKOFF_MS`, `DEFAULT_MAX_RETRIES`. **Internal.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [`keepalive.ts`](../packages/core/src/keepalive.ts)         | `acquire` — OS wake-lock, returns a `Releaser`; per-platform inhibitor. **Internal.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [`detach.ts`](../packages/core/src/detach.ts)               | `detachAndExit`, `stripDetachFlags` — fork loop into background, parent exits 0. **Internal.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [`notify.ts`](../packages/core/src/notify.ts)               | `notify`, `notifyComplete`, `notifyError` — OS toast + terminal bell. **Internal.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `__tests__/`                                                | Vitest suites for providers/decoders, CLI wiring, loop, runner/stream rendering, templates, and AFK machinery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`index.ts` re-exports **exactly**:

```ts
export { runAfk } from "./main.js";
export { runGhAfk } from "./gh-main.js";
export type {
  AgentName,
  AgentSelection,
  AgentSelectionSource,
} from "./agents/index.js";
export { runLoop, type LoopOptions } from "./loop.js";
export { STAGES, type Stage } from "./stages.js";
export {
  renderTemplate,
  type RenderOptions,
  type RenderVars,
} from "./render.js";
export { ensureImage, runStage } from "./runner.js";
```

Provider implementation details and `keepalive` / `detach` / `notify` / `retry` / `cli-help` are deliberately **not** part of the public surface.

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

- **SIGINT** → abort the active stage, record it (an `aborted` stage entry when one is open, then `run.ended aborted` with `signal`), `notifyError("interrupted (SIGINT)")` if `--notify`, release wake-lock, `process.exit(130)`.
- **SIGTERM** → abort active stage, record it the same way, `notifyError("terminated (SIGTERM)")` if `--notify`, release wake-lock, `process.exit(143)`.

Every record in a handler is wrapped: a failed append never blocks the release or changes the exit code. Aborting flows the `stageAbort.signal` into `runStage` / `ensureImage`; `streamDocker` and `runDockerCommand` listen for `abort` and **kill the docker child**, rejecting with an `AbortError`. `streamDocker` also starts a detached `docker rm -f <container>` (`removeContainer`), because killing the client does not stop the container. The wake-lock is released through a single `releaseOnce` guard shared by both handlers and the `finally` block, so the inhibitor child is killed exactly once. Handlers are removed via `process.off` in `finally`.

---

## Template renderer

[`render.ts`](../packages/core/src/render.ts). Templates live in [`../packages/core/templates`](../packages/core/templates). `renderTemplate(templatePath, vars, opts)` reads the file and applies six tag forms **in this fixed order** (order matters — `@spill` resolves before shell tags, and the try-shell regex matches before the plain one):

| #   | Tag                                        | Behavior                                                                                                                                                                                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `@include:<path>`                          | Inline a file via `readFileSync`. Relative paths resolve against the template's dir. **No shell.** Trailing newline trimmed. Used to inject the playbooks.                                                                                        |
| 2   | `@spill[?]:<name>=`<cmd[\|\|\|fallback]>`` | Run `cmd` on the host shell, write stdout to `spillHostDir/<name>`, and substitute the container-relative path `./<spillRefPath>/<name>` into the prompt. The `?` form treats non-zero exit as success and writes `fallback` instead of throwing. |
| 3   | `!?`<cmd[\|\|\|fallback]>``                | Try-shell. `execSync` with stderr suppressed; non-zero exit substitutes the literal `fallback` string. Matches **before** the plain `!` form.                                                                                                     |
| 4   | `!`<cmd>``                                 | Plain shell. `execSync` with `cwd = workspaceDir`. Failure **throws and aborts the iteration**.                                                                                                                                                   |
| 5   | `{{ INPUTS }}`                             | Replaced with `vars.INPUTS` (the `inputs` string passed to `runLoop`).                                                                                                                                                                            |
| 6   | `{{ HISTORY }}`                            | Replaced with `vars.HISTORY` — the last ten `.ralph/history/` stage entries (non-empty only for the implementer stage), substituted after the shell tags alongside `{{ INPUTS }}`.                                                                |

After `@include` expands trusted playbooks, the renderer keeps trusted source chunks separate from expanded data. Each shell/spill pass scans only source chunks. Command output, fallback strings, and inserted spill paths skip all later shell and variable passes, so tag-looking text in issue titles or commit messages stays verbatim after newline trimming. Only tags authored in the trusted template source can execute host commands.

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
!?`gh issue list --state open --limit 50 --json number,title,labels|||{"error":"GitHub issue query failed"}`
</issues-summary>

<issues-full-file>
Full issue bodies + comments spilled to:
@spill?:issues.json=`gh issue list --state open --limit 50 --json number,title,body,labels,comments|||{"error":"GitHub issue query failed"}`
</issues-full-file>
@include:ghprompt.md
```

The agent triages from the inline `<issues-summary>`, then `Read`s the spilled `issues.json` (with `offset`/`limit`) for bodies/comments before picking a task or deciding a candidate is completed or ineligible — so large issue bodies never bloat the prompt token count. Current labels, body, and comments take precedence over injected history, and eligibility follows the target repository's label conventions, including `ready-for-agent` where used. Issue closure requires evidence against the current acceptance criteria, including required platform verification; history alone is insufficient.

Both queries use an explicit error object on failure. The playbook requires a fresh `gh` lookup for missing, malformed, failed, or disagreeing views; if the current queue cannot be established, the agent reports **Blocked** without the no-more-tasks sentinel. The initial 50-issue limit is not evidence that the full queue is exhausted: the agent must check remaining issues before declaring no more tasks. These are agent playbook requirements; the loop still gates on the sentinel text rather than independently verifying GitHub state.

**[`review.md`](../packages/core/templates/review.md)** — `HEAD`, recent commits, `git show --stat HEAD` inline, and the **full HEAD patch spilled** to `head.diff`:

```
!?`git rev-parse HEAD|||(no commits)`
!?`git show --stat HEAD|||No diff`
Full patch spilled to: @spill?:head.diff=`git show HEAD|||No diff body`
```

The reviewer reviews only the latest commit; emits `<review>OK</review>` / `<review>SKIP</review>` and stops, or fixes defects and commits a new `fix(review): …` (never amends). It runs only when the implementer stage moved HEAD; otherwise the loop records a `skipped` history entry and starts no container.

---

## Docker runner

[`runner.ts`](../packages/core/src/runner.ts).

### `docker run` argv shape

`runStage` writes the rendered prompt to `<workspace>/.ralph-tmp/.run-<pid>-<iter>-<ts>.md` (referenced as `./.ralph-tmp/<file>` inside the container, sidestepping the Windows ~32 KB argv limit), then assembles:

```
docker run --rm -i \
  --name ralph-<runId>-i<iter>-s<stageIndex>-a<attempt> --label ralph.run=<runId> \
  -v <workspaceDir>:/home/agent/workspace \
  -w /home/agent/workspace \
  -e GIT_CONFIG_COUNT=<1 or 3> \
  -e GIT_CONFIG_KEY_0=safe.directory \
  -e GIT_CONFIG_VALUE_0=* \
  [ -e GIT_CONFIG_KEY_1=user.name  -e GIT_CONFIG_VALUE_1=<host user.name> \
    -e GIT_CONFIG_KEY_2=user.email -e GIT_CONFIG_VALUE_2=<host user.email> ] \
  [ selected-provider credential mounts and env ] \
  [ -v <HOME>/.config/gh:/home/agent/.config/gh:ro ] \
  [ -v <core>/templates/skills:/home/agent/ralph-skills/.claude/skills:ro | :/home/agent/.agents/skills:ro ] \
  [ --mount type=volume,source=ralph-claude-home,target=/home/agent/.local,volume-label=ralph.kind=claude-home ] \
  [ --mount type=volume,source=ralph-codex-cli,target=/home/agent/.npm-global,volume-label=ralph.kind=codex-cli ] \
  [ -v <sock>:/var/run/docker.sock  --group-add <gid|0> ] \
  [ -v ralph-nm-<hash>:/home/agent/workspace[/<pkg-dir>]/node_modules … ] \
  [ -v ralph-pm-store:/home/agent/.pm-store \
    -e npm_config_store_dir=/home/agent/.pm-store/pnpm \
    -e npm_config_cache=/home/agent/.pm-store/npm ] \
  <IMAGE_REF> <selected-provider argv>
```

The selected-provider argv is one of:

```bash
# Claude (default) — the bash -c wrapper is dropped under RALPH_CLAUDE_UPDATE=0
bash -c 'claude update 1>&2 || true; exec "$0" "$@"' \
  claude --add-dir /home/agent/ralph-skills \
  --verbose --print --output-format stream-json \
  --permission-mode bypassPermissions \
  [--model "<tuned model, else host ~/.claude/settings.json model, else claude-opus-5[1m]>"] \
  [--effort "<tuned effort, else none — the container CLI applies the host effortLevel>"] \
  "Read the full instructions from the file ./.ralph-tmp/<run-file> in the current workspace and execute them."

# Codex (isolated configuration by default) — the setup script's `codex update`
# step is dropped under RALPH_CODEX_UPDATE=0
bash -c 'mkdir -p "$CODEX_HOME"; codex update 1>&2 || true; <copy creds into $CODEX_HOME>; exec "$0" "$@"' \
  codex exec --json --ephemeral \
  --dangerously-bypass-approvals-and-sandbox \
  --ignore-user-config \
  --model "<tuned model, else gpt-5.6-sol>" \
  -c 'model_reasoning_effort="<tuned effort, else high>"' \
  "Read the full instructions from the file ./.ralph-tmp/<run-file> in the current workspace and execute them."
```

For Claude, the `bash -c` wrapper runs `claude update` before the stage's own command
(`exec "$0" "$@"` re-execs the argv that follows the script, `claude` being `$0`): the
image's CLI is a build-time snapshot while Claude Code releases roughly daily. The update's
report is redirected to stderr — it surfaces on the host as dim `docker  Checking for updates
to latest version...` / `docker  Claude Code is up to date (…)` lines — so stdout stays
reserved for the stream-json the runner decodes; a failed update (offline, registry down)
falls through to the installed version (`|| true`). The updated CLI persists across
containers in the `ralph-claude-home` volume described under the mounts below; measured cost
is one ~200 MB download (~20–35 s) for the first stage on a host, then a ~2 s version check
per stage. `RALPH_CLAUDE_UPDATE=0` drops both the wrapper and the volume mount, so the stage
runs the image's baked CLI (a stale volume left mounted would shadow a fresher image).

Codex works the same way, for a sharper reason: the server rejects models its CLI predates
(`The 'gpt-6-astra' model requires a newer version of Codex`, HTTP 400), which kills every
stage of a run. Its setup script leads with `codex update 1>&2 || true;` ahead of the
credential copy and the same `exec "$0" "$@"` re-exec, and the updated CLI persists in the
`ralph-codex-cli` volume mounted over `/home/agent/.npm-global` — the agent-owned npm prefix
the image installs `@openai/codex` into, so `npm` can replace it without root.
`ARG CODEX_VERSION` is therefore the floor the volume is seeded from, not the version
that runs.
`RALPH_CODEX_UPDATE=0` drops the update and the mount together.

Flag/environment tuning is resolved once per run by `resolveAgentTuning`
(`agents/index.ts`) and handed to every stage. Each field takes the first source
that is set, blank and whitespace-only counting as unset: `--model` / `--effort`,
then `RALPH_<AGENT>_MODEL` / `RALPH_<AGENT>_EFFORT`, then `RALPH_MODEL` /
`RALPH_EFFORT`. The per-agent names are built from the agent name
(`RALPH_${agent.toUpperCase()}_MODEL`), so a new provider gets its pair without a
table edit. Model and effort resolve independently: setting one never moves the
other off its default. Each tuned value carries the literal flag or variable
name it came from, which `--print-config` prints and `run.started` records.

Provider-owned resolution happens later, once per attempted stage. Inside the
`withRetries` closure and before `renderTemplate`, `loop.ts` synchronously calls
`resolveAgentConfigSnapshot` to combine the run-level tuning with the selected
adapter's current defaults or host configuration. It immediately writes one
plain stderr line:

```text
attempt 1 · codex · configured model=gpt-5.6-sol (Ralph default) · effort=high (Ralph default)
```

The same `AgentConfigSnapshot` is passed through `RunStageOptions` and
`AgentCommandContext` to command construction. This ownership boundary matters:
`runStage` can await volume preparation, but the adapter must not reread mutable
host settings afterward and make argv disagree with the displayed line. A retry
takes a new snapshot, so a changed host Claude setting applies to the next
attempt. Rendering failures still have a line because snapshotting and display
happen first; skipped stages never enter the closure and have none. Direct
`runStage` and adapter callers may omit the optional snapshot, preserving their
existing on-demand resolution behavior.

The word `configured` describes Ralph's request, not the backend's verified
execution model or reasoning mode. An absent snapshot value is rendered as
`provider-managed (<source>)` and omitted from argv: this covers Claude effort
without an explicit tuning value, Claude model selection under Bedrock, Vertex,
or Foundry routing, and untuned Codex fields inherited from user config. Ralph
does not inspect the provider afterward, discover aliases, or infer Codex TOML
values. C0/C1 control characters in displayed values and sources are escaped to
visible text (`\\n`, `\\r`, `\\t`, or `\\uNNNN`) so redirected stderr and
detached logs remain one record per attempt. Sanitization is display-only; the
snapshot's original value is passed unchanged in argv. The attempt line itself
contains no ANSI styling.

`--print-config` and `run.started` remain run-start descriptions and the event
schema is unchanged. For mutable provider settings, an attempt line can
legitimately differ from `run.started`; it is the authoritative attempt-time
description for that attempt.

`validateAgentTuning` checks the effort against the selected adapter's `effortLevels` —
Claude `low|medium|high|xhigh|max` (`ultracode` is left out deliberately: it starts
workflow orchestration an unattended stage cannot steer), Codex
`none|minimal|low|medium|high|xhigh|max|ultra`. Ultra is a provider-wide input here,
not a model compatibility claim: Ralph forwards it unchanged as
`-c 'model_reasoning_effort="ultra"'`, and Codex owns model, client, and account
validation. Ralph adds no model discovery, fallback, effort downgrade, or delegation
switch. An effort that came from the agent-agnostic
`RALPH_EFFORT` is checked against `SHARED_EFFORT_LEVELS`, the intersection of every
adapter's list, so a value that works today keeps working after an agent switch; the
message names the provider's own variable when only that provider knows the level.
`runLoop` runs the check as the first statement of its `try`, after `run.started` is
fsynced and before `ensureImage`, so a bad level ends the run with `run.ended`
`reason: "error"` and exit 1 without starting a container — and a supervisor that cannot
read Ralph's stderr still finds the reason in the log. `runStage` repeats the check on every
stage — it is the guard for a direct library caller that passes no tuning, and one site covers
both providers, since the level is interpolated into Claude's argv and into Codex's TOML
string. `--print-config` never throws: it shows a rejected level with an
`invalid: allowed …` suffix and exits 0.

For Claude, the `--model` value resolves as the tuned model → the model pinned by the
host's `~/.claude/settings.json` (`env.ANTHROPIC_MODEL`, else the `model` key `/model`
stored; its "(default)" entry stores no model) → `DEFAULT_CLAUDE_MODEL`
(`claude-opus-5[1m]`). Ralph sends the flag rather than deferring to the container: the
sandbox CLI's own built-in default is frozen at image build time (the per-stage
`claude update` refreshes it, but not under `RALPH_CLAUDE_UPDATE=0` or offline) and can lag the host
CLI's across model transitions, so an omitted `--model` silently downgrades the run.
`env.ANTHROPIC_MODEL` is read because the bind-mounted settings file applies it inside
the container, where `--model` would otherwise outrank it.

The flag is omitted in exactly one case: host settings that enable
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY`. Those
providers use their own model identifiers (Bedrock inference-profile IDs such as
`us.anthropic.claude-opus-4-8`), so a first-party default would be rejected and the
container CLI resolves the model as it did before. A settings file that exists but
cannot be read or parsed is reported on stderr and in `--print-config` instead of being
treated as "no model chosen". `--effort` is not omitted there: it is a CLI setting rather
than a model ID. Ralph has no effort default for Claude, so with none tuned no `--effort`
is sent and the container CLI applies whatever the host settings' `effortLevel` says —
reported as `Claude CLI default`.

For isolated Codex, `--model` defaults to `DEFAULT_CODEX_MODEL` (`gpt-5.6-sol`) and
`-c 'model_reasoning_effort="<level>"'` to `DEFAULT_CODEX_REASONING_EFFORT` (`high`),
independently of one another: a tuned model no longer drops the effort to the Codex CLI's
own default, as it did before this behavior change. With an explicit model, Codex owns
validation and a failure is terminal for that stage attempt—Ralph never retries with
another model. `--codex-user-config` removes `--ignore-user-config`; there an untuned model
and an untuned effort both come from `~/.codex/config.toml`, while a tuned one is still
sent as `--model` / `-c`.

- **Workspace mount + `-w`:** the host workspace is mounted read-write and set as the container's working directory.
- **Container-local `node_modules`:** [`sandbox-volumes.ts`](../packages/core/src/sandbox-volumes.ts) decides one docker volume per package directory of the workspace (root plus each nested `package.json`, walked four levels deep, skipping `node_modules/` and dot dirs) plus the shared `ralph-pm-store` store volume, so an install inside the sandbox writes a Linux tree into a volume instead of the bind mount (#128). Volume names are `ralph-nm-<sha256 prefix>` of workspace + relative path; provenance lives in the labels `ralph.kind=node-modules`, `ralph.workspace=<host dir>`, `ralph.path=<rel dir>` (the store volume carries `ralph.kind=pm-store`). `runStage` lists, creates and — because a fresh volume mounts `root:root` while the sandbox runs as UID 1000 — hands them to the sandbox user with one `docker run --rm --user 0:0 --entrypoint chown` container, once per process, failing the stage with a message naming `RALPH_ISOLATE_NODE_MODULES=0` if any step fails. Off on Linux by default; see the environment-variable table.
- **Git env injection:** `resolveGitConfigArgs(workspaceDir)` builds the whole `GIT_CONFIG_*` block. Entry 0 always forces `safe.directory=*` so git works against a bind-mount whose UID differs from the container user (a Windows-host pain point). Entries 1–2 carry `user.name`/`user.email`, read on the **host** with `git -C <workspaceDir> config --get` so git's own repo-local-over-global precedence decides and an identity a repo deliberately sets for itself is never clobbered. The container never sees the host's `~/.gitconfig`, so without that pair a commit inside the sandbox dies on `unable to auto-detect email address (got 'agent@<cid>.(none)')` and the agent invents an author to get past it — repos carrying a local identity inside the bind-mounted `.git/config` were immune by accident, every other repo got commits attributed to a fabricated name. If the host resolves only one of the pair, or neither, no identity is injected and the runner warns once per process on stderr; fabricating one in the harness would be the same bug wearing a different hat.
- **Credential mounts** (only if the host path exists, resolved against `HOME || USERPROFILE`) are selected-provider-only: Claude mounts `~/.claude` and `~/.claude.json` (**rw**); Codex mounts `~/.codex` (**ro**) at `/mnt/codex-creds` and injects `CODEX_HOME=/home/agent/.codex` — a setup script wrapped around the `codex` invocation copies `auth.json`, `config.toml`, and `AGENTS.md` (when present) into the container-local `CODEX_HOME` before exec, because a bind-mounted `CODEX_HOME` cannot host the unix socket / symlinks Codex creates at startup (EPERM on Docker Desktop for Windows). Codex's `auth.json` is a reusable secret available to the process. Both may mount `~/.config/gh` (**ro**).
- **Shipped skills mount:** `runStage` also mounts the installed core package's `templates/skills` directory (today one skill, `ralph-tdd`) at the container path the selected adapter's `skillsMount` returns, always **read-only**: `/home/agent/ralph-skills/.claude/skills` for Claude — whose argv then carries `--add-dir /home/agent/ralph-skills` — and `/home/agent/.agents/skills` for Codex. Both are container-local paths outside every bind mount, so no host directory is created and nothing lands in the workspace; the mount is added only when the host directory exists (`resolveSkillsMountArgs`).
- **Claude home volume:** for Claude, `runStage` also mounts the named volume `ralph-claude-home` at `/home/agent/.local` — where the native installer keeps `~/.local/share/claude/versions/<ver>` and the `~/.local/bin/claude` launcher symlink — so the CLI that `claude update` installs persists across containers. The adapter declares it via `volumeMounts()` and `resolveAgentVolumeArgs` emits it as `--mount type=volume,source=ralph-claude-home,target=/home/agent/.local,volume-label=ralph.kind=claude-home`, right after the skills mount and before the `node_modules` volumes. Unlike those, it needs no `chown` or other preparation: docker creates it on first use and seeds it from the image's `/home/agent/.local`, already owned by the sandbox user. It is host-wide — one volume shared by every workspace and both bins, because it is a cache (two loops running at once share it; a concurrent update is a benign race) — and `docker volume ls --filter label=ralph.kind` lists it alongside the `node_modules` volumes; `docker volume rm ralph-claude-home` clears it. `RALPH_CLAUDE_UPDATE=0` drops the mount together with the update.
- **Codex CLI volume:** for Codex, the same mechanism keeps the CLI itself: the named volume `ralph-codex-cli` is mounted at `/home/agent/.npm-global` — the npm prefix the image installs `@openai/codex` into as `agent`, so `codex update` can replace it without root — and `resolveAgentVolumeArgs` emits it as `--mount type=volume,source=ralph-codex-cli,target=/home/agent/.npm-global,volume-label=ralph.kind=codex-cli`. Like the Claude volume it needs no `chown` (docker seeds it from the image, already owned by the sandbox user), is host-wide because it is a cache, is listed by `docker volume ls --filter label=ralph.kind`, and is cleared with `docker volume rm ralph-codex-cli`. `RALPH_CODEX_UPDATE=0` drops the mount together with the update.
- **Stage container name + label:** where the volumes carry `ralph.kind`, each stage container carries `ralph.run=<runId>` (`resolveContainerArgs`, right after `run --rm -i`) and is named `ralph-<runId>-i<iter>-s<stageIndex>-a<attempt>`, one name per attempt. `docker ps -q --filter label=ralph.run=<runId>` lists a run's stage containers, orphans included; the volume `chown` helper and containers the agent starts through `docker.sock` carry no label. See [Run event log § Containers](#containers).
- **Approval bypass** is provider-specific: Claude receives stage `permissionMode=bypassPermissions`; Codex receives `--dangerously-bypass-approvals-and-sandbox`.

On Windows, the generic `HOME || USERPROFILE` resolution is a supported native
launch path for both providers: the Codex credential home never sits on the
NTFS bind mount (credentials are copied into the container-local `CODEX_HOME`
instead), so the historical `chmod`/`fchmod`/unix-socket `EPERM` failures do
not apply. Follow the same-shell rule — log in with the host CLI from the same
environment that launches Ralph. For `ralph-ghafk` under WSL, export
`GH_CONFIG_DIR="$HOME/.config/gh"` so the provider-independent GitHub config is
the one mounted read-only.

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

**Opt-out:** `RALPH_DOCKER_SOCK=0`. **Security note:** mounting `docker.sock` grants the selected agent, which runs without interactive approval, root-equivalent access to the host Docker daemon. Disabling the mount removes host-Docker control, but persistent host-write exposure still includes the workspace and selected provider's read-write credential store; `~/.config/gh` remains read-only.

### Image resolution — `ensureImage`

`docker image inspect` → `docker pull` → `docker build` (fallback). The build fallback runs **only** if pull fails **and** a Dockerfile exists at the build context. `isFloatingRef(ref)` returns `true` for `:latest` or an untagged ref (and `false` for a `@sha256:` digest pin); a **floating ref is always re-pulled even when cached**, so republishing `:latest` (e.g. a newer .NET SDK) reaches users. `resolveDockerfile(ctx)` prefers `ctx/templates/Dockerfile`, then `ctx/Dockerfile`. `IMAGE_REF` = `RALPH_IMAGE` → `RALPH_IMAGE_TAG` (legacy) → `docker.io/daonhan/ralph-sandbox:latest`. `ensureImage` has a sync overload and an async (`{ signal }`) overload; `loop.ts` uses the async one so a signal can abort the pull/build.

### Provider JSONL streaming — `streamDocker`

`spawn("docker", args, { stdio: ["ignore","pipe","pipe"] })`. stdout is read line-by-line; lines starting with `{` are appended to the NDJSON log (each one also calls `onOutput`, the loop's last-output clock) and `JSON.parse`d. The selected adapter decodes provider-specific JSONL into `init`, `assistant`, `thinking`, `tool-start`, `tool-result`, and `diagnostic` events plus an optional terminal `completion` or `failure`:

- **assistant text** → printed to **stdout** with a `●` bullet (the visible answer stream).
- **tools / thinking / init / diagnostics** → rendered to **stderr** (tool name + truncated input/result preview + elapsed ms).
- **Claude terminal contract:** a `result` event supplies its `result` string as completion.
- **Codex terminal contract:** the last completed `agent_message` becomes the completion only when `turn.completed` arrives. `turn.failed` and fatal `error` records reject immediately; a transient `Reconnecting… X/Y` `error` notice renders as a diagnostic and the turn continues; `turn.completed` without a final agent message rejects; a clean process exit without `turn.completed` also rejects.

Color is **TTY-gated and stream-split**: `USE_COLOR` (stderr) and `USE_COLOR_STDOUT` (stdout) are independent, so `ralph-ghafk 1 > out.txt` stays clean even on a TTY. ANSI is disabled when `NO_COLOR` is set or `TERM=dumb`.

**Post-completion grace timer:** when either decoder emits completion, a one-shot timer (`RALPH_RESULT_GRACE_MS`, default **30000 ms**; `0` disables) is armed. If the docker child emits its terminal JSONL but never exits, the timer kills the child, removes its container (`removeContainer`), and resolves with the captured completion so the loop is not hung. A decoder `failure` kills and removes the same way. On non-zero exit, `streamDocker` rejects with the last ~40 stderr lines.

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

Separately, `runLoop` writes one Markdown history file per run under `<workspace>/.ralph/history/<yyyy-MM-dd-HHmmss>-<bin>[-<branch>].md` (self-gitignored via its own `*` `.gitignore`, written once): a header on open, one entry per completed stage, a footer with run totals on exit. At every exit that writes the footer (`no-more-tasks`, `cap`, `failed`; not a signal, a thrown error or a refused launch) the driver also runs the sandbox-install check ([`host-check.ts`](../packages/core/src/host-check.ts): a `node_modules/.modules.yaml` store path under `/home/agent/`, a stray `.pnpm-store/`), printing the `[warning]` block on stderr and appending ` · warning: sandbox-install` to the footer. The last ten entries across all runs are loaded back into the implementer prompt as `{{ HISTORY }}`. Beside each `.md` sits the run's event log, `<same base name>.jsonl` (see [Run event log](#run-event-log)); it opens before image setup, so an image failure leaves a `.jsonl` ending `run.ended error` and no `.md`. This is harness-owned — only [`history.ts`](../packages/core/src/history.ts) and [`run-log.ts`](../packages/core/src/run-log.ts), driven by `loop.ts`, write here (`fs`, tolerant `git` reads and the `tasklist` / `ps` pid probes; neither module calls Docker).

---

## Run event log

[`run-log.ts`](../packages/core/src/run-log.ts), appended to only by `loop.ts`. Each run writes an append-only event log beside its Markdown history: one JSON record per line, numbered by `seq`, written and **fsynced before the loop acts on it**. It is the run's durable state. A supervisor reads the file to tell whether a run is still going, how it ended, and how long its stage and agent have been silent. `reduceRunLog` folds the log into a disposable `RunView`, and the writer keeps the same view with the same fold, so the view can always be rebuilt from the file. The reducer is not exported from the package index; readers parse the file. Ralph reports ages only: judging "stuck" is the reader's call.

### File and naming

- **Path:** `<workspace>/.ralph/history/<yyyy-MM-dd-HHmmss>-<bin>[-<branch>].jsonl`, with a UTC timestamp, the short bin (`afk` / `ghafk`) and the sanitized branch (`[A-Za-z0-9._-]`). The base name is the `runId`, and the run's `.md` history shares it.
- **Create:** `openSync(path, "wx", 0o600)`. Opening also creates `.ralph/history/` and its `*` `.gitignore` when they are missing.
- **Same-second rule:** when the name already exists (`EEXIST`, two runs in one UTC second), the timestamp advances one second and the open retries, up to 60 times. There is never a `-2` suffix: `-` (0x2D) sorts before `.` (0x2E), so a suffixed name would sort before its base name in ordinal order, and PowerShell's culture-aware `Sort-Object` may order it differently again. Advancing the second keeps name order equal to run order for every "newest by name" reader (`loadHistoryTail`, the claim check, a supervisor).

### Opening order

`runLoop` runs, in order:

1. the `--codex-user-config` check;
2. the version banner;
3. `openRunLog`, which appends `run.started`;
4. the claim check, then `pruneRunLogs` (below);
5. the wake-lock `acquire()` and the `SIGINT` / `SIGTERM` handlers;
6. inside `try`: the heartbeat timer, then `ensureImage`;
7. once the image is ready, the `.md` history.

A failed open therefore leaks no wake-lock or handler, and a hung `docker pull` shows as a log with `run.started` and heartbeats but no `stage.started`. An image failure leaves no `.md`; the log records `run.ended` with `reason: "error"`. Nothing between `openRunLog` and the first `runStage` awaits except `ensureImage`: the loop tests count microtask turns, so a new `await` there breaks them.

### Records (schema v1)

Every line is `{"v":1,"seq":<n>,"at":"<ISO time>","type":"<type>", …fields}`. `seq` starts at 1 with `run.started` and grows by one per record.

| `type`            | Fields                                                                                                                                                                    | Written                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `run.started`     | `runId, pid, hostname, platform, wslDistro?, bin` (`afk` / `ghafk`), `agent, iterations, inputs, branch?, version` (core), `model?, modelSource?, effort?, effortSource?` | once, on open                                                      |
| `stage.started`   | `iteration, stageIndex, stage, logPath, container` (the first attempt's name)                                                                                             | before a stage's first attempt; never for a `skipped` stage        |
| `stage.retry`     | `iteration, stage, attempt` (the failed one, 1-based), `error, backoffMs, container` (the **next** attempt's name)                                                        | after each failed attempt that will be retried, before its backoff |
| `stage.completed` | the `StageEntry`: `iteration, stage, status, durationMs, head, logPath, body, meta?, retries?, attempts?, dirty?`                                                         | once per stage, `skipped` and `aborted` included                   |
| `heartbeat`       | `lastOutputAt`: when the agent last wrote a JSON line to stdout (ISO), or `null` before its first                                                                         | every `HEARTBEAT_MS` (30 s) while the run is open                  |
| `run.ended`       | `reason` (`no-more-tasks` / `cap` / `failed` / `aborted` / `error` / `refused`), `completedIterations, signal?, blockedBy?, findings?, error?`                            | once; closes the file                                              |

- `stage.completed.status` is one of `ok`, `no-more-tasks`, `review-ok`, `review-skip`, `review-fix`, `error`, `failed`, `skipped` or `aborted`.
- On `run.ended`: `signal` (`SIGINT` / `SIGTERM`) comes with `aborted`; `blockedBy` with `refused`; `findings` are the sandbox-install findings, present only when there are some; `error` is the thrown message behind `reason: "error"`.
- `stage.retry` duplicates what `stage.completed.attempts` records later, but it is the only in-flight sign that a silent stage is waiting out a backoff.
- A container name in a record may never have started, for example when rendering fails before `docker run`.
- `run.started`'s `model`, `modelSource`, `effort`, `effortSource` are optional: they are not in the required-field list below, so a log written before they existed still folds, and all four absent is how a consumer detects a Ralph too old to have honored a requested model or effort. `model` / `effort` are absent when the container CLI supplies that value (Claude under third-party routing, Codex under `--codex-user-config`); the two `*Source` fields carry either the literal flag or variable the value came from (`--effort`, `RALPH_CODEX_EFFORT`, `RALPH_MODEL`) or a default label (`Ralph default`, `host ~/.claude/settings.json`, `host provider config`, `Claude CLI default`, `user config`).

An abridged log:

```jsonl
{"v":1,"seq":1,"at":"2026-09-17T10:15:00.120Z","type":"run.started","runId":"2026-09-17-101500-ghafk-feat-x","pid":18244,"hostname":"DESKTOP-1","platform":"win32","bin":"ghafk","agent":"claude","iterations":5,"inputs":"","branch":"feat-x","version":"0.16.0","model":"claude-opus-5[1m]","modelSource":"Ralph default","effortSource":"Claude CLI default"}
{"v":1,"seq":2,"at":"2026-09-17T10:15:30.121Z","type":"heartbeat","lastOutputAt":null}
{"v":1,"seq":3,"at":"2026-09-17T10:15:41.803Z","type":"stage.started","iteration":1,"stageIndex":0,"stage":"ghafk-implementer","logPath":".ralph-tmp/logs/2026-09-17T10-15-41-800Z-iter1-ghafk-implementer.ndjson","container":"ralph-2026-09-17-101500-ghafk-feat-x-i1-s0-a1"}
{"v":1,"seq":4,"at":"2026-09-17T10:16:11.804Z","type":"heartbeat","lastOutputAt":"2026-09-17T10:16:09.310Z"}
{"v":1,"seq":61,"at":"2026-09-17T10:41:02.412Z","type":"stage.completed","iteration":1,"stage":"ghafk-implementer","status":"ok","durationMs":1520609,"head":"abc1234","logPath":".ralph-tmp/logs/…","body":"…","meta":{"turns":41,"costUsd":1.12}}
{"v":1,"seq":240,"at":"2026-09-17T12:02:55.019Z","type":"run.ended","reason":"cap","completedIterations":5}
```

### Reducer

`reduceRunLog(text)` returns `{ events, view, truncated }`; `applyEvent(view, record)` is pure. Folding stops at the first line with any of these problems, keeping every record before it and setting `truncated`:

- it has no trailing newline (a torn tail);
- it is not JSON, or not an object;
- `v !== 1`;
- its `seq` is not the previous `seq + 1`;
- `at` or `type` is not a string;
- it is `run.started` anywhere but first, or anything else first;
- it comes after `run.ended`;
- it is a known type missing a required field:
  - `run.started`: `runId, hostname, platform, bin, agent, inputs, version` (strings), `pid, iterations` (numbers);
  - `stage.started`: `iteration, stageIndex` (numbers), `stage, logPath, container` (strings);
  - `stage.retry`: `iteration, attempt, backoffMs` (numbers), `stage, error, container` (strings);
  - `stage.completed`: `iteration, durationMs` (numbers), `stage, status, head, logPath, body` (strings);
  - `heartbeat`: `lastOutputAt` (string or `null`);
  - `run.ended`: `reason` (string), `completedIterations` (number).

**Forward compatibility:** an unknown `type` is skipped without stopping (it still uses up its `seq`), so new event types are additive within v1. **Version bump:** from the first published v1 on, adding a required field to a known type bumps `v`; a new optional field does not. A v1 reader stops at a `v: 2` line, and the claim judges such a log by its mtime (see [Liveness](#liveness)).

`RunView` holds:

- `started`: the `run.started` fields plus `at`;
- `stage`: the open stage (`iteration, index, name, startedAt, logPath, container`, plus the last `retry { attempt, at, backoffMs }`). A retry moves `container` to the next attempt's name. `stage.completed` and `run.ended` clear it;
- `lastEventAt`, `lastHeartbeatAt`, `lastOutputAt`;
- `entries`: the completed `StageEntry`s;
- `statusCounts`: completed stages per status. `run.ended.reason` reflects only the last iteration, so a mid-run `failed` or `error` shows up here;
- `ended`.

### Heartbeat

`setInterval(…, HEARTBEAT_MS).unref()` starts as the first statement in the loop's `try`, so it also covers image setup, and is cleared in `finally`. `lastOutputAt` comes from `RunStageOptions.onOutput`, which `streamDocker` calls for each stdout line it appends to the NDJSON stage log. It is never reset between stages: it is the last output of any stage, `null` until the first. A synchronous template shell tag or `docker volume` probe can delay a heartbeat, which is why same-host liveness goes by pid rather than heartbeat age.

### Writer and append failures

`append(event)`:

1. On a closed log it is a no-op; on a broken log it throws.
2. It builds `{ v: 1, seq: seq + 1, at: now, ...event }` and writes the line with `writeFileSync(fd, line)`, which loops on partial writes. If the write throws, part of the line may be on disk and a reader stops there, so the writer is marked **broken** and the error rethrown: every later append throws too.
3. The line is on disk: `seq` advances and the record folds into the view.
4. `fsyncSync(fd)`. A throw here propagates with the record already counted, so the next record's `seq` follows it and the file still folds.
5. `run.ended` closes the file in a `finally` around the fsync, whether or not the fsync threw; later appends are no-ops. The loop's `finally` closes it too.

| Failing append                                                       | Effect                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The open, or `run.started`                                           | Thrown before anything is acquired; the bin exits 1.                                                                                                                                                                                       |
| `run.ended refused` in a refusal                                     | `refuse` closes the log anyway, so this process stops counting the runId as a run it has open and a later launch in the same process is not refused by it; the error is thrown, so the bin exits 1.                                        |
| `stage.started`, `stage.completed` or `run.ended` on the normal path | The run fails closed: the loop's `catch` tries `run.ended error` (wrapped) and rethrows, so the bin exits 1. After a failed write that end record throws too, so the log has no `run.ended` and its pid reads dead once the process exits. |
| `stage.retry`                                                        | `onAttempt` stores the error (`retryLogError`) and rethrows it, so `withRetries` rejects at once: no backoff, no further attempt, no `failed` stage entry. The run then fails closed as above.                                             |
| Any append in a signal handler                                       | Wrapped: the wake-lock is still released exactly once and the exit code is still 130 / 143.                                                                                                                                                |
| `heartbeat`                                                          | Warns once (`[warning] run log heartbeat failed: <msg>`) and never throws from the timer. After a failed fsync the run goes on; after a failed write the writer is broken, and the run fails closed at its next event.                     |

### Liveness

`runLiveness(view, mtimeMs, probe)` returns `"ended"`, `"live"` or `"dead"`:

1. **`ended`:** the log has `run.ended`.
2. **`dead`:** no readable `run.started` (an empty file, a torn first line, a wrong first event).
3. **Same host** (`hostname`, `platform` and `wslDistro` all equal the reader's; WSL and Windows share a hostname but not a pid space):
   - **Own process:** when `started.pid` is the reader's own pid, the log is `live` only if this very process has that runId's log open (a module-level set that `openRunLog` adds to and `close()` removes from). A relaunch that inherits a killed run's pid does not refuse itself, and two `runLoop`s in one process still refuse each other.
   - **Any other pid:** `live` when `pidAlive(pid)` and `pidIsNode(pid)`, however old the last record. A hung but running run still blocks a relaunch; stopping it is the supervisor's job.
   - `pidAlive`: `process.kill(pid, 0)`, with `EPERM` counting as alive; a non-integer or non-positive pid is dead.
   - `pidIsNode` guards against a dead run's pid being reused, which happens often on Windows. win32: `tasklist /FI "PID eq <pid>" /FO CSV /NH`, image name contains `node`; Linux: `/proc/<pid>/comm`; others: `ps -p <pid> -o comm=`. `tasklist` and `ps` run with a 10 s timeout. It reads false only when the process is shown gone or another program (no row, `ENOENT` on `/proc`, `ps` status 1); any other probe failure, a timeout included, reads true, erring toward refusal.
4. **Another host or platform:** `live` while the file's mtime is less than `STALE_AFTER_MS` (5 min) old. A pid from another pid space is never probed.
5. **Newer schema** (in `findLiveRun`): a log with no readable `run.started` whose first complete line is a JSON object with a numeric `v > 1` is `live` while its mtime is under 5 min, otherwise `dead`.

Ralph versions from before the log write no `.jsonl`, so they are invisible to the claim.

### Claim check: one live run per workspace

In `runLoop`, synchronously, right after `run.started` is fsynced:

1. **Live run.** `findLiveRun(historyDir, runId)` reads **every** other `.jsonl`, oldest first, so a torn or dead newer log cannot hide a live older one; an unreadable log is skipped. A live run refuses the launch:

   ```
   [refused] another ralph run is live in this workspace: pid <pid> on <host>, started <at>, last event <age> ago (<path>)
   [refused] another ralph run is live in this workspace: written by a newer ralph (<path>)
   ```

   The second form is for a newer-schema log, which has no readable `run.started`.

2. **Running container.** Otherwise `findRunContainer(historyDir, runId, runningRunContainers())` asks docker. `runningRunContainers` runs one `docker ps --filter label=ralph.run --format '{{.Label "ralph.run"}} {{.Names}}'` with a 10 s timeout; no docker, a stopped daemon, a non-zero exit or a timeout reads as no containers. `parseRunContainers` reads each non-empty line as `<runId> <name>`. The first container whose runId is another run with a `<runId>.jsonl` in this history dir refuses the launch:

   ```
   [refused] run <runId> still has a running container (<name>); remove it: docker rm -f $(docker ps -aq --filter label=ralph.run=<runId>)
   ```

   This catches a killed host node whose container kept running, and committing: its log reads dead by pid. Matching is by runId from the history dir, never by path, so Windows and WSL launches share it.

3. Otherwise `pruneRunLogs` runs and the launch proceeds.

A refusal (the `refuse` helper) prints the `[refused]` line on stderr, appends `run.ended { reason: "refused", completedIterations: 0, blockedBy }`, prunes, and resolves `"refused"`, so the bin exits 75. Nothing has been acquired: no wake-lock, no handlers, no image, no `.md`. **`blockedBy`** names the run that blocked the launch: a live run, or a run whose container still runs (that run may be dead or ended).

**Why it races safely.** The check runs after the run's own `run.started` is on disk, so two launches racing each other each see the other's live log and both refuse; they never both proceed. A check before the file exists would reopen the check-then-create race, so `runBin` has none, and a `--detach` refusal lands in the detach log and the `.jsonl`. Callers retry exit 75 after a jittered wait, so two refused callers do not collide again.

### Exit codes

| Exit          | Run end                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`           | `no-more-tasks`, `cap`                                                                                                                                                                                             |
| `1`           | `failed`: the last iteration's stage exhausted its retries (`EXIT_CODES` in [`run-bin.ts`](../packages/core/src/run-bin.ts)). Also any thrown error: `run.ended error`, or a failed log open with no readable log. |
| `75`          | `refused` (EX_TEMPFAIL, "try again later")                                                                                                                                                                         |
| `130` / `143` | `SIGINT` / `SIGTERM`, logged as `run.ended aborted` with `signal`                                                                                                                                                  |

`runLoop` resolves with `no-more-tasks`, `cap`, `failed` or `refused`; it throws on errors, and the signal handlers exit the process. A reader trusts `run.ended.reason` over exit code 1. `failed` keeps the footer's meaning, so a failure in an earlier iteration still ends `cap`; `statusCounts` and the `stage.completed` records expose it. With `--detach` the parent exits 0 at once; these codes are the detached child's.

### Containers

- **Name and label:** each stage attempt runs as `ralph-<runId>-i<iteration>-s<stageIndex>-a<attempt>` with the label `ralph.run=<runId>` (`resolveContainerArgs`, spliced right after `docker run --rm -i`). The loop counts attempts itself, because a killed client can leave the previous attempt's container behind, so a retry must not reuse its name. There is no workspace label: path strings differ between Windows, WSL and Docker Desktop's mount form, so containers are matched by runId only.
- **Finding them:** `docker ps -q --filter label=ralph.run=<runId>` lists a run's stage containers, orphans included.
- **The runner removes what it abandons.** `streamDocker` routes its three kills through one `abandon()` helper: `onAbort` (run synchronously from the loop's signal handler, before `process.exit`), a decoder failure, and the grace timer. `abandon()` calls `child.kill()`, which stops only the docker CLI (on Windows the kill never reaches the container), then `removeContainer(name)`: a detached, unref'd `docker rm -f <name>` whose errors are swallowed. `run.ended aborted` therefore does not guarantee the container is gone.

### Retention

`pruneRunLogs(historyDir, runId)` walks the logs newest first:

- It keeps the newest `RETAIN_RUN_LOGS` (20) logs that did not end `refused`, plus the newest refused log. An unreadable log counts as not refused. Refused logs stay out of the 20, so a burst of refused relaunches cannot push a real run's log out.
- It never deletes the run's own log, even when a clock step sorts it older.
- It runs after a passed claim, and on each refusal right after `run.ended refused`.
- A log it cannot delete (for example, one open in a Windows reader) is left for the next run.
- `.md` files are never pruned.

### Reading the log (supervisors)

| The log shows                                             | The run is                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a `run.ended` record                                      | **finished**: trust `reason` over the exit code, because exit 1 also comes from a thrown error (`reason: error`)                                                                                                                                                                                         |
| no `run.ended`; same host, pid alive and still node       | **running**. Ages to judge: image setup `now − run.started.at` while no `stage.started` has come yet; stage age `now − stage.startedAt`; agent silence `now − max(lastOutputAt, stage.startedAt, stage.retry.at + backoffMs)`, so neither a fresh stage nor a retry backoff in progress reads as silence |
| no `run.ended`; same host, pid gone                       | **dead** (host process killed). Its container may still run: `docker ps -q --filter label=ralph.run=<runId>` decides, and `docker rm -f $(docker ps -aq --filter label=ralph.run=<runId>)` cleans up                                                                                                     |
| no `run.ended`; another host or platform                  | **running** while the file's mtime is under 5 min old, otherwise **dead**                                                                                                                                                                                                                                |
| a line that fails to parse, a `seq` gap, a torn last line | fold up to the last good record                                                                                                                                                                                                                                                                          |

`stage.startedAt` is the `at` of the open stage's `stage.started`, `stage.retry` is that stage's latest retry, and `lastOutputAt` comes from the latest heartbeat.

- **Current run:** the newest log that isn't refused. A refused log's `blockedBy` names the run that blocked it.
- **Stopping a live run:** kill `started.pid` first, so it starts no further container. Then decide with `docker ps -q --filter label=ralph.run=<runId>` and clean up with `docker rm -f $(docker ps -aq --filter label=ralph.run=<runId>)`.
- **Exit 75:** retry after a jittered wait.

**Limits:**

- Ralph versions from before the log are invisible to the claim.
- Containers of already-pruned logs aren't seen by the claim.
- The volume `chown` helper and containers the agent starts through `docker.sock` carry no label.
- Two workspaces collide on a runId only with the same second, bin and branch. `--name` then conflicts once, and the retry runs as `-a2`.
- `removeContainer` is best effort: a container the daemon creates after the removal lands is still left behind.
- The log sits in the bind mount the agent can write to, so it is advisory, not a security boundary ([SECURITY.md](../SECURITY.md)).

### PowerShell reader

One rule set: stop at the first line that fails to parse, has a `seq` gap or has `v` ≠ 1, and drop a final line with no trailing newline. The gotchas:

- Read with `Get-Content -Raw`, not `[IO.File]::ReadAllText`, which fails against node's open write handle.
- Age the file by `LastWriteTimeUtc`.
- Don't check that `at` is a string: PowerShell 7's `ConvertFrom-Json` turns it into a `[datetime]` (Windows PowerShell 5.1 leaves a string). The script below casts both through `[datetimeoffset]`.

Checked under PowerShell 7 and Windows PowerShell 5.1. It judges a Windows-launched run by pid and anything else by mtime:

```powershell
param([string]$Workspace = ".")

function Read-RalphRunLog([string]$Path) {
  # Get-Content -Raw: [IO.File]::ReadAllText fails against node's open write handle.
  $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  $records = [System.Collections.Generic.List[object]]::new()
  # The piece after the last newline is empty, or a torn record: drop it.
  foreach ($line in @("$text" -split "`n" | Select-Object -SkipLast 1)) {
    try { $r = $line | ConvertFrom-Json -ErrorAction Stop } catch { break }
    # No check that `at` is a string: PowerShell 7 turns it into a [datetime].
    if ($r.v -ne 1 -or $r.seq -ne $records.Count + 1) { break }
    $records.Add($r)
  }
  , $records
}

# `at` / `lastOutputAt`: a string in Windows PowerShell 5.1, a [datetime] in 7.
function ConvertTo-Utc($Value) { ([datetimeoffset]$Value).UtcDateTime }

# The current run is the newest log that isn't refused.
$current = $null
$history = Join-Path $Workspace ".ralph/history"
foreach ($file in Get-ChildItem -LiteralPath $history -Filter *.jsonl | Sort-Object Name -Descending) {
  $records = Read-RalphRunLog $file.FullName
  if (($records | Where-Object type -eq "run.ended").reason -ne "refused") { $current = $file; break }
}
if (-not $current) { return }

$started = $stage = $retry = $lastOutputAt = $ended = $null
foreach ($r in $records) {
  switch ($r.type) {
    "run.started"     { $started = $r }
    "stage.started"   { $stage = $r; $retry = $null }
    "stage.retry"     { $retry = $r }
    "stage.completed" { $stage = $retry = $null }
    "heartbeat"       { $lastOutputAt = $r.lastOutputAt }
    "run.ended"       { $ended = $r; $stage = $retry = $null }
  }
}

$now = [datetime]::UtcNow
if ($ended) { $state = "ended: $($ended.reason)" }
elseif (-not $started) { $state = "dead" }  # a first line with v > 1 is a newer ralph: judge it by mtime
elseif ($started.hostname -eq [Net.Dns]::GetHostName() -and $started.platform -eq "win32" -and -not $started.wslDistro) {
  $proc = Get-Process -Id $started.pid -ErrorAction SilentlyContinue
  $state = if ($proc -and $proc.ProcessName -match "node") { "running" } else { "dead" }
}
else {
  # Another host, or WSL: live while written within the last 5 min.
  $state = if (($now - $current.LastWriteTimeUtc).TotalMinutes -lt 5) { "running" } else { "dead" }
}
"$($current.BaseName): $state"

if ($state -eq "running" -and -not ($records | Where-Object type -eq "stage.started")) {
  "image setup for $($now - (ConvertTo-Utc $started.at))"
}
elseif ($state -eq "running" -and $stage) {
  $quiet = @(ConvertTo-Utc $stage.at)
  if ($lastOutputAt) { $quiet += ConvertTo-Utc $lastOutputAt }
  if ($retry) { $quiet += (ConvertTo-Utc $retry.at).AddMilliseconds($retry.backoffMs) }
  "stage $($stage.stage) #$($stage.iteration) for $($now - (ConvertTo-Utc $stage.at)); agent silent for $($now - @($quiet | Sort-Object)[-1])"
}
```

---

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`; relative imports in `packages/core/src` end in `.js` (NodeNext).
- **First stage is the gate.** Place gating stages at index 0 of any chain. The sentinel `<promise>NO MORE TASKS</promise>` is hardcoded in [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts).
- **No build step for `apps/cli`.** Bins are hand-written JS that `import { runAfk } from "@daonhan/ralph-core"`. Keep the bin layer flat — don't add TS there.
- **`permissionMode` is always `bypassPermissions`** for sandbox stages — never `acceptEdits`. This supplies Claude's no-approval mode; Codex receives its provider-specific no-approval flag. With the Docker socket disabled, persistent host writes still include the workspace and, for Claude, the read-write credential store (Codex credentials are mounted read-only); GitHub CLI config is read-only.
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

The pre-commit hook ([`../.husky/pre-commit`](../.husky/pre-commit)) runs `pnpm exec lint-staged` (Prettier `--write` on staged files) then `pnpm typecheck`. The root `prepare` script is `husky || git config core.hooksPath .husky` so installs still work if Husky does not self-initialize.

Build the sandbox image locally from [`../packages/core/templates/Dockerfile`](../packages/core/templates/Dockerfile) (`node:22-bookworm` + Debian Bookworm Python 3.11 exposed as `python`/`python3` + `python -m venv` + pinned `uv`/`uvx` 0.11.28 + git/curl/jq + .NET SDK 10 + `gh` + Claude Code and pinned Codex CLIs; base `node` user renamed to `agent` UID 1000; `safe.directory=*` global; `WORKDIR /home/agent/workspace`; `ENTRYPOINT []`, `CMD ["claude"]`):

```bash
docker build -t docker.io/daonhan/ralph-sandbox:latest \
  -f packages/core/templates/Dockerfile .
```

```powershell
docker build -t docker.io/daonhan/ralph-sandbox:latest `
  -f packages/core/templates/Dockerfile .
```

The Claude Code CLI in the image is a build-time snapshot; every Claude stage refreshes it with
`claude update` at run time and caches the result in the `ralph-claude-home` volume (see the
`docker run` argv shape), unless `RALPH_CLAUDE_UPDATE=0`. The pinned Codex CLI is refreshed
the same way — `codex update` per stage, cached in `ralph-codex-cli`, unless
`RALPH_CODEX_UPDATE=0` — so `ARG CODEX_VERSION` sets the floor, not the running version.

Python runtime selection is static: the image supplies one baked system Python,
and the runner does not inspect `.python-version`, `.tool-versions`, `.mise.toml`,
`pyproject.toml`, or similar manifests. Repositories pinned to another version
must use a custom image until detection support exists. Project dependencies
belong in a project-local virtual environment or uv-managed isolation, not in the
Debian system Python.

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

| Variable                     | Default                                                  | Effect                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALPH_WORKSPACE`            | `process.cwd()`                                          | Host dir bind-mounted at `/home/agent/workspace`; root for `.ralph-tmp/`.                                                                                                                                                                                                  |
| `RALPH_AGENT`                | `claude`                                                 | Provider fallback when `--agent` is absent: `claude` or `codex`.                                                                                                                                                                                                           |
| `RALPH_DOCKER_CONTEXT`       | bundled core dir                                         | `docker build` fallback context (must contain a Dockerfile).                                                                                                                                                                                                               |
| `RALPH_IMAGE`                | `docker.io/daonhan/ralph-sandbox:latest`                 | Sandbox image ref.                                                                                                                                                                                                                                                         |
| `RALPH_IMAGE_TAG`            | —                                                        | Legacy alias for `RALPH_IMAGE`.                                                                                                                                                                                                                                            |
| `RALPH_MODEL`                | Claude `claude-opus-5[1m]`; isolated Codex `gpt-5.6-sol` | Model for the selected provider, outranked by `--model` and `RALPH_<AGENT>_MODEL`. Claude falls back to the model pinned in host `~/.claude/settings.json`, then Ralph's default; under `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY` the container CLI resolves instead. |
| `RALPH_EFFORT`               | Claude: the container CLI's own; isolated Codex `high`   | Reasoning effort for the selected provider, outranked by `--effort` and `RALPH_<AGENT>_EFFORT`. Agent-agnostic, so only a level in `SHARED_EFFORT_LEVELS` is accepted; an unknown level ends the run with `run.ended` `reason: "error"` before any container starts.       |
| `RALPH_CLAUDE_MODEL`         | _(unset)_                                                | Model for Claude runs; outranks `RALPH_MODEL`. Names are derived from the agent, so a new adapter gets its pair for free.                                                                                                                                                  |
| `RALPH_CODEX_MODEL`          | _(unset)_                                                | Model for Codex runs; outranks `RALPH_MODEL`. Explicit invalid models fail without fallback.                                                                                                                                                                               |
| `RALPH_CLAUDE_EFFORT`        | _(unset)_                                                | Claude reasoning effort (`low\|medium\|high\|xhigh\|max`); outranks `RALPH_EFFORT`. Unset sends no `--effort`.                                                                                                                                                             |
| `RALPH_CODEX_EFFORT`         | _(unset)_                                                | Codex reasoning effort (`none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra`); outranks `RALPH_EFFORT`, and is the only environment-variable route to a Codex-only level. Model/client/account compatibility remains Codex-owned.                                         |
| `RALPH_RESULT_GRACE_MS`      | `30000`                                                  | Post-completion kill timer; `0` disables. Invalid/negative → default.                                                                                                                                                                                                      |
| `RALPH_DOCKER_SOCK`          | on                                                       | `0` disables the host `docker.sock` bind-mount.                                                                                                                                                                                                                            |
| `RALPH_DOCKER_SOCK_PATH`     | auto-detect                                              | Explicit host socket path.                                                                                                                                                                                                                                                 |
| `RALPH_ISOLATE_NODE_MODULES` | on except Linux                                          | `0` shares the bind-mounted host `node_modules/`; `1` isolates on Linux too.                                                                                                                                                                                               |
| `RALPH_CLAUDE_UPDATE`        | on                                                       | `0` skips the per-stage `claude update` and the `ralph-claude-home` volume mount together, so Claude stages run the image's baked CLI. Ignored for Codex.                                                                                                                  |
| `RALPH_CODEX_UPDATE`         | on                                                       | `0` skips the per-stage `codex update` and the `ralph-codex-cli` volume mount together, so Codex stages run the image's pinned CLI. Ignored for Claude.                                                                                                                    |
| `DOCKER_HOST`                | —                                                        | `unix://…` parsed as a socket candidate.                                                                                                                                                                                                                                   |
| `XDG_RUNTIME_DIR`            | —                                                        | Rootless Docker/Podman socket candidates.                                                                                                                                                                                                                                  |
| `NO_COLOR` / `TERM=dumb`     | —                                                        | Disable ANSI on both streams.                                                                                                                                                                                                                                              |
