import { describe, expect, it } from "vitest";

import { parseGraceMs, resolveModelArgs } from "../runner.js";

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
