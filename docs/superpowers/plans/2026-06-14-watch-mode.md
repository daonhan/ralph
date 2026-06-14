# Watch / Daemon Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a polling daemon mode to `ralph-ghafk` (`--watch`): idle → poll for labelled open issues → run the loop → idle, with daemon-cumulative budget and clean Ctrl+C.

**Architecture:** New `watch.ts` (`runWatch`) owns the wake-lock + signals for the daemon's whole life and calls `runLoop` per trigger. `runLoop` gains an optional injected `AbortSignal` (skips its own signal/keepalive ownership) and returns a `LoopOutcome { costUsd, sentinelHit }`. `withRetries` stops retrying `AbortError`s.

**Tech Stack:** Node ≥20 ESM (relative imports end `.js`), vitest. Watch is **ghafk-only**.

**Spec:** `docs/superpowers/specs/2026-06-14-watch-mode-design.md`

---

## File Structure

| File                            | Change                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core/src/retry.ts`    | `withRetries` rethrows `AbortError` without retry.                                           |
| `packages/core/src/loop.ts`     | `LoopOptions.signal?`; return `LoopOutcome`; skip own signal/keepalive when signal injected. |
| `packages/core/src/watch.ts`    | **new** — `runWatch` + `openIssueCount`.                                                     |
| `packages/core/src/cli-help.ts` | `--watch` / `--watch-interval` flags + print-config.                                         |
| `packages/core/src/run-bin.ts`  | `supportsWatch`; dispatch to `runWatch`.                                                     |
| `packages/core/src/gh-main.ts`  | `supportsWatch: true`.                                                                       |
| `packages/core/src/index.ts`    | export `runWatch`, `LoopOutcome`.                                                            |

---

## Task 1: `withRetries` bails on AbortError (TDD)

**Files:** Modify `packages/core/src/retry.ts`, `packages/core/src/__tests__/retry.test.ts`.

- [ ] **Step 1: Failing test** (append to `retry.test.ts`):

```ts
it("does not retry an AbortError — rethrows immediately", async () => {
  const fn = vi.fn(async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  });
  await expect(withRetries(fn, { max: 3, backoffMs: 1 })).rejects.toMatchObject(
    { name: "AbortError" }
  );
  expect(fn).toHaveBeenCalledTimes(1); // no retries
});
```

(Use the file's existing import style for `withRetries`/`vi`.)

- [ ] **Step 2: Run → fail.** `pnpm --filter @daonhan/ralph-core test -- retry`

- [ ] **Step 3: Implement.** In `withRetries`, in the catch before scheduling a retry, add:

```ts
if ((err as Error)?.name === "AbortError") throw err;
```

Place it so an AbortError skips both the `onAttempt` backoff and the retry loop (rethrow immediately, regardless of remaining attempts).

- [ ] **Step 4: Run → pass.** Confirm existing retry tests still pass.

- [ ] **Step 5: Commit** — `git commit -am "fix(retry): never retry an AbortError"`

## Task 2: `runLoop` injected signal + `LoopOutcome` (TDD)

**Files:** Modify `packages/core/src/loop.ts`, `packages/core/src/index.ts`, `packages/core/src/__tests__/loop.test.ts`.

- [ ] **Step 1: Tests.** Add to `loop.test.ts`:

```ts
it("returns a LoopOutcome with accumulated cost and sentinel flag", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);
  mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));
  const outcome = await runLoop(loopOptions(dirs));
  expect(outcome).toMatchObject({ sentinelHit: true });
  expect(outcome.costUsd).toBeCloseTo(0.25);
});

it("uses an injected signal and installs no process signal handlers", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);
  mocks.runStage.mockResolvedValue(ok(sentinel));
  const before = process.listenerCount("SIGINT");
  const ac = new AbortController();
  await runLoop(loopOptions(dirs, { signal: ac.signal }));
  expect(process.listenerCount("SIGINT")).toBe(before); // none added/left behind
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** In `loop.ts`:

(a) Add to `LoopOptions`: `signal?: AbortSignal;`. Export the outcome type:

```ts
export type LoopOutcome = { costUsd: number; sentinelHit: boolean };
```

Change `runLoop`'s return type to `Promise<LoopOutcome>`.

(b) Destructure `signal` from opts. Replace `const stageAbort = new AbortController();` usage with an external/internal split:

```ts
const externalSignal = opts.signal;
const stageAbort = externalSignal ? undefined : new AbortController();
const activeSignal = externalSignal ?? stageAbort!.signal;
```

Use `activeSignal` everywhere the code currently passes `stageAbort.signal` (the `executeStage`/`runStage` calls).

(c) Wake-lock + signal handlers only when **not** injected. Wrap the `acquire(...)` and the `process.on("SIGINT"/"SIGTERM", …)` registration (and their `process.off` in `finally`) in `if (!externalSignal) { … }`. When `externalSignal` is set, skip them entirely (the caller owns wake-lock + signals; `noKeepAlive` is also passed by watch but the `!externalSignal` guard is what gates handler installation).

(d) Abort-aware stage catch: in the catch around the stage execution, if `activeSignal.aborted`, stop the run quietly:

```ts
} catch (err) {
  if (activeSignal.aborted) { sentinelHit = false; return { costUsd: runCostUsd, sentinelHit }; }
  // …existing [failure] marker logging + break…
}
```

(e) Every `return;` / fall-through that currently ends the function must return a `LoopOutcome`. Track `sentinelHit` (already exists) and `runCostUsd` (already exists); the sentinel-hit early return, the budget-stop return, and the normal end all `return { costUsd: runCostUsd, sentinelHit }`.

(f) Export from `index.ts`: add `type LoopOutcome` to the loop export.

- [ ] **Step 4: Run → pass.** Full loop suite must stay green (existing no-signal tests ignore the return value).

- [ ] **Step 5: Commit** — `git commit -am "feat(loop): injected signal + LoopOutcome return for daemon callers"`

## Task 3: `watch.ts` — `runWatch` + `openIssueCount` (TDD)

**Files:** Create `packages/core/src/watch.ts`, `packages/core/src/__tests__/watch.test.ts`.

- [ ] **Step 1: Failing test** (mock keepalive, loop, pacing; inject the issue-count fn):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage } from "../stages.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  runLoop: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("../keepalive.js", () => ({ acquire: mocks.acquire }));
vi.mock("../loop.js", () => ({ runLoop: mocks.runLoop }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { runWatch } from "../watch.js";

const stage: Stage = { name: "ghafk-implementer", template: "ghafk.md" };
const baseOpts = (over = {}) => ({
  stages: [stage] as [Stage],
  iterations: 3,
  workspaceDir: "/ws",
  packageDir: "/pkg",
  watchIntervalSec: 60,
  watchLabel: "ralph",
  countIssues: mocks.countIssues,
  ...over,
});

describe("runWatch", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) (m as any).mockReset?.();
    mocks.acquire.mockReturnValue({ release: mocks.release });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs the loop when issues exist and stops on cumulative budget", async () => {
    // countIssues injected via opts; returns 1 (work) each poll.
    const countIssues = vi.fn(() => 1);
    mocks.runLoop.mockResolvedValue({ costUsd: 6, sentinelHit: true });
    // sleep resolves immediately; after budget is hit the loop breaks.
    mocks.sleep.mockResolvedValue(undefined);
    await runWatch(baseOpts({ countIssues, budgetUsd: 11 }));
    // run1 cum 6 (<11) → run2 cum 12 (>=11) → stop before run3
    expect(mocks.runLoop).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("skips the loop and keeps polling when no issues / gh fails", async () => {
    let polls = 0;
    const countIssues = vi.fn(() => {
      polls++;
      return 0;
    });
    mocks.sleep.mockImplementation(() =>
      polls >= 3
        ? Promise.reject(
            Object.assign(new Error("stop"), { name: "AbortError" })
          )
        : Promise.resolve()
    );
    await runWatch(baseOpts({ countIssues })).catch(() => {});
    expect(mocks.runLoop).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
```

> Design `runWatch` to accept an optional `countIssues` in its options for testability, defaulting to the real `openIssueCount`. The daemon-stop in the no-issues test is simulated by `sleep` rejecting with an AbortError after a few polls (mirrors Ctrl+C aborting the sleep).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `watch.ts`**

```ts
import { execSync } from "node:child_process";
import { acquire, type Releaser } from "./keepalive.js";
import { runLoop } from "./loop.js";
import { notifyComplete, notifyError } from "./notify.js";
import { sleep } from "./pacing.js";
import {
  bold,
  dim,
  greenOut,
  boldOut,
  dimOut,
  SYM_OUT,
  USE_COLOR,
} from "./stream-render.js";
import type { Stage } from "./stages.js";

/** Count open issues carrying `label`, via gh. Returns 0 on any failure (keep polling). */
export function openIssueCount(label: string, cwd: string): number {
  try {
    const out = execSync(
      `gh issue list --state open --label ${JSON.stringify(label)} --json number`,
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const arr = JSON.parse(out) as unknown[];
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    process.stderr.write(
      `${dim(`gh issue poll failed (label ${label}) — treating as no work`)}\n`
    );
    return 0;
  }
}

export type RunWatchOptions = {
  stages: [Stage, ...Stage[]];
  iterations: number;
  workspaceDir: string;
  packageDir: string;
  watchIntervalSec: number;
  watchLabel: string;
  budgetUsd?: number;
  cooldownMs?: number;
  notify?: boolean;
  bin?: string;
  cliVersion?: string;
  /** Injectable for tests; defaults to openIssueCount. */
  countIssues?: (label: string, cwd: string) => number;
};

export async function runWatch(opts: RunWatchOptions): Promise<void> {
  const {
    stages,
    iterations,
    workspaceDir,
    packageDir,
    watchIntervalSec,
    watchLabel,
    budgetUsd,
    cooldownMs,
    notify = false,
    bin = "ralph-ghafk",
    countIssues = openIssueCount,
  } = opts;

  const releaser: Releaser = acquire({ reason: `${bin} watch` });
  let released = false;
  const releaseOnce = (): void => {
    if (!released) {
      released = true;
      releaser.release();
    }
  };
  const daemonAbort = new AbortController();

  const onSig = (code: number) => (): void => {
    daemonAbort.abort();
    if (notify) notifyError(`watch stopped (signal)`);
    releaseOnce();
    process.exit(code);
  };
  const onSigint = onSig(130);
  const onSigterm = onSig(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  process.stderr.write(
    `${USE_COLOR ? dim("watching") + " " + bold(`label:${watchLabel} every ${watchIntervalSec}s`) : `watching label:${watchLabel} every ${watchIntervalSec}s`}\n`
  );

  let cumulativeCost = 0;
  try {
    for (;;) {
      if (budgetUsd != null && cumulativeCost >= budgetUsd) {
        process.stdout.write(
          `${greenOut(SYM_OUT.bullet)} ${boldOut("watch budget reached")}${dimOut(` $${cumulativeCost.toFixed(2)} ≥ $${budgetUsd.toFixed(2)} — stopping`)}\n`
        );
        if (notify) notifyComplete(0, false);
        return;
      }
      const count = countIssues(watchLabel, workspaceDir);
      if (count > 0) {
        process.stderr.write(
          `${dim(`${count} open issue(s) labelled ${watchLabel} — running loop`)}\n`
        );
        const remaining =
          budgetUsd != null ? budgetUsd - cumulativeCost : undefined;
        const outcome = await runLoop({
          stages,
          inputs: "",
          iterations,
          workspaceDir,
          packageDir,
          budgetUsd: remaining,
          cooldownMs,
          noKeepAlive: true,
          signal: daemonAbort.signal,
          bin,
          cliVersion: opts.cliVersion,
        });
        cumulativeCost += outcome.costUsd;
        process.stderr.write(
          `${dim(`watch run done — cumulative $${cumulativeCost.toFixed(2)}`)}\n`
        );
      }
      await sleep(watchIntervalSec * 1000, daemonAbort.signal);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    releaseOnce();
  }
}
```

- [ ] **Step 4: Run → pass.** `pnpm --filter @daonhan/ralph-core test -- watch`

- [ ] **Step 5: Commit** — `git add packages/core/src/watch.ts packages/core/src/__tests__/watch.test.ts && git commit -m "feat(watch): runWatch daemon — poll labelled issues, cumulative budget"`

## Task 4: CLI flags + run-bin dispatch + gh-main

**Files:** Modify `cli-help.ts`, `run-bin.ts`, `gh-main.ts`, `index.ts`.

- [ ] **Step 1: `cli-help.ts`.** Add `watch: boolean; watchIntervalSec?: number;` to `CliFlags`. Parse `--watch` (boolean) and `--watch-interval <sec>` (expecting-value, validate `/^\d+$/` and `> 0`, else throw `--watch-interval must be a positive integer (seconds), got: …`). Document both in `printHelp` plus the `RALPH_WATCH_LABEL` env var. In `PrintConfigOptions` add `watch?: boolean; watchIntervalSec?: number;` and print:

```
  watch                 ${watch ? `on (every ${watchIntervalSec ?? 300}s, label "${process.env.RALPH_WATCH_LABEL?.trim() || "ralph"}")` : "off"}
```

- [ ] **Step 2: `run-bin.ts`.** Add `supportsWatch?: boolean;` to `RunBinConfig`. After validating positional args, before the `runLoop` call:

```ts
if (flags.watch) {
  if (!cfg.supportsWatch) {
    console.error("--watch is only supported by ralph-ghafk");
    process.exit(1);
  }
  const { runWatch } = await import("./watch.js");
  await runWatch({
    stages: cfg.stages,
    iterations,
    workspaceDir,
    packageDir,
    watchIntervalSec: flags.watchIntervalSec ?? 300,
    watchLabel: process.env.RALPH_WATCH_LABEL?.trim() || "ralph",
    budgetUsd: flags.budget,
    cooldownMs: flags.cooldownMs,
    notify: flags.notify,
    bin: cfg.bin,
    cliVersion: cfg.cliVersion,
  });
  return;
}
```

Pass `watch: flags.watch, watchIntervalSec: flags.watchIntervalSec` into the `printConfig(...)` opts too.

- [ ] **Step 3: `gh-main.ts`.** Add `supportsWatch: true` to the `runBin` config object. Leave `main.ts` without it.

- [ ] **Step 4: `index.ts`.** Add `export { runWatch, type RunWatchOptions } from "./watch.js";`.

- [ ] **Step 5: Verify + commit.**

```bash
pnpm -r typecheck && pnpm -r test && pnpm test
node apps/cli/bin/ralph-ghafk.js --print-config --watch --watch-interval 120 1   # → watch on (every 120s, label "ralph")
node apps/cli/bin/ralph-afk.js --watch x 1   # → errors: --watch is only supported by ralph-ghafk
```

`git commit -am "feat(cli): --watch / --watch-interval; ghafk-only dispatch to runWatch"`

## Task 5: Full verification + live watch smoke

- [ ] **Step 1: Gate.** `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm test` → green.

- [ ] **Step 2: print-config matrix** (no model calls):
  - `ralph-ghafk --print-config --watch 1` → `watch  on (every 300s, label "ralph")`.
  - `RALPH_WATCH_LABEL=bot ralph-ghafk --print-config --watch --watch-interval 30 1` → label "bot", every 30s.
  - `ralph-afk --watch x 1` → ghafk-only error.

- [ ] **Step 3: Live watch smoke (needs a gh-authed repo; surface to the human).** In a throwaway repo with the `gh` remote: `RALPH_WATCH_LABEL=ralph ralph-ghafk --watch --watch-interval 15 1`. With **no** labelled issues, it should idle ("0 open issues… ") and poll every 15s; add a `ralph`-labelled issue → next poll runs the loop; `Ctrl+C` → clean exit, wake-lock released. (Cheap to validate idle/poll without any model call by just leaving it label-less for two polls then Ctrl+C.)

- [ ] **Step 4: Commit fallout** — `git commit -am "test: verify watch mode wiring" || echo "nothing to commit"`

---

## Self-Review (completed)

- **Spec coverage:** AbortError-no-retry (T1), injected signal + LoopOutcome + ownership skip (T2), runWatch + openIssueCount + cumulative budget + gh-failure-degrade + signal ownership (T3), flags + ghafk-only dispatch + print-config (T4), verification (T5). ✓
- **Placeholders:** none — full code for `watch.ts`, test bodies, and every edit. ✓
- **Type consistency:** `LoopOutcome { costUsd, sentinelHit }`, `RunWatchOptions`, `runLoop(...): Promise<LoopOutcome>`, `CliFlags.{watch,watchIntervalSec}`, `RunBinConfig.supportsWatch`, `openIssueCount(label,cwd)` consistent across tasks. ✓
- **Non-breaking:** injected-signal/return-value are additive; no-`--watch` path unchanged; existing loop/retry suites guard it. ✓
