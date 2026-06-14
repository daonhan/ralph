# Design: Watch / daemon mode for ralph-ghafk (Part 2 C)

Date: 2026-06-14
Status: Approved (brainstorm), pending spec review → implementation plan
Depends on: Part 1 (host runner) + Part 2 A+B (budget/pacing + panel) — branch `simplify/drop-docker-native-sandbox`.

## Summary

A long-running daemon mode for `ralph-ghafk`: idle, poll GitHub for labelled open issues, run the existing ghafk loop when work appears, then return to idle. `ralph-afk` is plan/PRD-driven (no external trigger) so watch mode is **ghafk-only**.

Decisions locked in brainstorm: **label-filtered** trigger (poll `gh issue list --state open --label <label>`, default label `ralph`, `RALPH_WATCH_LABEL` override); **daemon-cumulative** `--budget` (caps total spend across the whole watch session, then stops). Poll interval default **300s**, `--watch-interval <sec>` override.

## Behaviour

```
ralph-ghafk --watch [--watch-interval <sec>] [--budget <usd>] [--cooldown <ms>] [--notify] <iterations>

runWatch:
  acquire ONE wake-lock for the daemon's whole life (incl. idle, so the host
    stays awake to poll); own SIGINT/SIGTERM.
  cumulativeCost = 0
  loop:
    if budget != null && cumulativeCost >= budget:
      log + (notify) "budget $X reached — stopping watcher"; break
    count = openIssueCount(label)         # gh issue list --state open --label <label> --json number
      # gh failure (auth/network) → log a warning, treat as 0, keep polling (never crash the daemon)
    if count > 0:
      outcome = runLoop({ ghafk stages, iterations, budgetUsd: remaining, cooldownMs,
                          noKeepAlive: true, signal: daemonSignal })
      cumulativeCost += outcome.costUsd
      log "watch run done — issues handled, cumulative $<cumulativeCost>"
    await sleep(intervalSec * 1000, daemonSignal)   # abortable; Ctrl+C breaks here
  release wake-lock; (notify) on exit
```

- **Idle** = between polls, holding the wake-lock so the machine doesn't sleep through the interval.
- **Trigger** = ≥1 open issue with the label. The ghafk loop itself then drains issues until it emits `NO MORE TASKS` (no labelled work left) or hits `<iterations>`. An issue Ralph can't close stays open and re-triggers each interval — the operator removes the label to stop retrying (the intended control).
- **Stop** = `Ctrl+C` (SIGINT→130 / SIGTERM→143): aborts any in-flight stage, releases the wake-lock, exits.
- **Budget** = cumulative across all runs; each `runLoop` is also passed the _remaining_ budget so a single run can't overshoot the daemon cap.

## The one structural change: `runLoop` ownership

Today `runLoop` acquires its own wake-lock, installs its own `SIGINT/SIGTERM → process.exit` handlers, and returns `void`. A daemon must own those (continuous wake-lock through idle; Ctrl+C handled during sleep). So:

- **`LoopOptions` gains `signal?: AbortSignal`** (injected external abort). When present, `runLoop` uses it as the stage-abort source and **does not** install its own signal handlers or call `process.exit` — the caller owns shutdown. When **absent**, behaviour is byte-for-byte today's (single-shot bins unchanged).
- **`runLoop` returns `LoopOutcome { costUsd: number; sentinelHit: boolean }`** (additive; existing callers ignore it). `costUsd` = the run's accumulated `runCostUsd`; lets watch do cumulative budgeting.
- Watch passes `noKeepAlive: true` (it owns the wake-lock) and the daemon signal.

### Abort hygiene (`retry.ts`)

`withRetries` must **not** retry an `AbortError` — when the daemon signal fires mid-stage, the stage rejects with `AbortError` and retrying would just re-spawn into an aborted signal. Add: if `err?.name === "AbortError"`, rethrow immediately (no retry, no backoff). This also tightens the existing single-shot abort path. Guard with a unit test.

With injected-signal + this guard: on Ctrl+C the watch handler aborts `daemonSignal` → the in-flight `streamClaude` child is killed (its existing abort listener), `withRetries` rethrows the `AbortError`, `runLoop`'s stage catch sees `signal.aborted` and returns the outcome immediately (no `[failure]` log, no further iterations); watch then releases the wake-lock and exits.

## New module `watch.ts` — `runWatch`

```ts
export type RunWatchOptions = {
  stages: [Stage, ...Stage[]];
  iterations: number;
  workspaceDir: string;
  packageDir: string;
  watchIntervalSec: number; // default applied by caller
  watchLabel: string; // RALPH_WATCH_LABEL or "ralph"
  budgetUsd?: number;
  cooldownMs?: number;
  notify?: boolean;
  bin?: string;
  cliVersion?: string;
};

export async function runWatch(opts: RunWatchOptions): Promise<void>;
```

- Holds the wake-lock (`acquire` from `keepalive.ts`) for the whole daemon; single release path (mirrors `runLoop`'s `releaseOnce`).
- Owns `SIGINT`/`SIGTERM`: abort the daemon `AbortController` (kills any in-flight stage), release the wake-lock, `process.exit(130/143)`.
- `openIssueCount(label, cwd)`: `execSync("gh issue list --state open --label <label> --json number", { cwd, ... })` → `JSON.parse(...).length`. Wrapped in try/catch — on error, `process.stderr.write` a warning and return `0` (keep polling). The label is a harness/env value, not untrusted runtime data; still pass it as a fixed arg (no interpolation of issue/PR content) per the SECURITY invariant.
- The poll sleep uses `sleep(ms, signal)` from `pacing.ts` (abortable).

## Wiring

- **`cli-help.ts`** — `parseFlags` gains `watch: boolean` (`--watch`) and `watchIntervalSec?: number` (`--watch-interval <sec>`, parsed as a positive integer, validation mirroring `--max-retries`). `printHelp` documents both + `RALPH_WATCH_LABEL`. `--print-config` shows a `watch` line (`off` / `on (every Ns, label "ralph")`).
- **`run-bin.ts`** — `RunBinConfig` gains `supportsWatch?: boolean`. When `flags.watch`:
  - if `!cfg.supportsWatch` → error `--watch is only supported by ralph-ghafk` and exit 1.
  - else resolve `watchLabel = process.env.RALPH_WATCH_LABEL?.trim() || "ralph"`, `watchIntervalSec = flags.watchIntervalSec ?? 300`, and call `runWatch({...})` instead of `runLoop`. `--detach` composes (fork then watch) since detach just forks the same argv.
- **`gh-main.ts`** sets `supportsWatch: true`; **`main.ts`** leaves it false.
- **`index.ts`** exports `runWatch`, `type LoopOutcome`.

## New surface (summary)

| Flag / env               | Effect                                                    |
| ------------------------ | --------------------------------------------------------- |
| `--watch`                | (ghafk only) run as a polling daemon instead of one-shot. |
| `--watch-interval <sec>` | poll cadence (default 300).                               |
| `RALPH_WATCH_LABEL`      | issue label that gates a run (default `ralph`).           |

`--budget` becomes daemon-cumulative under `--watch`; `--cooldown`/`--notify` apply as usual.

## Testing

- `retry.test.ts`: `withRetries` rethrows an `AbortError` without retrying (and still retries ordinary errors).
- `loop.test.ts`: with an injected `signal`, `runLoop` installs no `process` SIGINT/SIGTERM handler and resolves a `LoopOutcome` (no `process.exit`); aborting the injected signal mid-stage resolves/returns rather than exiting. Existing no-signal tests stay green (return value ignored).
- New `watch.test.ts` (mock `keepalive`, `loop.runLoop`, `pacing.sleep`, and the gh-count helper):
  - polls; when count > 0 runs `runLoop` once per interval, else skips;
  - cumulative budget halts the daemon once `cumulativeCost >= budget` (passes _remaining_ budget into each `runLoop`);
  - a gh-count failure is swallowed (warn + treat as 0, keep polling);
  - SIGINT releases the wake-lock and exits.
  - Extract `openIssueCount` as an injectable/unit-testable function (so tests don't shell out to real `gh`).
- `run-bin`: `--watch` on a `supportsWatch:false` bin errors; on ghafk dispatches to `runWatch`.
- Gate: `pnpm -r typecheck` + `pnpm -r test` + root `pnpm test`.

## Success criteria

- `ralph-ghafk --watch 5` idles, polls every 5 min for `label:ralph` open issues, runs the loop (≤5 iters) when any exist, returns to idle; `Ctrl+C` stops cleanly (wake-lock released).
- `ralph-afk --watch …` errors with the ghafk-only message.
- `--watch --budget 20` stops the whole daemon once cumulative spend ≥ $20.
- `--print-config --watch --watch-interval 120` shows `watch  on (every 120s, label "ralph")`.
- Existing single-shot behaviour (no `--watch`) byte-for-byte unchanged; all suites green.

## Open questions (resolve in impl)

1. `gh issue list … --json number` returns `[]` JSON; confirm exit code is 0 with no issues (so empty ≠ error). If `gh` distinguishes "no issues" from "auth error" only by stderr, the try/catch + empty-parse still degrades safely to 0.
2. Whether `--detach + --watch` needs any special-casing — expected not (detach forks the same argv, which re-enters `runWatch`); verify the detached log path still resolves.
