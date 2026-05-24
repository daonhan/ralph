import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export type SpawnedChild = Pick<ChildProcess, "kill" | "on" | "pid">;

export type Spawner = (
  command: string,
  args: readonly string[],
  options: { detached?: boolean; stdio?: "ignore" }
) => SpawnedChild;

export type AcquireOptions = {
  reason?: string;
  spawner?: Spawner;
  platform?: NodeJS.Platform;
  parentPid?: number;
  wslHint?: () => boolean;
  warn?: (msg: string) => void;
};

export type Releaser = {
  release: () => void;
};

const NOOP_RELEASER: Releaser = { release: () => {} };

const DEFAULT_REASON = "ralph-afk loop";

function defaultSpawner(
  command: string,
  args: readonly string[],
  options: { detached?: boolean; stdio?: "ignore" }
): SpawnedChild {
  return spawn(command, args as string[], {
    detached: options.detached ?? false,
    stdio: options.stdio ?? "ignore",
    windowsHide: true,
  });
}

function defaultWslHint(): boolean {
  try {
    if (!existsSync("/proc/version")) return false;
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function defaultWarn(msg: string): void {
  process.stderr.write(`[keepalive] ${msg}\n`);
}

/**
 * Build the powershell argv that holds ES_SYSTEM_REQUIRED for the lifetime of
 * the spawned child. Killing the child lets the OS clear ES_CONTINUOUS on
 * process exit (per SetThreadExecutionState docs).
 */
function windowsArgs(): { cmd: string; args: string[] } {
  const script =
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;" +
    'public static class P{[DllImport("kernel32.dll")]' +
    "public static extern uint SetThreadExecutionState(uint e);}';" +
    "[P]::SetThreadExecutionState(0x80000000 -bor 0x00000001) | Out-Null;" +
    "while($true){Start-Sleep -Seconds 60}";
  return {
    cmd: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
  };
}

function macosArgs(parentPid: number): { cmd: string; args: string[] } {
  return {
    cmd: "caffeinate",
    args: ["-i", "-w", String(parentPid)],
  };
}

function linuxArgs(reason: string): { cmd: string; args: string[] } {
  return {
    cmd: "systemd-inhibit",
    args: [
      "--what=sleep",
      `--why=${reason}`,
      "--mode=block",
      "sleep",
      "infinity",
    ],
  };
}

/**
 * Acquire an OS wake-lock for the lifetime of the returned Releaser. Platform
 * dispatch is per-OS; missing utilities degrade to a no-op (warning emitted
 * once) so the loop never crashes on a stripped image.
 */
export function acquire(opts: AcquireOptions = {}): Releaser {
  const platform = opts.platform ?? process.platform;
  const spawner = opts.spawner ?? defaultSpawner;
  const parentPid = opts.parentPid ?? process.pid;
  const wslHint = opts.wslHint ?? defaultWslHint;
  const warn = opts.warn ?? defaultWarn;
  const reason = opts.reason ?? DEFAULT_REASON;

  if (platform === "linux" && wslHint()) {
    warn(
      "WSL2 detected: systemd-inhibit blocks WSL idle only, not Windows host sleep. " +
        "Configure the Windows power plan to keep the host awake."
    );
  }

  let spec: { cmd: string; args: string[] };
  if (platform === "win32") {
    spec = windowsArgs();
  } else if (platform === "darwin") {
    spec = macosArgs(parentPid);
  } else if (platform === "linux") {
    spec = linuxArgs(reason);
  } else {
    warn(`unsupported platform ${platform}: skipping wake-lock`);
    return NOOP_RELEASER;
  }

  let child: SpawnedChild;
  try {
    child = spawner(spec.cmd, spec.args, { stdio: "ignore" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      warn(`${spec.cmd} not found: continuing without wake-lock`);
    } else {
      warn(
        `failed to spawn ${spec.cmd}: ${(err as Error).message}. Continuing without wake-lock.`
      );
    }
    return NOOP_RELEASER;
  }

  // Swallow spawn-time errors emitted asynchronously (e.g. ENOENT surfaced on
  // the child rather than thrown by spawn itself on some platforms).
  let released = false;
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (released) return;
    released = true;
    if (err.code === "ENOENT") {
      warn(`${spec.cmd} not found: continuing without wake-lock`);
    } else {
      warn(`wake-lock child error: ${err.message}`);
    }
  });
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    if (released) return;
    released = true;
    const reason =
      code == null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
    warn(
      `${spec.cmd} wake-lock exited early (${reason}); continuing without wake-lock`
    );
  });

  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        child.kill();
      } catch {
        // Already dead; ignore.
      }
    },
  };
}
