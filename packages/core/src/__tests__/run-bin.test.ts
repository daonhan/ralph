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
