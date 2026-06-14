# Architecture

Internals reference for **library extenders** of `@daonhan/ralph-core` and **core contributors** who need the runtime model before touching `loop` / `render` / `runner`. For user-facing install/setup, see [`../README.md`](../README.md); for release mechanics, [`../RELEASING.md`](../RELEASING.md).

All source links are relative to this `docs/` directory (e.g. [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts)).

---

## Overview

Ralph ships as a pnpm monorepo (Node >= 20, pnpm >= 9, root `packageManager pnpm@9.12.0`) that produces three release components:

| Component             | Path            | Version | What it is                                                                                                                          |
| --------------------- | --------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@daonhan/ralph-core` | `packages/core` | 0.6.3   | Library: loop driver, native-sandbox runner, template renderer, stage registry, AFK machinery. ESM, TS → `dist/`.                   |
| `@daonhan/ralph`      | `apps/cli`      | 0.6.3   | CLI exposing `ralph-afk` and `ralph-ghafk` bin entries. Hand-written JS bins, **no build step**, depends on core via `workspace:^`. |

Both packages are **ESM only** (`"type": "module"`). Relative imports inside [`../packages/core/src`](../packages/core/src) end in `.js` (compiled-output extension required by `moduleResolution: NodeNext`).

The harness drives the Claude Code CLI against a target repository in an iterating **implementer → reviewer** loop. Ralph runs `claude` directly on the host; the default `RALPH_RUNNER=sandbox` uses Claude Code's native OS sandbox (Seatbelt on macOS) to confine writes to the workspace. Nothing persists between stages except the git history written into that workspace.

---

## End-to-end data flow

```
ralph-afk / ralph-ghafk           bin (apps/cli/bin/*.js → import { runAfk|runGhAfk })
        │
        ▼
runAfk / runGhAfk                 (main.ts / gh-main.ts → runBin in run-bin.ts)
   parseFlags (cli-help.ts)       --help/-V/--print-config/--no-keep-alive/--max-retries/--detach/--log/--notify
   resolve workspaceDir, packageDir from env
   [--detach] detachAndExit       fork-and-exit, parent returns 0
        │
        ▼
runLoop (loop.ts)
   acquire() wake-lock (keepalive.ts)         once, unless --no-keep-alive
   install SIGINT/SIGTERM handlers + AbortController
   for i in 1..iterations:
     for s in 0..stages.length-1:
        renderTemplate(...)  (render.ts)       expand tags → prompt string
        runStage(...)  (runner.ts)             wrapped in withRetries (retry.ts)
           writeFileSync(.run-*.md)
           [sandbox] writeFileSync(.sandbox-*.json) native OS sandbox settings
           spawn claude … (cwd = workspaceDir)
           streamClaude: NDJSON → live print (stdout text / stderr tools)
                                  capture "result" event → return value
        if s == 0 and result ⊇ SENTINEL: print "Ralph complete", return
   finally: release wake-lock, off() signal handlers, [--notify] toast
```

The bin layer is thin: it parses flags, resolves two directories, and calls `runLoop` with a stage chain plus an `inputs` string. `runLoop` owns the iteration, signal handling, wake-lock, retries, and the sentinel gate. `renderTemplate` is a pure-ish synchronous string transform that may shell out to the **host** to expand tags. `runStage` spawns `claude` on the host; `streamClaude` parses the NDJSON, prints assistant text to stdout and tool/diagnostic events to stderr, and returns the `result` event's payload as the stage value.

Two resolved directories drive everything (set in `run-bin.ts`, shared by both bins):

| Dir            | Source                                    | Use                                                             |
| -------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `workspaceDir` | `RALPH_WORKSPACE` or `process.cwd()`      | Host repo Claude runs against (`cwd`); root for `.ralph-tmp/`.  |
| `packageDir`   | `resolve(dirname(import.meta.url), "..")` | The installed core package dir; `templates/` is read from here. |

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

| Module                                              | Responsibility                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`main.ts`](../packages/core/src/main.ts)           | `runAfk` bin entry: parse flags, resolve dirs, optionally detach, then `runLoop([implementer, reviewer], inputs=planAndPrd)`.                                     |
| [`gh-main.ts`](../packages/core/src/gh-main.ts)     | `runGhAfk` bin entry: same shape, `runLoop([ghafkImplementer, reviewer], inputs="")`.                                                                             |
| [`loop.ts`](../packages/core/src/loop.ts)           | `runLoop` — iteration driver: wake-lock, signal handlers, per-stage render→runStage with retries, sentinel gate, notify on terminal events.                       |
| [`render.ts`](../packages/core/src/render.ts)       | `renderTemplate` — expand the five tag forms; `resolveShell` picks the host shell for shell/spill tags.                                                           |
| [`runner.ts`](../packages/core/src/runner.ts)       | Native-sandbox runner: `runStage`, `streamClaude`, sandbox-settings helpers, `stageLogPath`, TTY-gated color exports. Reads `RALPH_RUNNER` / `RALPH_SANDBOX_NET`. |
| [`stages.ts`](../packages/core/src/stages.ts)       | `STAGES` registry: `implementer` (afk.md), `ghafkImplementer` (ghafk.md), `reviewer` (review.md), all `bypassPermissions`; `Stage` type.                          |
| [`index.ts`](../packages/core/src/index.ts)         | Public barrel — see exact exports below.                                                                                                                          |
| [`cli-help.ts`](../packages/core/src/cli-help.ts)   | `parseFlags`, `printHelp`, `printVersion`, `printConfig`, `readCoreVersion`. **Internal** (not exported from `index.ts`).                                         |
| [`retry.ts`](../packages/core/src/retry.ts)         | `withRetries`, `backoffFor`, `DEFAULT_BACKOFF_MS`, `DEFAULT_MAX_RETRIES`. **Internal.**                                                                           |
| [`keepalive.ts`](../packages/core/src/keepalive.ts) | `acquire` — OS wake-lock, returns a `Releaser`; per-platform inhibitor. **Internal.**                                                                             |
| [`detach.ts`](../packages/core/src/detach.ts)       | `detachAndExit`, `stripDetachFlags` — fork loop into background, parent exits 0. **Internal.**                                                                    |
| [`notify.ts`](../packages/core/src/notify.ts)       | `notify`, `notifyComplete`, `notifyError` — OS toast + terminal bell. **Internal.**                                                                               |
| `__tests__/`                                        | Vitest suites: `detach`, `keepalive`, `loop`, `notify`, `retry`, `runner` (6 files).                                                                              |

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
export { runStage } from "./runner.js";
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

Aborting flows the `stageAbort.signal` into `runStage`; `streamClaude` listens for `abort` and **kills the `claude` child**, rejecting with an `AbortError`. The wake-lock is released through a single `releaseOnce` guard shared by both handlers and the `finally` block, so the inhibitor child is killed exactly once. Handlers are removed via `process.off` in `finally`.

---

## Template renderer

[`render.ts`](../packages/core/src/render.ts). Templates live in [`../packages/core/templates`](../packages/core/templates). `renderTemplate(templatePath, vars, opts)` reads the file and applies five tag forms **in this fixed order** (order matters — `@spill` resolves before shell tags, and the try-shell regex matches before the plain one):

| #   | Tag                                        | Behavior                                                                                                                                                                                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `@include:<path>`                          | Inline a file via `readFileSync`. Relative paths resolve against the template's dir. **No shell.** Trailing newline trimmed. Used to inject the playbooks.                                                                                        |
| 2   | `@spill[?]:<name>=`<cmd[\|\|\|fallback]>`` | Run `cmd` on the host shell, write stdout to `spillHostDir/<name>`, and substitute the workspace-relative path `./<spillRefPath>/<name>` into the prompt. The `?` form treats non-zero exit as success and writes `fallback` instead of throwing. |
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

## Native-sandbox runner

[`runner.ts`](../packages/core/src/runner.ts).

### `claude` argv shape

`runStage` writes the rendered prompt to `<workspace>/.ralph-tmp/.run-<pid>-<iter>-<ts>.md`, then assembles:

```
claude --verbose --print --output-format stream-json
       --permission-mode <mode>
       [--settings <workspace>/.ralph-tmp/.sandbox-<pid>-<iter>-<ts>.json]
       [--model <RALPH_MODEL>]
       "Read the full instructions from the file ./.ralph-tmp/<run-file> in the current workspace and execute them."
```

Spawned with `cwd = workspaceDir`. `--permission-mode` is always `bypassPermissions` (from the stage). `--settings` is included only when `RALPH_RUNNER=sandbox` (the default).

### Sandbox settings (`RALPH_RUNNER=sandbox`)

`buildSandboxSettings(workspaceDir, allowedDomains)` produces a transient JSON file:

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": { "allowWrite": ["<workspaceDir>"] },
    "excludedCommands": ["gh *", "gcloud *", "terraform *"]
  }
}
```

`excludedCommands` exempts Go-TLS CLIs from the sandbox so `gh`/`gcloud`/`terraform` keep working (they fail TLS verification under Seatbelt). If `RALPH_SANDBOX_NET` is set, a `network.allowedDomains` block is added; otherwise network egress is unrestricted (filesystem confinement is the blast-radius control; network commands fall back to the bypass-approved escape hatch).

The settings file is written to `.ralph-tmp/` and deleted in `finally`.

### NDJSON streaming — `streamClaude`

`spawn("claude", args, { cwd, stdio: ["ignore","pipe","pipe"] })`. stdout is read line-by-line; lines starting with `{` are appended to the NDJSON log and `JSON.parse`d:

- **assistant `text`** → printed to **stdout** with a `●` bullet (the visible answer stream).
- **`tool_use` / `tool_result` / `thinking` / `system:init`** → rendered to **stderr** (tool name + truncated input/result preview + elapsed ms).
- **`result`** event → its `result` string is captured as `finalResult`, the stage's return value.

Color is **TTY-gated and stream-split**: `USE_COLOR` (stderr) and `USE_COLOR_STDOUT` (stdout) are independent, so `ralph-ghafk 1 > out.txt` stays clean even on a TTY. ANSI is disabled when `NO_COLOR` is set or `TERM=dumb`.

**Post-result grace timer:** when the `result` event arrives, a one-shot timer (`RALPH_RESULT_GRACE_MS`, default **30000 ms**; `0` disables) is armed. If the `claude` child emits its final NDJSON but never exits (a known claude-CLI self-deadlock), the timer kills the child and resolves with the captured result so the loop is not hung. On non-zero exit, `streamClaude` rejects with the last ~40 stderr lines.

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
- **`permissionMode` is always `bypassPermissions`** for all stages — AFK requires non-interactive bash/edit approval; blast radius is bounded by the runner sandbox and the workspace is git-recoverable. Never `acceptEdits`.
- **Templates ship in the core tarball.** `packages/core/package.json` `files` includes `dist` and `templates`.
- **Adding a stage** = (1) extend `STAGES` in [`../packages/core/src/stages.ts`](../packages/core/src/stages.ts), (2) drop a new `*.md` in [`../packages/core/templates`](../packages/core/templates), (3) wire it into the chain in `main.ts` / `gh-main.ts`.

---

## Building and testing

Verification = typecheck + unit tests + manual bin invocation (no separate lint command; formatting runs via the pre-commit hook).

Build core (`apps/cli` has no build):

```bash
pnpm install
pnpm -r build        # tsc -p packages/core/tsconfig.json → dist/
pnpm -r typecheck    # tsc --noEmit across the workspace
```

Run tests (core: vitest; root: `node --test` over `scripts/*.test.mjs`):

```bash
pnpm --filter @daonhan/ralph-core test   # vitest run, src/__tests__/*.test.ts
pnpm test                                # root: node --test scripts/*.test.mjs
```

The pre-commit hook ([`../.husky/pre-commit`](../.husky/pre-commit)) runs `pnpm exec lint-staged` (Prettier `--write` on staged files) then `pnpm typecheck`. The root `prepare` script is `husky || git config core.hooksPath .husky` so installs still work if Husky does not self-initialize.

Diagnose resolved config (workspace / runner / sandbox config) without running a loop:

```bash
ralph-afk --print-config
```

Release/publishing (release-please → tag-driven npm workflows) is the single-source-of-truth concern of [`../RELEASING.md`](../RELEASING.md).

---

## Environment variables

| Variable                 | Default          | Effect                                                                                                                      |
| ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `RALPH_WORKSPACE`        | `process.cwd()`  | Host dir Claude runs against (`cwd`); root for `.ralph-tmp/`.                                                               |
| `RALPH_RUNNER`           | `sandbox`        | `sandbox` — native OS sandbox (Seatbelt on macOS), writes confined to the workspace. `host` — unsandboxed.                  |
| `RALPH_SANDBOX_NET`      | — (unrestricted) | Comma-separated domain allowlist for sandbox network egress. Unset = unrestricted (filesystem is the blast-radius control). |
| `RALPH_RESULT_GRACE_MS`  | `30000`          | Post-result kill timer; `0` disables. Invalid/negative → default.                                                           |
| `RALPH_MODEL`            | — (CLI default)  | `--model <value>` pass-through to `claude` for every stage. Empty/whitespace = unset.                                       |
| `NO_COLOR` / `TERM=dumb` | —                | Disable ANSI on both streams.                                                                                               |
