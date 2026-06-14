import { describe, expect, it } from "vitest";

import {
  buildClaudeArgs,
  buildSandboxSettings,
  parseGraceMs,
  resolveModelArgs,
  resolveRunner,
  resolveSandboxNet,
  resultFromEvent,
} from "../runner.js";

describe("parseGraceMs", () => {
  it("returns the default when unset", () => {
    expect(parseGraceMs(undefined)).toBe(30_000);
  });

  it("returns the default for an empty string", () => {
    expect(parseGraceMs("")).toBe(30_000);
  });

  it("returns the default for whitespace-only input", () => {
    expect(parseGraceMs("   ")).toBe(30_000);
  });

  it("returns the default for non-numeric input", () => {
    expect(parseGraceMs("abc")).toBe(30_000);
  });

  it("returns the default for negative input", () => {
    expect(parseGraceMs("-5")).toBe(30_000);
  });

  it("returns 0 when explicitly set to 0 (disabled)", () => {
    expect(parseGraceMs("0")).toBe(0);
  });

  it("returns the parsed value for a valid integer", () => {
    expect(parseGraceMs("45000")).toBe(45_000);
  });

  it("floors fractional values", () => {
    expect(parseGraceMs("1500.9")).toBe(1500);
  });

  it("honors a custom default", () => {
    expect(parseGraceMs(undefined, 1000)).toBe(1000);
    expect(parseGraceMs("abc", 1000)).toBe(1000);
  });
});

describe("resolveModelArgs", () => {
  it("returns [] when unset", () => {
    expect(resolveModelArgs(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(resolveModelArgs("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(resolveModelArgs("   ")).toEqual([]);
  });

  it("returns --model + alias for a short alias", () => {
    expect(resolveModelArgs("opus")).toEqual(["--model", "opus"]);
  });

  it("returns --model + full id for a full model spec", () => {
    expect(resolveModelArgs("claude-opus-4-8")).toEqual([
      "--model",
      "claude-opus-4-8",
    ]);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveModelArgs("  opus  ")).toEqual(["--model", "opus"]);
  });
});

describe("resolveRunner", () => {
  it("defaults to sandbox when unset", () => {
    expect(resolveRunner(undefined)).toBe("sandbox");
  });
  it("defaults to sandbox for empty / unknown values", () => {
    expect(resolveRunner("")).toBe("sandbox");
    expect(resolveRunner("docker")).toBe("sandbox");
  });
  it("selects host only for the literal 'host'", () => {
    expect(resolveRunner("host")).toBe("host");
    expect(resolveRunner("  host  ")).toBe("host");
  });
});

describe("resolveSandboxNet", () => {
  it("returns [] when unset or empty", () => {
    expect(resolveSandboxNet(undefined)).toEqual([]);
    expect(resolveSandboxNet("   ")).toEqual([]);
  });
  it("splits, trims, and drops empties", () => {
    expect(resolveSandboxNet("github.com, api.anthropic.com,")).toEqual([
      "github.com",
      "api.anthropic.com",
    ]);
  });
});

describe("buildSandboxSettings", () => {
  it("confines writes to the workspace, excludes Go-TLS CLIs, omits network when no domains", () => {
    expect(buildSandboxSettings("/ws", [])).toEqual({
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: ["/ws"] },
        excludedCommands: ["gh *", "gcloud *", "terraform *"],
      },
    });
  });
  it("adds an allowedDomains network block when domains are given", () => {
    expect(buildSandboxSettings("/ws", ["github.com"])).toEqual({
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: ["/ws"] },
        excludedCommands: ["gh *", "gcloud *", "terraform *"],
        network: { allowedDomains: ["github.com"] },
      },
    });
  });
});

describe("resultFromEvent", () => {
  it("extracts result/cost/error fields from a result event", () => {
    expect(
      resultFromEvent({
        type: "result",
        result: "done",
        total_cost_usd: 0.39,
        is_error: false,
        api_error_status: null,
      })
    ).toEqual({
      result: "done",
      costUsd: 0.39,
      isError: false,
      apiErrorStatus: null,
    });
  });
  it("defaults missing fields safely", () => {
    expect(resultFromEvent({})).toEqual({
      result: "",
      costUsd: 0,
      isError: false,
      apiErrorStatus: null,
    });
  });
  it("captures an error status string", () => {
    expect(
      resultFromEvent({ is_error: true, api_error_status: "429" })
    ).toMatchObject({
      isError: true,
      apiErrorStatus: "429",
    });
  });
});

describe("buildClaudeArgs", () => {
  const stage = { name: "test", template: "test.md" };
  const stageWithPermissionMode = {
    name: "test",
    template: "test.md",
    permissionMode: "bypassPermissions",
  };
  const promptPath = ".ralph-tmp/prompt.md";

  it("includes the claude invocation and prompt instruction", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args[0]).toBe("claude");
    expect(args).toContain("--verbose");
    expect(args).toContain("--print");
    expect(args.at(-1)).toContain(promptPath);
  });

  it("appends --model args when RALPH_MODEL is set", () => {
    const args = buildClaudeArgs(stage, promptPath, ["--model", "opus"]);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("opus");
  });

  it("does not include --model when modelArgs is empty", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--model");
  });

  it("includes --permission-mode when stage has permissionMode", () => {
    const args = buildClaudeArgs(stageWithPermissionMode, promptPath, []);
    expect(args).toContain("--permission-mode");
    const idx = args.indexOf("--permission-mode");
    expect(args[idx + 1]).toBe("bypassPermissions");
  });

  it("omits --permission-mode when stage has no permissionMode", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--permission-mode");
  });

  it("places --model args before the prompt instruction", () => {
    const args = buildClaudeArgs(stage, promptPath, ["--model", "opus"]);
    const modelIdx = args.indexOf("--model");
    const promptIdx = args.findIndex((a) => a.includes(promptPath));
    expect(modelIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeLessThan(promptIdx);
  });

  it("injects --settings before the prompt when a settings path is given", () => {
    const args = buildClaudeArgs(
      stage,
      promptPath,
      [],
      "/ws/.ralph-tmp/s.json"
    );
    const sIdx = args.indexOf("--settings");
    expect(sIdx).toBeGreaterThan(-1);
    expect(args[sIdx + 1]).toBe("/ws/.ralph-tmp/s.json");
    const promptIdx = args.findIndex((a) => a.includes(promptPath));
    expect(sIdx).toBeLessThan(promptIdx);
  });

  it("omits --settings when no settings path is given", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--settings");
  });
});
