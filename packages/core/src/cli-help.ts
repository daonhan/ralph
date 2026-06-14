import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MAX_RETRIES } from "./retry.js";

export type CliFlags = {
  help: boolean;
  version: boolean;
  printConfig: boolean;
  noKeepAlive: boolean;
  maxRetries?: number;
  detach: boolean;
  log?: string;
  notify: boolean;
  rest: string[];
};

export function parseFlags(argv: string[]): CliFlags {
  let help = false;
  let version = false;
  let printConfig = false;
  let noKeepAlive = false;
  let maxRetries: number | undefined;
  let expectingMaxRetries = false;
  let detach = false;
  let log: string | undefined;
  let expectingLog = false;
  let notify = false;
  const rest: string[] = [];
  for (const a of argv) {
    if (expectingMaxRetries) {
      if (!/^\d+$/.test(a)) {
        throw new Error(
          `--max-retries must be a non-negative integer, got: ${JSON.stringify(a)}`
        );
      }
      maxRetries = Number.parseInt(a, 10);
      expectingMaxRetries = false;
      continue;
    }
    if (expectingLog) {
      log = a;
      expectingLog = false;
      continue;
    }
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-V" || a === "--version") version = true;
    else if (a === "--print-config") printConfig = true;
    else if (a === "--no-keep-alive") noKeepAlive = true;
    else if (a === "--max-retries") expectingMaxRetries = true;
    else if (a === "--detach") detach = true;
    else if (a === "--log") expectingLog = true;
    else if (a === "--notify") notify = true;
    else rest.push(a);
  }
  if (expectingMaxRetries) {
    throw new Error("--max-retries requires a value");
  }
  if (expectingLog) {
    throw new Error("--log requires a value");
  }
  if (log !== undefined && !detach) {
    throw new Error("--log is only meaningful with --detach");
  }
  return {
    help,
    version,
    printConfig,
    noKeepAlive,
    maxRetries,
    detach,
    log,
    notify,
    rest,
  };
}

/**
 * Resolve the @daonhan/ralph-core version by reading the package.json that
 * sits two levels up from the compiled cli-help.js (packages/core/dist/ →
 * packages/core/package.json). Returns "?" if unreadable so version reporting
 * never crashes the bin.
 */
export function readCoreVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

export function printVersion(bin: string, cliVersion?: string): void {
  const core = readCoreVersion();
  const cli = cliVersion ?? "?";
  process.stdout.write(`${bin} ${cli} (core ${core})\n`);
}

export function printHelp(
  bin: string,
  usage: string,
  description: string
): void {
  process.stdout.write(`${bin} — ${description}

Usage:
  ${bin} ${usage}
  ${bin} --help | -h
  ${bin} --version | -V
  ${bin} --print-config [args...]

Flags:
  -h, --help          show this help and exit
  -V, --version       print bin + core version and exit
  --print-config      resolve workspace / runner / sandbox config, print, and exit
  --no-keep-alive     skip OS wake-lock acquisition (default: acquire system-sleep inhibitor for loop lifetime)
  --max-retries <N>   per-stage retry budget on transient failure (default: 3; 0 disables retries)
  --detach            fork the loop into a background process, print pid + log path, and exit (parent returns 0)
  --log <path>        override the detached log path (default: <workspace>/.ralph-tmp/logs/detached-<parent-pid>.log; requires --detach)
  --notify            emit OS notification + terminal bell on loop completion or unrecoverable failure (default: off)

Environment variables:
  RALPH_WORKSPACE   host dir Claude runs against (default: cwd)
  RALPH_RUNNER      "sandbox" (default) runs claude in the native OS sandbox with
                    writes confined to the workspace; "host" runs claude unsandboxed
                    (bare while-loop — only safe in a throwaway tree).
  RALPH_SANDBOX_NET comma-separated domain allowlist for sandbox network egress.
                    Unset = unrestricted (filesystem is the blast-radius control).
  RALPH_MODEL       pin the claude model ("--model <value>" pass-through). Unset =
                    claude CLI default. The claude CLI validates the value.
  RALPH_RESULT_GRACE_MS  post-result grace timer ms (default 30000; 0 disables).
`);
}

export type PrintConfigOptions = {
  cliVersion?: string;
  noKeepAlive?: boolean;
  maxRetries?: number;
  detach?: boolean;
  detachLogPath?: string;
  notify?: boolean;
};

export function printConfig(
  bin: string,
  workspaceDir: string,
  packageDir: string,
  opts: PrintConfigOptions = {}
): void {
  const {
    cliVersion,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    detach = false,
    detachLogPath,
    notify = false,
  } = opts;
  const core = readCoreVersion();
  const cli = cliVersion ?? "?";

  const runner =
    process.env.RALPH_RUNNER?.trim() === "host" ? "host" : "sandbox";
  const rawNet = process.env.RALPH_SANDBOX_NET?.trim();
  const netStatus =
    runner === "host"
      ? "n/a (host runner)"
      : rawNet
        ? `restricted to: ${rawNet}`
        : "unrestricted (filesystem-only sandbox)";

  const keepAliveStatus = noKeepAlive ? "off" : "on (system sleep only)";
  const detachStatus =
    detach && detachLogPath ? `on (log: ${detachLogPath})` : "off";
  const notifyStatus = notify ? "on" : "off";
  const rawModel = process.env.RALPH_MODEL;
  const modelStatus =
    rawModel && rawModel.trim() !== ""
      ? `${rawModel.trim()} (RALPH_MODEL)`
      : "claude CLI default (RALPH_MODEL unset)";

  process.stdout.write(`[${bin}] resolved config
  version               ${bin} ${cli} (core ${core})
  RALPH_WORKSPACE       ${workspaceDir}${process.env.RALPH_WORKSPACE ? "" : "  (default: cwd)"}
  packageDir            ${packageDir}
  RALPH_RUNNER          ${runner}${process.env.RALPH_RUNNER ? "" : "  (default)"}
  sandbox network       ${netStatus}
  model                 ${modelStatus}
  keep-alive            ${keepAliveStatus}
  max-retries           ${maxRetries}
  detach                ${detachStatus}
  notify                ${notifyStatus}
`);
}
