import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Host-side check for the traces a sandbox install leaves in the bind-mounted
// workspace: an install run inside the container writes a pnpm store path under
// the sandbox user's home into `node_modules/.modules.yaml` and drops a
// `.pnpm-store/` at the workspace root. Both are gitignored, so the host tree
// looks clean to `git status` until the first host `pnpm` / `tsc` / `vitest`
// command fails. Pure `node:fs` — no YAML dependency, no shell, no docker — and
// every read failure yields no finding instead of throwing, because this runs on
// the loop's exit path where a crash would cost the user their footer.

const SANDBOX_HOME = "/home/agent/";

/**
 * The sandbox-install fingerprints present under `workspaceDir`, one string per
 * finding, `.modules.yaml` first. Empty when the host tree is intact.
 */
export function detectSandboxInstall(workspaceDir: string): string[] {
  const findings: string[] = [];

  const storeDir = readStoreDir(
    join(workspaceDir, "node_modules", ".modules.yaml")
  );
  if (storeDir?.startsWith(SANDBOX_HOME))
    findings.push(`node_modules/.modules.yaml storeDir: ${storeDir}`);

  if (isDirectory(join(workspaceDir, ".pnpm-store")))
    findings.push(".pnpm-store/ present at the workspace root");

  return findings;
}

/**
 * The `storeDir:` value of a `.modules.yaml`, by line scan rather than a YAML
 * parse. `undefined` when the file is missing, unreadable, or carries no such
 * line.
 */
function readStoreDir(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return /^storeDir:\s*(.+?)\s*$/m.exec(text)?.[1];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
