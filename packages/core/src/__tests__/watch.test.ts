import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage } from "../stages.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  runLoop: vi.fn(),
  sleep: vi.fn(),
  countIssues: vi.fn(),
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
