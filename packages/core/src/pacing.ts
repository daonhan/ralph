function abortError(): Error {
  const err = new Error("sleep aborted");
  err.name = "AbortError";
  return err;
}

/** Abortable delay. Resolves after `ms`; rejects with an AbortError if `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const THROTTLE_RE = /429|overload|rate.?limit/i;

/** True when a result's `api_error_status` looks like provider throttling. */
export function isThrottle(apiErrorStatus: string | null): boolean {
  return apiErrorStatus != null && THROTTLE_RE.test(apiErrorStatus);
}

/** Adaptive cooldown multiplier: reset to 1 when healthy, else double up to `cap`. */
export function nextCooldownFactor(
  prev: number,
  throttled: boolean,
  cap = 8
): number {
  return throttled ? Math.min(prev * 2, cap) : 1;
}
