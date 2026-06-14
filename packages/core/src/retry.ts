export type WithRetriesOptions = {
  /** Maximum retries after the initial attempt. Total calls = max + 1. */
  max: number;
  /** Wait between attempts. backoffMs[i] is the wait before attempt i+1.
   *  When attempts exceed array length, the last value is reused. */
  backoffMs: readonly number[];
  /** Fires after each failed attempt, before the wait. */
  onAttempt?: (attempt: number, err: unknown) => void;
  /** Injected for tests so no real wall-clock waits occur. */
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000];
export const DEFAULT_MAX_RETRIES = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function withRetries<T>(
  fn: () => Promise<T>,
  opts: WithRetriesOptions
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if ((err as Error)?.name === "AbortError") throw err;
      if (attempt === opts.max) break;
      opts.onAttempt?.(attempt + 1, err);
      const backoff =
        opts.backoffMs[attempt] ??
        opts.backoffMs[opts.backoffMs.length - 1] ??
        0;
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** Wait that withRetries will impose before the Nth retry (1-indexed). */
export function backoffFor(
  backoffMs: readonly number[],
  attempt: number
): number {
  return backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
}
