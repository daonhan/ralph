import { describe, expect, it, vi } from "vitest";

import { withRetries, backoffFor } from "../retry.js";

describe("withRetries", () => {
  it("returns on first-attempt success without delay", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onAttempt = vi.fn();

    const result = await withRetries(fn, {
      max: 3,
      backoffMs: [5_000, 30_000, 120_000],
      onAttempt,
      sleep,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
  });

  it("succeeds on third attempt with [5s, 30s] waits", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withRetries(fn, {
      max: 3,
      backoffMs: [5_000, 30_000, 120_000],
      sleep,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 30_000]);
  });

  it("persistent failure with max: 3 throws last error after four total calls and [5s, 30s, 2m] waits", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockRejectedValueOnce(new Error("e3"))
      .mockRejectedValueOnce(new Error("e4"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetries(fn, {
        max: 3,
        backoffMs: [5_000, 30_000, 120_000],
        sleep,
      })
    ).rejects.toThrow("e4");

    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 30_000, 120_000]);
  });

  it("max: 0 throws immediately after a single call with no delays", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetries(fn, { max: 0, backoffMs: [5_000], sleep })
    ).rejects.toThrow("boom");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("onAttempt fires before each retry with (attemptNumber, error) in order", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onAttempt = vi.fn();

    await withRetries(fn, {
      max: 3,
      backoffMs: [10, 20, 30],
      onAttempt,
      sleep,
    });

    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttempt.mock.calls[0][0]).toBe(1);
    expect((onAttempt.mock.calls[0][1] as Error).message).toBe("e1");
    expect(onAttempt.mock.calls[1][0]).toBe(2);
    expect((onAttempt.mock.calls[1][1] as Error).message).toBe("e2");
  });

  it("does not retry an AbortError — rethrows immediately", async () => {
    const fn = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    await expect(
      withRetries(fn, { max: 3, backoffMs: [1] })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });
});

describe("backoffFor", () => {
  it("returns the per-attempt backoff and reuses the last value past the end", () => {
    const b = [5_000, 30_000, 120_000];
    expect(backoffFor(b, 1)).toBe(5_000);
    expect(backoffFor(b, 2)).toBe(30_000);
    expect(backoffFor(b, 3)).toBe(120_000);
    expect(backoffFor(b, 4)).toBe(120_000);
    expect(backoffFor([], 1)).toBe(0);
  });
});
