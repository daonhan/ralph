import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "../stages.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  notifyComplete: vi.fn(),
  notifyError: vi.fn(),
  release: vi.fn(),
  runStage: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("../keepalive.js", () => ({
  acquire: mocks.acquire,
}));

vi.mock("../notify.js", () => ({
  notifyComplete: mocks.notifyComplete,
  notifyError: mocks.notifyError,
}));

vi.mock("../runner.js", () => ({
  runStage: mocks.runStage,
  stageLogPath: (workspaceDir: string, iteration: number, stageName: string) =>
    join(
      workspaceDir,
      ".ralph-tmp",
      "logs",
      `iter${iteration}-${stageName}.ndjson`
    ),
}));

vi.mock("../pacing.js", () => ({
  sleep: mocks.sleep,
  isThrottle: (s: string | null) =>
    s != null && /429|overload|rate.?limit/i.test(s),
  nextCooldownFactor: (prev: number, throttled: boolean, cap = 8) =>
    throttled ? Math.min(prev * 2, cap) : 1,
}));

vi.mock("../stream-render.js", () => ({
  USE_COLOR: false,
  dim: (s: string) => s,
  bold: (s: string) => s,
  red: (s: string) => s,
  greenOut: (s: string) => s,
  boldOut: (s: string) => s,
  dimOut: (s: string) => s,
  SYM: { cross: "FAIL" },
  SYM_OUT: { bullet: "*" },
}));

import { runLoop } from "../loop.js";

const stage: Stage = { name: "implementer", template: "stage.md" };
const sentinel = "<promise>NO MORE TASKS</promise>";

// Helper to build a StageResult-shaped object.
const ok = (
  result: string,
  costUsd = 0,
  apiErrorStatus: string | null = null
) => ({
  result,
  costUsd,
  isError: apiErrorStatus != null,
  apiErrorStatus,
});

type LoopDirs = {
  root: string;
  packageDir: string;
  workspaceDir: string;
};

function makeDirs(): LoopDirs {
  const root = mkdtempSync(join(tmpdir(), "ralph-loop-"));
  const packageDir = join(root, "sandcastle");
  const workspaceDir = join(root, "workspace");

  mkdirSync(join(packageDir, "templates"), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(packageDir, "templates", stage.template),
    "run {{ INPUTS }}",
    "utf8"
  );

  return { root, packageDir, workspaceDir };
}

function loopOptions(dirs: LoopDirs, overrides = {}) {
  return {
    stages: [stage] as [Stage],
    inputs: "plan",
    iterations: 1,
    workspaceDir: dirs.workspaceDir,
    packageDir: dirs.packageDir,
    ...overrides,
  };
}

describe("runLoop", () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.useRealTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.acquire.mockReturnValue({ release: mocks.release });
    mocks.sleep.mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("acquires the wake-lock and releases on completion", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { notify: true }));

    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.notifyComplete).toHaveBeenCalledWith(1, true);
  });

  it("prints the cli + core version banner at loop init", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk", cliVersion: "9.9.9" }));

    const stderr = (
      process.stderr.write as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(stderr).toContain("ralph-afk 9.9.9 (core ");
  });

  it("uses the bin name in the wake-lock reason", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-ghafk" }));

    expect(mocks.acquire).toHaveBeenCalledWith({ reason: "ralph-ghafk loop" });
  });

  it("logs terminal stage failure and continues with the next iteration", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(ok(sentinel));

    await runLoop(loopOptions(dirs, { iterations: 2, maxRetries: 0 }));

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    const firstLog = readFileSync(
      join(dirs.workspaceDir, ".ralph-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(firstLog).toContain(
      "[failure] iteration 1 stage implementer failed after 0 retries: boom"
    );
  });

  it("retries a failed stage before continuing", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValueOnce(ok(sentinel));

    const loop = runLoop(loopOptions(dirs, { maxRetries: 1 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await loop;

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    const firstLog = readFileSync(
      join(dirs.workspaceDir, ".ralph-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(firstLog).toContain("[retry] attempt 1 of 1 after 5000 ms");
  });

  it("retries a failing render and surfaces it as a terminal failure (no false completion)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    // Template whose shell tag always fails — emulates a flaky `gh issue list`.
    // Such a failure must abort/retry the stage, never silently degrade the
    // prompt into a false `<promise>NO MORE TASKS</promise>` completion.
    const failStage: Stage = { name: "implementer", template: "fail.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "fail.md"),
      "!`exit 1`",
      "utf8"
    );

    await runLoop(
      loopOptions(dirs, { stages: [failStage] as [Stage], maxRetries: 0 })
    );

    // Render threw before the stage ran: runStage never invoked, loop did not
    // reject, and the terminal failure was logged.
    expect(mocks.runStage).not.toHaveBeenCalled();
    const log = readFileSync(
      join(dirs.workspaceDir, ".ralph-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(log).toContain("[failure] iteration 1 stage implementer failed");
  });

  it("aborts the active stage and releases the wake-lock on SIGINT", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    let capturedSignal: AbortSignal | undefined;
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) => {
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          capturedSignal!.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      }
    );

    const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    expect(() => process.emit("SIGINT")).toThrow("exit 130");

    expect(capturedSignal?.aborted).toBe(true);
    await loop;
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("aborts the active stage and releases the wake-lock on SIGTERM", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    let capturedSignal: AbortSignal | undefined;
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) => {
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          capturedSignal!.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      }
    );

    const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    expect(() => process.emit("SIGTERM")).toThrow("exit 143");
    expect(capturedSignal?.aborted).toBe(true);
    await loop;
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("stops cleanly once cumulative cost reaches the budget", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const reviewer: Stage = { name: "reviewer", template: "stage.md" };
    // Each implementer stage costs $0.60; reviewer $0; never emits the sentinel.
    mocks.runStage.mockImplementation((s) =>
      Promise.resolve(
        ok(
          s.name === "implementer" ? "keep going" : "ok",
          s.name === "implementer" ? 0.6 : 0
        )
      )
    );
    await runLoop(
      loopOptions(dirs, {
        stages: [stage, reviewer] as [Stage, Stage],
        iterations: 5,
        budgetUsd: 1.0,
        maxRetries: 0,
      })
    );
    // iter1: impl(0.6)+rev(0) = 0.6 < 1.0 → iter2 impl pushes to 1.2; budget halts before iter2 reviewer or iter3.
    // implementer ran twice, reviewer ran once.
    const implCalls = mocks.runStage.mock.calls.filter(
      (c) => c[0].name === "implementer"
    ).length;
    expect(implCalls).toBe(2);
  });

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

  it("sleeps between iterations when a cooldown is set", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok("keep going")); // never sentinel
    // Override the sleep mock to actually resolve after fake timer advances.
    mocks.sleep.mockImplementation(
      (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    );
    const loop = runLoop(
      loopOptions(dirs, { iterations: 2, cooldownMs: 3000, maxRetries: 0 })
    );
    // Let iter1 run to completion (runStage mock resolves immediately).
    await vi.advanceTimersByTimeAsync(0);
    // After iter1, the loop should be parked in sleep(3000).
    // Advance past the cooldown to let iter2 run.
    await vi.advanceTimersByTimeAsync(3000);
    await loop;
    expect(mocks.runStage).toHaveBeenCalledTimes(2);
  });
});
