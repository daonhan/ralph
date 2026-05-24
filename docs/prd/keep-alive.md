# PRD: Keep Ralph Alive While AFK

## Problem Statement

As a Ralph user, I kick off `ralph-afk "<plan-and-prd>" 50` (or `ralph-ghafk 50`) before going to bed or stepping out, expecting the loop to chew through iterations overnight. In practice the loop dies in three different ways while I'm away:

1. **My laptop goes to sleep.** Windows' default power profile suspends after 15–30 minutes of idle. macOS does the same. The docker container is killed when the host suspends; the next iteration never starts. I come back to a loop that ran 2 iterations out of 50.
2. **My terminal disappears.** I close the laptop lid, an RDP session drops, an SSH connection times out, or I close the Windows Terminal window by mistake. The foreground node process dies with its parent shell and the loop ends mid-iteration.
3. **A single iteration crashes the whole loop.** A network blip during `docker pull`, a transient claude CLI error, an OOM in a tool call — any one of these throws out of `runStage` and aborts the loop. Iterations 1–17 succeeded; iteration 18 hit a 500 from the API; the remaining 32 iterations never run.

The repo today already names the bins `ralph-afk` / `ralph-ghafk`, but they only do the "iterate" half of AFK. Nothing in the harness keeps the host awake, keeps the process alive across a logoff, or recovers from a single bad iteration. Existing docs (`docs/keep-alive.md`) acknowledge the problem and copy nightshift's punt: tell the user to install `caffeinate` / `tmux` / change Windows power settings manually. That's three OS-specific recipes the user must remember and apply correctly every single time.

I want to type `ralph-afk "<plan>" 50` and trust that it will still be running tomorrow morning — on Windows, on macOS, on Linux, on WSL2.

## Solution

`ralph-afk` and `ralph-ghafk` become true AFK tools: they acquire an OS wake-lock for their lifetime, retry transient iteration failures automatically, and expose opt-in `--detach` and `--notify` flags for users who want to log out of their terminal session entirely.

From the user's perspective:

- **Just running the bin keeps the host awake.** Wake-lock acquired before iteration 1, released on clean exit or signal. No flag required, no manual recipe per OS. Released even if the loop crashes.
- **Iteration failures are retried automatically** with exponential backoff (5s / 30s / 2m). A persistent failure after three attempts gets logged and the loop moves on to the next iteration rather than aborting the whole run. Configurable via `--max-retries`.
- **`ralph-afk --detach "<plan>" 50`** forks the loop into a background process, prints `PID + log path`, and returns the prompt immediately. The user can close their terminal, log off, or disconnect SSH without killing the loop. They reattach by tailing the log.
- **`ralph-afk --notify "<plan>" 50`** raises an OS-native notification (Windows toast / macOS banner / Linux `notify-send`) on completion or unrecoverable failure, plus a terminal bell. Bell works in all terminals; toasts degrade gracefully where the OS facility is missing.
- **Defaults are sensible for the bin's name.** Wake-lock and retry are on by default — the bin is literally called `afk`. Detach and notify stay opt-in because they change UX flow (no foreground output, modal toast). `--no-keep-alive` opts out of the wake-lock for short interactive runs.
- **Per-OS notes live in `docs/keep-alive.md`**, kept honest with the actual implementation rather than copied from another project.

## User Stories

1. As a Ralph user, I want to run `ralph-afk "<plan>" 50` before bed and find the loop still running in the morning, so that I'm not wasting an overnight slot because Windows suspended at 23:30.
2. As a Ralph user on Windows 11, I want the wake-lock to use `SetThreadExecutionState` (no admin required, no policy changes), so that I don't have to grant elevated privileges to a CLI.
3. As a Ralph user on macOS, I want the wake-lock to be a `caffeinate -i -w <pid>` child that dies with the parent, so that crashed runs don't leak a permanent caffeine hold.
4. As a Ralph user on Linux, I want the wake-lock to use `systemd-inhibit --what=sleep --mode=block sleep infinity`, so that the OS sleep gate is held exactly for the loop's lifetime.
5. As a Ralph user on WSL2, I want the Linux `systemd-inhibit` path to also work (or at least degrade with a clear "WSL2 cannot block host sleep — set Windows power plan manually" warning), so that I'm not silently exposed to Windows host suspension.
6. As a Ralph user, I want `--no-keep-alive` to skip the wake-lock entirely, so that short interactive runs don't leave a child process hanging around when I Ctrl-C.
7. As a Ralph user on a machine without the relevant OS utility (e.g. `caffeinate` missing on a stripped Linux image), I want a warning rather than a hard crash, so that the loop still runs even if it might be suspended.
8. As a Ralph user, I want a single iteration failure to retry up to 3 times with exponential backoff (5s / 30s / 2m), so that transient network blips and claude API hiccups don't kill the whole overnight run.
9. As a Ralph user, I want retry attempts logged into the existing NDJSON stream as a `[retry] attempt N of 3 after Ms ms` event, so that I can audit failures the morning after.
10. As a Ralph user, I want a persistently-failing iteration (after 3 retries) to be skipped, not abort the whole loop, so that one bad task doesn't lose me the remaining 30 iterations of useful work.
11. As a Ralph user, I want `--max-retries <N>` to override the default, so that I can dial retries up for known-flaky environments or down to 0 to fail fast.
12. As a Ralph user, I want `ralph-afk --detach "<plan>" 50` to fork into the background, print PID + log path, and exit immediately, so that I can close the terminal without killing the loop.
13. As a Ralph user, I want the detached process to write all stdout + stderr to a log file at `.ralph-tmp/logs/detached-<pid>.log`, so that I can `tail -f` it from a fresh shell.
14. As a Ralph user, I want `--log <path>` to override the default detach log location, so that I can pipe long-running output to a known place (e.g. on a separate disk).
15. As a Ralph user on Windows, I want `--detach` to use `windowsHide: true` so the background process doesn't pop a console window, so that detaching looks clean in PowerShell.
16. As a Ralph user, I want `--notify` to raise an OS-native notification on loop completion (sentinel hit or iteration cap reached), so that I notice the result without having to keep glancing at the terminal.
17. As a Ralph user, I want `--notify` to raise an OS-native notification on unrecoverable loop failure (e.g. all retries exhausted on a critical step, docker daemon down), so that I don't waste hours assuming progress is being made.
18. As a Ralph user, I want a terminal bell (`\x07`) on every notification event, so that even in environments without OS toast support I still get an audible signal.
19. As a Ralph user, I want notifications to degrade gracefully (toast → bell-only → silent log line) without crashing the loop, so that the absence of `notify-send` or BurntToast doesn't break my run.
20. As a Ralph user on a battery laptop, I want the wake-lock to block **system sleep only**, not display sleep, so that the screen can dim and turn off normally and I don't burn the battery overnight.
21. As a Ralph maintainer, I want all wake-lock, retry, and detach logic in deep modules that can be unit-tested without spawning docker, so that I can verify cross-platform branching without setting up three CI hosts.
22. As a Ralph maintainer, I want the `loop.ts` glue to remain shallow — call `keepalive.acquire()`, wrap `runStage` in `withRetries`, call `notify` on terminal events — so that the iteration logic stays readable.
23. As a Ralph user, I want `Ctrl-C` to release the wake-lock cleanly, kill any pending docker child, and exit with a non-zero code, so that I can abort an AFK run without leaking OS state.
24. As a Ralph user, I want `ralph-afk --help` and `ralph-ghafk --help` to document `--detach`, `--notify`, `--max-retries`, `--no-keep-alive`, and `--log`, so that the flags are discoverable without reading the README.
25. As a Ralph user, I want the existing `--print-config` output extended to show "keep-alive: on (system sleep only)", "max-retries: 3", and "detach: off", so that I can verify the AFK configuration before kicking off an overnight run.
26. As a Ralph user, I want `docs/keep-alive.md` rewritten to describe the new built-in behavior (what's automatic, what's opt-in, per-OS notes, troubleshooting), so that the documentation matches reality rather than copy-pasting another project's manual-recipe approach.
27. As a Ralph user, I want power-loss / battery-death scenarios documented as out-of-scope for v1 (use a UPS or accept the loss), so that I have realistic expectations.

## Implementation Decisions

### Modules

- **`keepalive` module (new, deep)** — pure cross-OS wake-lock dispatcher.
  - Interface: `acquire(opts: { reason?: string; spawner?: Spawner }): Releaser` where `Releaser = { release: () => void }`.
  - Platform dispatch:
    - **Windows**: spawn a long-lived `powershell -NoProfile -Command "Add-Type ... [Power.PowerHelper]::SetThreadExecutionState([uint]::ES_CONTINUOUS -bor [uint]::ES_SYSTEM_REQUIRED); while ($true) { Start-Sleep -Seconds 60 }"` child. `release()` kills the child, which lets the OS clear `ES_CONTINUOUS` on process exit.
    - **macOS**: spawn `caffeinate -i -w <parent-pid>`. `release()` kills the child; `-w` makes caffeinate self-terminate if the parent dies first, so a SIGKILL of the bin still cleans up.
    - **Linux**: spawn `systemd-inhibit --what=sleep --why="<reason>" --mode=block sleep infinity`. `release()` kills the child.
    - **WSL2**: detected via `/proc/version` containing `microsoft`. Emit a warning that the Linux `systemd-inhibit` only blocks WSL idle, not Windows host sleep; document the manual Windows power-plan recipe.
    - **Missing utility / unsupported platform**: emit one-line warning to stderr, return a no-op releaser. Loop continues without wake-lock.
  - The `spawner` parameter is dependency-injected to allow unit tests to assert per-OS argv without actually spawning processes.
- **`retry` module (new, deep)** — pure backoff scheduler.
  - Interface: `withRetries<T>(fn: () => Promise<T>, opts: { max: number; backoffMs: number[]; onAttempt?: (n, err) => void }): Promise<T>`.
  - Behavior: invokes `fn` up to `max + 1` times. Between attempts, awaits `backoffMs[i]` (last value reused if attempts exceed array length). `onAttempt` fires before each retry for log emission. Final failure rethrows the last error.
  - Default backoff: `[5_000, 30_000, 120_000]` (5s, 30s, 2m). Max retries: 3.
- **`detach` module (new, medium)** — fork-and-exit driver.
  - Interface: `detachAndExit(opts: { logPath: string; argv: string[]; binEntry: string }): never`.
  - Implementation: `spawn(process.execPath, [binEntry, ...argvWithoutDetachFlag], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true }).unref()`. Parent prints `detached pid <pid>, log <path>` and `process.exit(0)`.
  - Edge cases: ensure `--detach` is stripped from the re-spawned argv to avoid an infinite fork loop. Ensure `process.execPath` is the user's actual node binary (not a shim that requires the parent tty).
- **`notify` module (new, shallow)** — OS toast + bell dispatcher.
  - Interface: `notify({ title: string; body: string; sound?: boolean; level: "info" | "error" }): void`.
  - Platform dispatch (try in order, fall through silently on failure):
    - **Windows**: try `powershell -Command "New-BurntToastNotification ..."` (if `BurntToast` module available), else fall back to `msg.exe * "<body>"`, else bell-only.
    - **macOS**: `osascript -e 'display notification "<body>" with title "<title>" sound name "Glass"'`.
    - **Linux**: `notify-send "<title>" "<body>"`.
  - Bell: write `\x07` to stderr in addition to the OS notification.
  - Fire-and-forget; do not block the loop on notification delivery.
- **`loop.ts`** (modify, shallow glue) — wire wake-lock + retry + notify around the existing iteration loop.
  - Acquire wake-lock before iteration 1; release in a `finally` covering signal handlers (`SIGINT`, `SIGTERM`).
  - Wrap each `runStage(...)` call in `withRetries(...)` with the user's retry config. Log retry attempts via the existing stderr `[sandcastle]`-style channel and append a sentinel line to the NDJSON log.
  - On clean completion (sentinel or iteration cap): call `notify({ level: "info", ... })` if enabled.
  - On unrecoverable failure (e.g. all retries exhausted, signal received): call `notify({ level: "error", ... })`, release wake-lock, rethrow.
- **`main.ts` / `gh-main.ts`** (modify, shallow glue) — argument parsing for new flags.
  - `--detach` → call `detachAndExit` before any other side effects (so the wake-lock is acquired in the child, not orphaned in the parent).
  - `--notify` → flips a flag passed into `runLoop`.
  - `--no-keep-alive` → flips a flag passed into `runLoop`.
  - `--max-retries <N>` → integer parse, validate `>= 0`, passed into `runLoop`.
  - `--log <path>` → only meaningful with `--detach`; if absent, default to `.ralph-tmp/logs/detached-<pid>.log` after fork.
- **`cli-help.ts`** (modify) — extend the help block with the new flag table.
- **`docs/keep-alive.md`** (rewrite) — replace nightshift's three-recipe doc with the new built-in behavior, opt-in flag reference, and per-OS troubleshooting notes (WSL2 caveat, Windows admin-free wake-lock explanation, macOS / Linux utility requirements).
- **`README.md`** (modify) — add a "Running AFK" section linking to `docs/keep-alive.md` and showing the canonical overnight-run recipe (`ralph-afk --detach --notify "<plan>" 50`).

### Defaults & flag matrix

| Flag                | Default                              | Behavior                                                                          |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| (none)              | —                                    | Wake-lock acquired, retries up to 3× with exponential backoff, foreground output. |
| `--no-keep-alive`   | off                                  | Skip wake-lock entirely.                                                          |
| `--max-retries <N>` | 3                                    | Per-iteration retry budget. `0` disables retries (current behavior).              |
| `--detach`          | off                                  | Fork to background; print PID + log; exit.                                        |
| `--log <path>`      | `.ralph-tmp/logs/detached-<pid>.log` | Detached-mode log target.                                                         |
| `--notify`          | off                                  | OS toast + bell on loop terminal events.                                          |

### Signal handling contract

- `SIGINT` (Ctrl-C) and `SIGTERM`: release wake-lock, kill in-flight docker child, exit with the signal-conventional non-zero code (130 for SIGINT, 143 for SIGTERM).
- Uncaught loop exception: release wake-lock, fire crash notification if `--notify` is on, rethrow so the process exits non-zero with the original stack trace.
- All cleanup goes through a single `finally` + `process.on("exit", ...)` pair to guarantee the wake-lock child is killed exactly once.

### `--print-config` extension

Existing `--print-config` output gains three lines:

```
keep-alive   : on (system sleep only)
max-retries  : 3
detach       : off
```

When `--no-keep-alive` is passed: `keep-alive   : off`. When `--detach` is passed: `detach       : on (log: <path>)`.

### Out-of-scope notification UX

No notification grouping, no progress notifications mid-loop, no rich actions on the toast (e.g. "open log"). v1 is purely "loop is done" / "loop crashed" + bell. Progress is observed via the log; the toast is the wake-the-user signal.

## Testing Decisions

### What makes a good test here

Tests target the **external behavior** of `keepalive` and `retry`:

- For `keepalive`: given a platform string and a stubbed spawner, assert the exact argv passed to spawn AND that `release()` kills the returned child. The contract under test is "the right child gets started, and stops cleanly on release" — not the internal platform-dispatch branching.
- For `retry`: given a stubbed function that fails N times then succeeds, assert the total number of attempts, the delay between attempts (via fake timers), and that `onAttempt` was called with the expected arguments. The contract under test is "fn is invoked until success or budget exhausted, with the documented backoff" — not the internal scheduling implementation.

Tests that mock module internals (`fs`, `child_process` modulewise rather than via the injected `spawner`) survive nothing and rot fast.

### Modules under test

- **`keepalive`** — three platform branches × release-cleanup × utility-missing fallback. Non-trivial dispatch, the only module where a typo silently produces a no-op on prod machines.
- **`retry`** — pure scheduler. Trivial to unit-test, valuable because the loop relies on it being correct (a buggy retry could re-trigger the same expensive iteration forever).

Out of scope for unit tests: `detach` (re-execs the node binary; meaningfully tested only end-to-end), `notify` (shallow fan-out where a manual smoke per OS is faster and more reliable than mocking spawn), `loop.ts` glue (covered by the existing manual smoke flow).

### Test framework

Add `vitest` to `packages/core` `devDependencies` and a `"test": "vitest run"` script. (`vitest` does not ship in the published `files` array; the npm tarball is unaffected.) This matches the framework chosen in the multi-version-runtime-support PRD, keeping the project on one test stack.

### Concrete test cases

**`keepalive`**:

- Windows path: spawner receives `["powershell", "-NoProfile", "-Command", "<script containing SetThreadExecutionState>"]`. Release kills child.
- macOS path: spawner receives `["caffeinate", "-i", "-w", "<pid>"]` with parent pid. Release kills child.
- Linux path: spawner receives `["systemd-inhibit", "--what=sleep", "--why=...", "--mode=block", "sleep", "infinity"]`. Release kills child.
- WSL2 detection: when `/proc/version` contains `microsoft`, a warning is emitted and the Linux path still runs.
- Missing utility (spawner throws `ENOENT`): warning emitted, no-op releaser returned, `release()` is a safe no-op.

**`retry`**:

- Success on first attempt: fn called once, no delay, returns value.
- Success on third attempt: fn called three times, delays `[5_000, 30_000]` observed via fake timers, returns final value.
- Persistent failure with `max: 3`: fn called four times total, delays `[5_000, 30_000, 120_000]` observed, final error rethrown.
- `max: 0`: fn called once, no retry, error rethrown immediately.
- `onAttempt` callback fired before each retry with `(attemptNumber, error)`.

### Prior art

None in this repo (no test suite exists today). The multi-version-runtime-support PRD already proposes adding `vitest` for its `detect` module; this PRD assumes that landed and shares the same test framework. If the runtime PRD ships after this one, this PRD pulls the `vitest` setup forward.

## Out of Scope

- **Power-loss / UPS scenarios** — if the laptop battery dies or the desk loses power, the loop dies. Out of scope for v1. Document the UPS recommendation in `docs/keep-alive.md`.
- **Resume on restart** — if the docker host reboots, the loop does not resume from iteration N+1. Out of scope (deferred per the runtime-support PRD's "punt complexity, the commits in the workspace are the real resume mechanism" reasoning). Cheap follow-up if demand surfaces.
- **Daemon mode with reattach** — `--detach` forks-and-forgets. No `ralph-afk attach <pid>` command; users `tail -f <log>` for visibility. A real reattach surface is a separate, larger PRD.
- **Progress notifications mid-loop** — only completion / crash notifications in v1. No "iteration 25/50 done" toasts.
- **Notification grouping / rich actions** — plain text title + body + bell. No Action Center categorization, no clickable actions on the toast.
- **GUI status panel** — no tray icon, no menubar widget. Out of scope.
- **Non-OS power management** — no integration with macOS Power Nap, no Windows Modern Standby tuning beyond `SetThreadExecutionState`. The wake-lock blocks idle sleep; if the user manually puts the laptop to sleep, the loop dies as expected.
- **Battery threshold gating** — no "pause loop when battery < 20%" logic. The user knows their setup.
- **WSL2 → Windows host wake-lock bridge** — a working solution would require a Windows-side helper process. Out of scope; document the limitation and recommend running natively on Windows for AFK use.

## Further Notes

### Open risks the implementer should investigate

1. **Windows `SetThreadExecutionState` via PowerShell child process** — the `Add-Type` approach pins the wake-lock to the lifetime of that powershell process. Verify on Windows 11 that killing the powershell child releases the lock immediately (not at the next idle-check tick). If the lock leaks past the child's death, fall back to spawning a tiny Node child that calls the same Win32 API via `node-ffi-napi` (extra dep) or `koffi`.
2. **macOS `caffeinate -w <pid>` race** — if the parent crashes between `caffeinate` spawn and the explicit `release()`, does caffeinate notice the parent is gone and exit on its own? Manual test required; the `-w` flag is documented to handle exactly this, but verify with a forced SIGKILL.
3. **Linux `systemd-inhibit` outside systemd-managed sessions** — some minimal container or chroot environments do not have a working systemd user session. Detect this (probe for `systemctl is-system-running`) and degrade to a warning rather than a hung `systemd-inhibit` call.
4. **WSL2 nuance** — `systemd-inhibit` may work inside WSL2 if the user enabled systemd in `/etc/wsl.conf`, but it only blocks WSL idle, not Windows host sleep. The implementer should test both with and without systemd-on-wsl2 and emit a clear warning either way.
5. **Detach + log file ownership on Windows** — when `spawn` creates the child process with `detached: true` on Windows, the log file handle must be opened before spawn and inherited correctly. Verify that closing the parent's handle doesn't truncate the file.
6. **Notification dependency footprint** — BurntToast is a separate PowerShell module (`Install-Module BurntToast`). Don't auto-install; detect and fall back to `msg.exe` + bell. Document the optional install in `docs/keep-alive.md`.
7. **Retry budget vs iteration cost** — three retries with 5s/30s/2m backoff means a single bad iteration can stall the loop for ~3 minutes before skipping. For a 50-iteration overnight run that's negligible; for short interactive runs it's painful. The `--max-retries 0` opt-out is sufficient mitigation; verify the default doesn't surprise short-run users.

### Files to touch

- `packages/core/src/keepalive.ts` (new — deep module)
- `packages/core/src/retry.ts` (new — deep module)
- `packages/core/src/detach.ts` (new — medium module)
- `packages/core/src/notify.ts` (new — shallow module)
- `packages/core/src/loop.ts` (wire wake-lock + retry + notify)
- `packages/core/src/main.ts` (parse new flags, detach before runLoop)
- `packages/core/src/gh-main.ts` (parse new flags, detach before runLoop)
- `packages/core/src/cli-help.ts` (document new flags)
- `packages/core/src/__tests__/keepalive.test.ts` (new — unit tests)
- `packages/core/src/__tests__/retry.test.ts` (new — unit tests)
- `packages/core/package.json` (add `vitest` devDep + `test` script)
- `apps/cli/bin/ralph-afk` (forward new flags to runLoop)
- `apps/cli/bin/ralph-ghafk` (forward new flags to runLoop)
- `docs/keep-alive.md` (rewrite for new built-in behavior)
- `README.md` (new "Running AFK" section)

### Verification

End-to-end smoke after merge, in order:

1. `pnpm install && pnpm -r build && pnpm -r typecheck` — clean.
2. `pnpm --filter @daonhan/ralph-core test` — `keepalive.test.ts` + `retry.test.ts` green.
3. Windows 11: `ralph-afk "<short plan>" 3` — confirm via `powercfg /requests` that a `SYSTEM` request is held during the run, released after exit.
4. macOS: `ralph-afk "<short plan>" 3` — confirm via `pmset -g assertions` that `PreventUserIdleSystemSleep` is held during the run.
5. Linux: `ralph-afk "<short plan>" 3` — confirm via `systemd-inhibit --list` that the inhibitor is present during the run.
6. `ralph-afk --max-retries 1 "<plan>" 1` against a plan known to fail; verify exactly one retry happens, then the iteration is logged as failed and skipped, and the loop reports clean exit.
7. `ralph-afk --detach "<plan>" 3` — confirm process detaches, parent exits, log file gets written, target terminal can be closed without killing the loop. Tail the log from a fresh shell.
8. `ralph-afk --notify "<plan>" 3` — confirm OS toast appears on completion and bell rings.
9. `ralph-afk --print-config` — confirm new lines appear and reflect flag combinations correctly.
10. `Ctrl-C` mid-run — confirm wake-lock child dies (verify via the same OS-specific probe as steps 3–5), docker child dies, exit code is 130.
