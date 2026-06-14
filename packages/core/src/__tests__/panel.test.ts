import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { runPanel } from "../panel.js";

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
const noStop = () => ({ stop: false, cooldownFactor: 1 });

describe("runPanel", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "ralph-panel-"));
    mocks.executeStage.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  it("runs each lens then synth, writes findings, reports each sub-agent, returns synth", async () => {
    mocks.executeStage.mockImplementation(
      (opts: { stage: { template: string }; vars: { LENS?: string } }) =>
        Promise.resolve(
          opts.stage.template === "review-synth.md"
            ? ok("<review>OK</review>", 0.5)
            : ok(`finding for ${opts.vars.LENS}`, 0.1)
        )
    );
    const seen: number[] = [];
    const out = await runPanel({
      lenses: ["correctness", "security", "tests"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 1000,
      onStage: (sr) => {
        seen.push(sr.costUsd);
        return noStop();
      },
    });
    expect(mocks.executeStage).toHaveBeenCalledTimes(4); // 3 lenses + synth
    const templates = mocks.executeStage.mock.calls.map(
      (c: [{ stage: { template: string } }]) => c[0].stage.template
    );
    expect(templates).toEqual([
      "review-lens.md",
      "review-lens.md",
      "review-lens.md",
      "review-synth.md",
    ]);
    expect(mocks.sleep).toHaveBeenCalledTimes(3); // cooldown after each lens
    // onStage called for every sub-agent (3 lenses + synth)
    expect(seen).toEqual([0.1, 0.1, 0.1, 0.5]);
    expect(out.result).toBe("<review>OK</review>");
  });

  it("stops before remaining lenses + synth when onStage signals the budget is spent", async () => {
    mocks.executeStage.mockResolvedValue(ok("finding", 0.4));
    const out = await runPanel({
      lenses: ["correctness", "security", "tests"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 1000,
      onStage: () => ({ stop: true, cooldownFactor: 1 }), // budget hit after lens 1
    });
    expect(mocks.executeStage).toHaveBeenCalledTimes(1); // no further lenses, no synth
    expect(mocks.sleep).not.toHaveBeenCalled(); // stopped before the cooldown
    expect(out.result).toBe("finding");
  });

  it("applies the adaptive cooldown factor from onStage to the inter-lens sleep", async () => {
    mocks.executeStage.mockResolvedValue(ok("finding", 0));
    await runPanel({
      lenses: ["correctness", "security"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 1000,
      onStage: () => ({ stop: false, cooldownFactor: 4 }), // throttled → ×4
    });
    expect(mocks.sleep).toHaveBeenCalledWith(4000, undefined);
  });

  it("enforces lens read-only: a lens that commits is reset back to the implementer's HEAD", async () => {
    // Real git repo so the panel's git guard runs for real.
    const g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: ws,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    g("init", "-q");
    g(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "impl"
    );
    const baseHead = g("rev-parse", "HEAD").trim();

    mocks.executeStage.mockImplementation(
      (opts: { stage: { template: string } }) => {
        if (opts.stage.template === "review-lens.md") {
          // A misbehaving lens makes a commit despite the read-only contract.
          g(
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "sneaky"
          );
        }
        return Promise.resolve(ok("finding"));
      }
    );

    await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      onStage: noStop,
    });

    // The sneaky lens commit was undone; HEAD is back at the implementer's commit.
    expect(g("rev-parse", "HEAD").trim()).toBe(baseHead);
  });

  it("does NOT discard pre-existing uncommitted tracked changes (enforcement off when dirty)", async () => {
    const g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: ws,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    g("init", "-q");
    writeFileSync(join(ws, "f.txt"), "committed\n");
    g("add", "f.txt");
    g(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "impl"
    );
    // A pre-existing uncommitted tracked modification by the user.
    writeFileSync(join(ws, "f.txt"), "user edit in progress\n");

    // A well-behaved lens touches nothing.
    mocks.executeStage.mockResolvedValue(ok("finding"));

    await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      onStage: noStop,
    });

    // The user's in-progress edit is intact — the guard did not reset --hard it away.
    expect(readFileSync(join(ws, "f.txt"), "utf8")).toBe(
      "user edit in progress\n"
    );
  });
});
