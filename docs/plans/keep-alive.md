# Plan: Keep Ralph Alive While AFK

> Source PRD: [docs/prd/keep-alive.md](../prd/keep-alive.md) · GitHub issue [#17](https://github.com/daonhan/ralph/issues/17)

## Architectural decisions

Durable decisions that apply across all phases:

- **New deep modules** (live in `packages/core/src/`):
  - `keepalive` — cross-OS wake-lock dispatcher with injected spawner
  - `retry` — pure backoff scheduler with `onAttempt` hook
  - `detach` — fork-and-exit driver around `process.execPath`
  - `notify` — OS toast + bell dispatcher with graceful fallback chain
- **Module depth contract** — `loop.ts`, `main.ts`, `gh-main.ts` stay shallow glue. All cross-platform branching lives in the deep modules; `loop.ts` only orchestrates.
- **Flag surface** (additive on both `ralph-afk` and `ralph-ghafk`):
  - `--no-keep-alive` — opt out of wake-lock
  - `--max-retries <N>` — per-iteration retry budget, default `3`
  - `--detach` — fork to background and exit
  - `--log <path>` — override detach log path
  - `--notify` — emit OS notifications + bell on terminal events
- **Wake-lock scope** — system sleep only (not display sleep). Matches `caffeinate -i` / `ES_SYSTEM_REQUIRED` / `systemd-inhibit --what=sleep`.
- **Retry defaults** — 3 attempts with backoff `[5_000, 30_000, 120_000]` ms. `--max-retries 0` restores current fail-fast behavior. Persistent failure skips the iteration (does not abort the whole loop).
- **Detach log default** — `.ralph-tmp/logs/detached-<pid>.log` (co-located with existing NDJSON logs).
- **Signal contract** — `SIGINT` → exit 130, `SIGTERM` → exit 143. Both release the wake-lock and kill any in-flight docker child via a single `finally` + `process.on("exit", …)` pair.
- **Test framework** — `vitest` added to `packages/core` devDependencies with a `test` script. Not shipped in the npm tarball (`files` array unchanged).
- **WSL2 detection** — sniff `/proc/version` for `microsoft`; emit a one-line warning that the Linux path only blocks WSL idle, not Windows host sleep.
- **Graceful degradation** — when an OS utility is missing (no `caffeinate`, no `notify-send`, no `BurntToast`), emit a stderr warning and return a no-op. Never crash the loop on a missing convenience.
- **Progressive `--print-config`** — each phase adds its own line to the existing diagnostic output (`keep-alive`, `max-retries`, `detach`, etc.). Final surface is documented in the PRD.

---

## Phase 1: Wake-lock default-on + signal handling

**User stories**: 1, 2, 3, 4, 5, 6, 7, 20, 23, 25 (partial), 26 (partial)

### What to build

A `keepalive` deep module that acquires an OS wake-lock on entry to `runLoop` and releases it on any exit path (clean return, thrown exception, `SIGINT`, `SIGTERM`). Windows uses a long-lived `powershell` child calling `SetThreadExecutionState`; macOS uses `caffeinate -i -w <pid>`; Linux uses `systemd-inhibit --what=sleep … sleep infinity`; WSL2 is detected and warned about. Missing utility paths emit a warning and degrade to a no-op releaser. Signal handlers installed by the loop release the lock and exit with the conventional non-zero code. `--no-keep-alive` opts out entirely. The `--print-config` diagnostic gains a `keep-alive` line. `vitest` is added to `packages/core` and the `keepalive` tests cover all four platform branches plus the no-op fallback. The `docs/keep-alive.md` doc is rewritten for the wake-lock half (the retry / detach / notify sections are placeholders updated in later phases).

### Acceptance criteria

- [ ] `keepalive` module exposes `acquire({ reason?, spawner? }): { release(): void }`.
- [ ] Windows / macOS / Linux / WSL2 platform branches each pass the documented argv to the injected spawner.
- [ ] Unit tests verify per-OS argv and that `release()` kills the child for each branch.
- [ ] Missing-utility path (spawner throws `ENOENT`) emits one warning to stderr and returns a no-op releaser whose `release()` is safe to call.
- [ ] `vitest` is wired into `packages/core` (`devDependencies`, `test` script). `pnpm --filter @daonhan/ralph-core test` runs the suite green.
- [ ] `loop.ts` acquires the lock before iteration 1 and releases it in a `finally` that also covers `SIGINT` / `SIGTERM`.
- [ ] `SIGINT` exits with code `130`; `SIGTERM` exits with code `143`. Wake-lock child is dead after either signal.
- [ ] `--no-keep-alive` flag on both bins skips acquisition entirely (verified via `--print-config` showing `keep-alive : off`).
- [ ] `--print-config` shows `keep-alive : on (system sleep only)` by default and `keep-alive : off` when opted out.
- [ ] Help text (`--help`) documents `--no-keep-alive`.
- [ ] Windows smoke: a short `ralph-afk` run holds a `SYSTEM` request visible in `powercfg /requests`, released on exit.
- [ ] macOS smoke: `pmset -g assertions` shows `PreventUserIdleSystemSleep` during the run, released on exit.
- [ ] Linux smoke: `systemd-inhibit --list` shows the inhibitor during the run, released on exit.
- [ ] WSL2 smoke: a warning is emitted, the loop continues, and the inhibitor (if systemd is present) appears.
- [ ] `docs/keep-alive.md` rewritten to describe the new built-in wake-lock behavior, WSL2 caveat, and `--no-keep-alive` escape hatch.

---

## Phase 2: Per-iteration retry default-on

**User stories**: 8, 9, 10, 11, 21 (partial), 22 (partial), 25 (partial)

### What to build

A `retry` deep module providing `withRetries(fn, { max, backoffMs, onAttempt })` that invokes `fn` up to `max + 1` times with the documented exponential backoff and an `onAttempt(n, err)` hook fired before each retry. The loop wraps every `runStage` call in `withRetries` so transient failures inside a single iteration do not abort the loop. A persistent failure after the retry budget is exhausted is logged (both to stderr and to the NDJSON log as a `[retry] attempt N of M after Ms ms` marker) and the loop proceeds to the next iteration. The `--max-retries <N>` flag overrides the default (`0` restores current fail-fast behavior). The `--print-config` diagnostic gains a `max-retries` line.

### Acceptance criteria

- [ ] `retry` module exposes `withRetries<T>(fn, opts): Promise<T>` with the documented backoff and `onAttempt` semantics.
- [ ] Unit tests cover: first-attempt success (no delay), success on the third attempt with observed `[5s, 30s]` waits, persistent failure with `max: 3` (four total calls, `[5s, 30s, 2m]` waits, last error rethrown), `max: 0` (single call, immediate rethrow), and `onAttempt` invocation order.
- [ ] Unit tests use fake timers — no real wall-clock waits.
- [ ] `loop.ts` wraps each `runStage` invocation in `withRetries` with the user's retry budget.
- [ ] Persistent iteration failure is logged and the loop continues to the next iteration (does not throw out of `runLoop`).
- [ ] Each retry attempt appends a `[retry] attempt N of M after Ms ms` marker line to the per-iteration NDJSON log.
- [ ] `--max-retries <N>` validates `N >= 0` and rejects non-integer inputs with a clear error.
- [ ] `--print-config` shows `max-retries : 3` by default and the user's value when overridden.
- [ ] Help text documents `--max-retries`.
- [ ] Smoke: a deliberately-failing iteration (e.g. a plan whose first stage exits non-zero) triggers exactly the configured number of retries, then the loop continues to the next iteration and reports clean exit.

---

## Phase 3: `--detach` fork-and-exit

**User stories**: 12, 13, 14, 15, 25 (partial)

### What to build

A `detach` module that re-spawns the current bin with `--detach` stripped from argv, stdio redirected to a log file, `detached: true`, and `windowsHide: true`. The parent prints `detached pid <pid>, log <path>` and exits cleanly. `main.ts` and `gh-main.ts` call `detachAndExit` before any other side effect so the wake-lock is acquired in the child (not orphaned in the parent). `--log <path>` overrides the default log path. The `--print-config` diagnostic gains a `detach` line.

### Acceptance criteria

- [ ] `detach` module exposes `detachAndExit({ logPath, argv, binEntry }): never`.
- [ ] Re-spawned child receives the original argv minus `--detach` (no infinite fork loop possible).
- [ ] Detached child stdio (stdout + stderr) is redirected to `logPath`; the log file is created with append semantics so concurrent runs do not clobber each other.
- [ ] Windows path passes `windowsHide: true` — no console window pops on PowerShell.
- [ ] Parent prints `detached pid <pid>, log <path>` on stderr and exits with code `0`.
- [ ] `--detach` is wired on both `ralph-afk` and `ralph-ghafk`. The wake-lock + retry behavior from Phases 1 and 2 still applies in the detached child.
- [ ] `--log <path>` is honored when present; default is `.ralph-tmp/logs/detached-<pid>.log` when absent.
- [ ] `--log` without `--detach` is rejected (or warned about) — the flag is only meaningful in detached mode.
- [ ] `--print-config` shows `detach : off` by default and `detach : on (log: <path>)` when active.
- [ ] Help text documents `--detach` and `--log`.
- [ ] Smoke: `ralph-afk --detach "<plan>" 3` returns the prompt immediately; closing the parent terminal does not kill the loop; `tail -f` on the log path from a fresh shell shows iteration progress.

---

## Phase 4: `--notify` + finalize docs

**User stories**: 16, 17, 18, 19, 24, 25 (rest), 26 (rest), 27

### What to build

A `notify` module that fires fire-and-forget OS notifications plus a terminal bell on loop completion (sentinel or iteration cap) and on unrecoverable failure (signal received, uncaught exception). Platform dispatch tries `BurntToast` → `msg.exe` → bell-only on Windows; `osascript display notification` on macOS; `notify-send` on Linux. All fallbacks degrade silently to bell-only. The loop is wired to call `notify({ level })` on terminal events. `--help` text gets a full overhaul covering every flag added in Phases 1–4. The `README.md` gains a "Running AFK" section showing the canonical overnight-run recipe. The `docs/keep-alive.md` rewrite is finalized (all sections populated, WSL2 limitation documented as out-of-scope, UPS recommendation noted).

### Acceptance criteria

- [ ] `notify` module exposes `notify({ title, body, sound?, level })` with `level` ∈ `"info" | "error"`.
- [ ] Windows path tries `BurntToast`, then `msg.exe`, then bell-only. Missing modules / utilities never crash the call.
- [ ] macOS path invokes `osascript -e 'display notification …'` with the documented `sound name "Glass"` for `info` and a different sound (or none) for `error`.
- [ ] Linux path invokes `notify-send` with appropriate urgency for `info` vs `error`.
- [ ] Bell (`\x07`) is written to stderr on every notification regardless of OS path.
- [ ] Notification calls are fire-and-forget — `notify` returns synchronously; loop never waits on toast delivery.
- [ ] Loop calls `notify({ level: "info" })` on clean completion (sentinel or iteration cap) when `--notify` is set.
- [ ] Loop calls `notify({ level: "error" })` on unrecoverable failure (uncaught exception, `SIGINT` / `SIGTERM` during iteration) when `--notify` is set.
- [ ] `--notify` flag is wired on both bins.
- [ ] `--help` text on both bins lists all five new flags (`--no-keep-alive`, `--max-retries`, `--detach`, `--log`, `--notify`) with one-line descriptions.
- [ ] `README.md` has a "Running AFK" section linking to `docs/keep-alive.md` and showing the canonical overnight-run recipe (e.g. `ralph-afk --detach --notify "<plan>" 50`).
- [ ] `docs/keep-alive.md` is finalized: all sections populated (wake-lock, retry, detach, notify), WSL2 → Windows host limitation called out, power-loss / UPS recommendation noted as out-of-scope for v1.
- [ ] Windows smoke: a 3-iteration run with `--notify` produces a toast on completion (or a bell-only fallback if neither BurntToast nor `msg.exe` is available).
- [ ] macOS smoke: a 3-iteration run with `--notify` produces a banner notification on completion.
- [ ] Linux smoke: a 3-iteration run with `--notify` produces a `notify-send` notification on completion.
- [ ] Crash smoke: a deliberately-failing run with `--notify` produces an `error`-level notification.
