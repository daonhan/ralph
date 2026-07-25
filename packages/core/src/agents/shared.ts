export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Host home directory used for credential mounts and host-config reads.
 * Single source of truth so `--print-config` can never report a different
 * home — and therefore a different model — than the one `runStage` uses.
 */
export function resolveHostHome(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}
