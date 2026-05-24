import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export type DetachedChild = Pick<ChildProcess, "pid" | "unref">;

export type DetachSpawner = (
  command: string,
  args: readonly string[],
  options: {
    detached: boolean;
    stdio: readonly ["ignore", number, number];
    windowsHide: boolean;
  }
) => DetachedChild;

export type DetachOptions = {
  /** Absolute path to the log file. stdout + stderr of the child are appended here. */
  logPath: string;
  /** The full original argv (from process.argv.slice(2)). --detach and --log are stripped before re-spawn. */
  argv: string[];
  /** Path to the bin script the child should run (typically process.argv[1]). */
  binEntry: string;
  // Test seams ----------------------------------------------------------
  execPath?: string;
  spawnFn?: DetachSpawner;
  openFd?: (path: string) => number;
  ensureDir?: (path: string) => void;
  stderr?: { write: (s: string) => void };
  exit?: (code?: number) => never;
};

/**
 * Strip `--detach` and `--log <value>` from an argv array so the re-spawned
 * child does not fork again and does not re-interpret the log target.
 */
export function stripDetachFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--detach") continue;
    if (a === "--log") {
      i++; // also skip the value
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Fork the current bin into the background, redirect its stdio to `logPath`,
 * print `detached pid <pid>, log <path>` on stderr, and exit the parent with
 * code 0. The re-spawned child receives the original argv minus --detach /
 * --log so it cannot fork again.
 */
export function detachAndExit(opts: DetachOptions): never {
  const execPath = opts.execPath ?? process.execPath;
  const spawnFn: DetachSpawner =
    opts.spawnFn ??
    ((cmd, args, options) =>
      spawn(cmd, args as string[], {
        detached: options.detached,
        stdio: options.stdio as ["ignore", number, number],
        windowsHide: options.windowsHide,
      }));
  const openFd = opts.openFd ?? ((p) => openSync(p, "a"));
  const ensureDir =
    opts.ensureDir ?? ((p) => mkdirSync(p, { recursive: true }));
  const stderr = opts.stderr ?? process.stderr;
  const exit: (code?: number) => never =
    opts.exit ?? ((code) => process.exit(code));

  ensureDir(dirname(opts.logPath));
  const logFd = openFd(opts.logPath);

  const childArgv = stripDetachFlags(opts.argv);
  const child = spawnFn(execPath, [opts.binEntry, ...childArgv], {
    detached: true,
    stdio: ["ignore", logFd, logFd] as const,
    windowsHide: true,
  });

  child.unref();
  stderr.write(`detached pid ${child.pid}, log ${opts.logPath}\n`);
  exit(0);
}
