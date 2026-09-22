import { afterEach, describe, expect, it, vi } from "vitest";

const runLoopMock = vi.hoisted(() => vi.fn());

vi.mock("../loop.js", () => ({
  runLoop: runLoopMock,
}));

import { runBin, type RunBinConfig } from "../run-bin.js";

const stage = { name: "implementer", template: "afk.md" };

function config(takesInputArg: boolean): RunBinConfig {
  return {
    bin: takesInputArg ? "ralph-afk" : "ralph-ghafk",
    usage: takesInputArg ? "<plan-and-prd> <iterations>" : "<iterations>",
    desc: "test",
    stages: [stage],
    takesInputArg,
  };
}

afterEach(() => {
  runLoopMock.mockReset();
  delete process.env.RALPH_AGENT;
  process.exitCode = undefined;
});

describe("runBin exit status", () => {
  it.each([
    ["no-more-tasks", undefined],
    ["cap", undefined],
    ["failed", 1],
    ["refused", 75],
  ])("maps a %s run to exit code %s", async (reason, code) => {
    runLoopMock.mockResolvedValue(reason);
    await runBin(["2"], config(false));
    expect(process.exitCode).toBe(code);
  });
});

describe("runBin agent forwarding", () => {
  it("forwards explicit Codex settings for ralph-afk", async () => {
    await runBin(
      ["--agent", "codex", "--codex-user-config", "plan.md", "2"],
      config(true)
    );
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        codexUserConfig: true,
        inputs: "plan.md",
        iterations: 2,
      })
    );
  });

  it("forwards RALPH_AGENT for ralph-ghafk", async () => {
    process.env.RALPH_AGENT = "codex";
    await runBin(["2"], config(false));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        codexUserConfig: false,
        inputs: "",
        iterations: 2,
      })
    );
  });

  it("forwards --model and --effort", async () => {
    await runBin(["--model", "m", "--effort", "high", "2"], config(false));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "m", effort: "high" })
    );
  });

  it.each([
    [true, ["--agent", "codex", "--effort", "ultra", "plan.md", "2"]],
    [false, ["--agent", "codex", "--effort", "ultra", "2"]],
  ])("forwards Ultra through either bin", async (takesInputArg, argv) => {
    await runBin(argv, config(takesInputArg));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex", effort: "ultra" })
    );
  });

  it("keeps Claude as the default", async () => {
    await runBin(["plan.md", "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude",
        codexUserConfig: false,
      })
    );
  });

  it("rejects Codex user config with Claude", async () => {
    await expect(
      runBin(["--codex-user-config", "plan.md", "1"], config(true))
    ).rejects.toThrow(
      "--codex-user-config requires Codex; select it with --agent codex or RALPH_AGENT=codex"
    );
    expect(runLoopMock).not.toHaveBeenCalled();
  });
});
