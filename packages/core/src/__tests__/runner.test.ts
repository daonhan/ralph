import { describe, expect, it } from "vitest";

import { buildClaudeArgs, parseGraceMs, resolveModelArgs } from "../runner.js";

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
});
