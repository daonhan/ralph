import { createHash } from "node:crypto";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Decides which container-local `node_modules` volumes a workspace needs, so an
// install run inside the sandbox never writes a Linux tree into the bind-mounted
// host workspace (#128). A volume mounted at a path inside the bind mount
// shadows the host directory, and the store volume keeps the package manager
// from falling back to a store beside the modules it links into. Pure
// `node:crypto` + `node:fs` + `node:path` — the shape `host-check.ts`
// established: every docker call lives in `runner.ts`, this module only decides.

/** Where the target workspace is bind-mounted inside the sandbox. */
export const CONTAINER_WORKSPACE = "/home/agent/workspace";

/** The one package-manager store volume, shared across workspaces (it is a cache). */
export const STORE_VOLUME = "ralph-pm-store";
export const STORE_PATH = "/home/agent/.pm-store";

/** How many levels below the workspace root the package-directory walk descends. */
const MAX_DEPTH = 4;

export type SandboxVolume = {
  name: string; // docker volume name
  containerPath: string; // where it mounts inside the sandbox
  labels: string[]; // ["ralph.kind=…", "ralph.workspace=…", "ralph.path=…"]
};

/**
 * Whether the sandbox gets its own `node_modules`. `RALPH_ISOLATE_NODE_MODULES`
 * trimmed: `"0"` off, `"1"` on, anything else — including unset — follows the
 * platform: on everywhere but Linux, the one host whose tree can also be the
 * container's. `platform` is a parameter so both defaults stay testable.
 */
export function isolationEnabled(platform: string = process.platform): boolean {
  const raw = process.env.RALPH_ISOLATE_NODE_MODULES?.trim();
  if (raw === "0") return false;
  if (raw === "1") return true;
  return platform !== "linux";
}

/**
 * The volumes `workspaceDir` needs: one per package directory, the shared store
 * last. Empty when isolation is off and when the workspace holds no
 * `package.json` at all — such a workspace changes no `docker run` argument.
 */
export function resolveSandboxVolumes(workspaceDir: string): SandboxVolume[] {
  if (!isolationEnabled()) return [];

  const packagePaths = findPackagePaths(workspaceDir);
  if (packagePaths.length === 0) return [];

  const volumes: SandboxVolume[] = packagePaths.map((relPath) => ({
    name: volumeName(workspaceDir, relPath),
    containerPath: containerNodeModules(relPath),
    labels: [
      "ralph.kind=node-modules",
      `ralph.workspace=${workspaceDir}`,
      `ralph.path=${relPath}`,
    ],
  }));
  volumes.push({
    name: STORE_VOLUME,
    containerPath: STORE_PATH,
    labels: ["ralph.kind=pm-store"],
  });
  return volumes;
}

/**
 * The `docker run` arguments mounting `volumes`, followed by the npm-config
 * environment spellings that put the store on the store volume. Empty for an
 * empty input.
 */
export function sandboxRunArgs(volumes: SandboxVolume[]): string[] {
  if (volumes.length === 0) return [];

  const args: string[] = [];
  for (const volume of volumes)
    args.push("-v", `${volume.name}:${volume.containerPath}`);
  args.push("-e", `npm_config_store_dir=${STORE_PATH}/pnpm`);
  args.push("-e", `npm_config_cache=${STORE_PATH}/npm`);
  return args;
}

/**
 * The volumes whose name is not in `existing`, in input order — the ones the
 * runner still has to `docker volume create`.
 */
export function missingVolumes(
  existing: string[],
  volumes: SandboxVolume[]
): SandboxVolume[] {
  const present = new Set(existing);
  return volumes.filter((volume) => !present.has(volume.name));
}

/**
 * The package directories under `workspaceDir` as POSIX relative paths, the root
 * (`"."`) first and the rest lexicographic. Enumerating package directories
 * rather than existing `node_modules` ones is deliberate: a package whose
 * `node_modules/` the host has not created yet is exactly the one an install
 * would write into the bind mount.
 */
function findPackagePaths(workspaceDir: string): string[] {
  const found: string[] = [];
  walk(workspaceDir, ".", 0, found);
  const rest = found.filter((relPath) => relPath !== ".").sort();
  return found.includes(".") ? [".", ...rest] : rest;
}

/** Depth-first walk, skipping `node_modules` and every dot entry (`.git` included). */
function walk(
  dir: string,
  relPath: string,
  depth: number,
  found: string[]
): void {
  if (isFile(join(dir, "package.json"))) found.push(relPath);
  if (depth >= MAX_DEPTH) return;

  for (const entry of readDirectory(dir)) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    walk(
      join(dir, entry.name),
      relPath === "." ? entry.name : `${relPath}/${entry.name}`,
      depth + 1,
      found
    );
  }
}

/** POSIX separators always — the host may be Windows, the container never is. */
function containerNodeModules(relPath: string): string {
  const packageDir =
    relPath === "." ? CONTAINER_WORKSPACE : `${CONTAINER_WORKSPACE}/${relPath}`;
  return `${packageDir}/node_modules`;
}

/**
 * Opaque by design: a name derived from the path would need sanitising for
 * Docker's name grammar and could collide across two paths that sanitise alike.
 * Provenance lives in the labels instead.
 */
function volumeName(workspaceDir: string, relPath: string): string {
  const digest = createHash("sha256")
    .update(`${workspaceDir}\0${relPath}`)
    .digest("hex");
  return `ralph-nm-${digest.slice(0, 16)}`;
}

function readDirectory(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
