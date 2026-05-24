import { spawn, type ChildProcess } from "node:child_process";

export type NotifyLevel = "info" | "error";

export type NotifySpawnedChild = Pick<ChildProcess, "on" | "unref">;

export type NotifySpawner = (
  command: string,
  args: readonly string[]
) => NotifySpawnedChild;

export type NotifyOptions = {
  title: string;
  body: string;
  level: NotifyLevel;
  /** When false, suppress the terminal bell. Default: true. */
  sound?: boolean;
  // Test seams --------------------------------------------------------
  platform?: NodeJS.Platform;
  spawner?: NotifySpawner;
  stderr?: { write: (s: string) => void };
};

function defaultSpawner(
  command: string,
  args: readonly string[]
): NotifySpawnedChild {
  return spawn(command, args as string[], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
}

/**
 * Spawn a fire-and-forget child. Swallows spawn-time + async errors so a
 * missing utility (ENOENT) never crashes the loop.
 */
function fireAndForget(
  spawner: NotifySpawner,
  cmd: string,
  args: string[]
): boolean {
  try {
    const child = spawner(cmd, args);
    child.on("error", () => {
      // Async ENOENT (Linux): swallow. The whole point is fire-and-forget.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function escDoubleQuote(s: string): string {
  return s.replace(/"/g, '\\"');
}

function escPsString(s: string): string {
  // PowerShell single-quoted literal: ' is escaped by doubling.
  return s.replace(/'/g, "''");
}

function windowsToast(
  spawner: NotifySpawner,
  title: string,
  body: string
): boolean {
  // Try BurntToast first; fall back to msg.exe. Both fire-and-forget; if the
  // module is missing, the powershell child exits non-zero — we don't observe
  // it, the caller has already gotten the bell.
  const psScript =
    `if (Get-Module -ListAvailable -Name BurntToast) { ` +
    `Import-Module BurntToast; ` +
    `New-BurntToastNotification -Text '${escPsString(title)}','${escPsString(body)}' ` +
    `} else { exit 1 }`;
  const ok = fireAndForget(spawner, "powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    psScript,
  ]);
  if (!ok) return false;
  // Always also try msg.exe as a secondary path (cheap, mostly a no-op when
  // BurntToast wins). msg.exe is not on every Windows SKU (Home edition lacks
  // it) — swallow failure.
  fireAndForget(spawner, "msg.exe", ["*", `${title}: ${body}`]);
  return true;
}

function macosBanner(
  spawner: NotifySpawner,
  title: string,
  body: string,
  level: NotifyLevel
): boolean {
  const sound = level === "info" ? "Glass" : "Basso";
  const script =
    `display notification "${escDoubleQuote(body)}" ` +
    `with title "${escDoubleQuote(title)}" ` +
    `sound name "${sound}"`;
  return fireAndForget(spawner, "osascript", ["-e", script]);
}

function linuxNotifySend(
  spawner: NotifySpawner,
  title: string,
  body: string,
  level: NotifyLevel
): boolean {
  const urgency = level === "error" ? "critical" : "normal";
  return fireAndForget(spawner, "notify-send", [
    "--urgency",
    urgency,
    title,
    body,
  ]);
}

/**
 * Fire a best-effort OS notification + terminal bell. Synchronous return;
 * never blocks on toast delivery, never crashes on a missing utility.
 *
 * Bell (\x07) is written to stderr on every call regardless of OS path.
 * Apostrophes / quotes in `title` / `body` are escaped per-platform so a
 * `'` in the message doesn't break the shell wrapping.
 */
export function notify(opts: NotifyOptions): void {
  const platform = opts.platform ?? process.platform;
  const spawner = opts.spawner ?? defaultSpawner;
  const stderr = opts.stderr ?? process.stderr;
  const sound = opts.sound ?? true;

  if (sound) {
    try {
      stderr.write("\x07");
    } catch {
      // never crash on a bell write.
    }
  }

  if (platform === "win32") {
    windowsToast(spawner, opts.title, opts.body);
  } else if (platform === "darwin") {
    macosBanner(spawner, opts.title, opts.body, opts.level);
  } else if (platform === "linux") {
    linuxNotifySend(spawner, opts.title, opts.body, opts.level);
  }
  // unsupported platforms: bell-only, no toast attempt.
}

export function notifyComplete(iterations: number, sentinel: boolean): void {
  notify({
    level: "info",
    title: "Ralph complete",
    body: sentinel
      ? `Sentinel hit after ${iterations} iteration${iterations === 1 ? "" : "s"}.`
      : `Reached iteration cap (${iterations}).`,
  });
}

export function notifyError(message: string): void {
  notify({
    level: "error",
    title: "Ralph failed",
    body: message,
  });
}
