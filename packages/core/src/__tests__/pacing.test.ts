import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep, isThrottle, nextCooldownFactor } from "../pacing.js";

describe("isThrottle", () => {
  it("matches throttle signals case-insensitively", () => {
    for (const s of ["429", "Overloaded", "rate_limit", "rate limit"]) {
      expect(isThrottle(s)).toBe(true);
    }
  });
  it("is false for null / non-throttle", () => {
    expect(isThrottle(null)).toBe(false);
    expect(isThrottle("internal_server_error")).toBe(false);
  });
});

describe("nextCooldownFactor", () => {
  it("resets to 1 when not throttled", () => {
    expect(nextCooldownFactor(8, false)).toBe(1);
  });
  it("doubles up to the cap when throttled", () => {
    expect(nextCooldownFactor(1, true)).toBe(2);
    expect(nextCooldownFactor(4, true)).toBe(8);
    expect(nextCooldownFactor(8, true)).toBe(8); // capped
  });
});

describe("sleep", () => {
  afterEach(() => vi.useRealTimers());
  it("resolves immediately for ms <= 0", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
  it("rejects with AbortError when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(1000, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("rejects when aborted mid-wait", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
