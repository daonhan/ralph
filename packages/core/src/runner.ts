import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, posix } from "node:path";

import {
  getAgentAdapter,
  type AgentAdapter,
  type AgentName,
  type AgentStreamDecoder,
  type StageMeta,
} from "./agents/index.js";
import { resolveHostHome } from "./agents/shared.js";
import {
  CONTAINER_WORKSPACE,
  missingVolumes,
  resolveSandboxVolumes,
  sandboxRunArgs,
  type SandboxVolume,
} from "./sandbox-volumes.js";
import type { Stage } from "./stages.js";
import {
  bold,
  dim,
  red,
  renderEvent,
  SYM,
  type ToolTrack,
} from "./stream-render.js";

export { buildClaudeArgs, resolveModelArgs } from "./agents/claude.js";

export type RunStageOptions = {
  signal?: AbortSignal;
  agent?: AgentName;
  codexUserConfig?: boolean;
  /** Host dir of the shipped skills (<core>/templates/skills); mounted read-only when it exists. */
  skillsHostDir?: string;
};

export const IMAGE_REF =
  process.env.RALPH_IMAGE ??
  process.env.RALPH_IMAGE_TAG ?? // legacy
  "docker.io/daonhan/ralph-sandbox:latest";
const STDERR_TAIL_LINES = 40;
const DEFAULT_RESULT_GRACE_MS = 30_000;

// Emit the docker.sock blast-radius warning at most once per process.
let dockerSockWarned = false;

// Emit the missing-git-identity warning at most once per process.
let gitIdentityWarned = false;

/**
 * Parse `RALPH_RESULT_GRACE_MS`. Returns the configured millisecond budget,
 * `0` to disable the timer entirely, or `defaultMs` for any invalid input
 * (unset, empty, non-finite, negative).
 */
export function parseGraceMs(
  raw: string | undefined,
  defaultMs: number = DEFAULT_RESULT_GRACE_MS
): number {
  if (raw == null) return defaultMs;
  const trimmed = raw.trim();
  if (trimmed === "") return defaultMs;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return defaultMs;
  if (n < 0) return defaultMs;
  return Math.floor(n);
}

/**
 * Locate the sandbox Dockerfile within a build context. The Dockerfile lives at
 * `templates/Dockerfile` so the release-please `ralph-sandbox` component can be
 * scoped to the templates directory; the older context-root location is still
 * honored as a fallback.
 */
export function resolveDockerfile(buildContext: string): string {
  const inTemplates = join(buildContext, "templates", "Dockerfile");
  if (existsSync(inTemplates)) return inTemplates;
  const legacy = join(buildContext, "Dockerfile");
  if (existsSync(legacy)) return legacy;
  return inTemplates;
}

/**
 * Auto-detect the host Docker socket path. Checked in priority order:
 *
 *   1. RALPH_DOCKER_SOCK_PATH — explicit override.
 *   2. DOCKER_HOST=unix:///path/to/sock — parse if scheme is unix://.
 *   3. /var/run/docker.sock — vanilla Linux, Docker Desktop (macOS symlink).
 *   4. $HOME/.docker/run/docker.sock — Docker Desktop on macOS (post-4.x).
 *   5. $HOME/.colima/default/docker.sock — Colima default profile.
 *   6. $HOME/.rd/docker.sock — Rancher Desktop.
 *   7. $XDG_RUNTIME_DIR/docker.sock — rootless Docker.
 *   8. $XDG_RUNTIME_DIR/podman/podman.sock — rootless Podman.
 *
 * On Windows, only the explicit overrides are considered; if neither is set
 * we fall back to `/var/run/docker.sock` since Docker Desktop translates
 * that path through its WSL2 backend.
 *
 * Returns the first existing path, or null if nothing matched.
 */
export function detectDockerSocketPath(): string | null {
  const override =
    process.env.RALPH_DOCKER_SOCK_PATH ||
    parseDockerHost(process.env.DOCKER_HOST);
  if (override) return override;

  if (process.platform === "win32") {
    // Docker Desktop on Windows translates this path through its WSL2 backend;
    // existsSync can't see the named pipe so just return the conventional path.
    return "/var/run/docker.sock";
  }

  const home = process.env.HOME || "";
  const xdg = process.env.XDG_RUNTIME_DIR || "";
  const candidates = [
    "/var/run/docker.sock",
    home && join(home, ".docker", "run", "docker.sock"),
    home && join(home, ".colima", "default", "docker.sock"),
    home && join(home, ".rd", "docker.sock"),
    xdg && join(xdg, "docker.sock"),
    xdg && join(xdg, "podman", "podman.sock"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function parseDockerHost(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith("unix://")) return raw.slice("unix://".length);
  return null; // tcp://, npipe://, ssh:// — not supported via bind-mount
}

/**
 * Build `docker run` args that bind-mount the host Docker socket into the
 * sandbox so Testcontainers (and any other client of the Docker API) inside
 * the container can spawn sibling containers on the host daemon.
 *
 * - Default: ON when a socket is detected by detectDockerSocketPath().
 * - Opt-out: RALPH_DOCKER_SOCK=0
 * - Explicit path: RALPH_DOCKER_SOCK_PATH=/path/to/docker.sock
 *
 * Group fixup: the socket inside the sandbox is owned by a privileged group
 * the `agent` (UID 1000) user is not in by default, so it must be added via
 * `--group-add`:
 *   - Linux native: socket is typically root:docker 0660. We statSync the
 *     host path and pass --group-add <gid> matching the host's docker group.
 *   - Docker Desktop (macOS/Windows): the bind-mounted socket surfaces as
 *     root:root 0660 inside the container regardless of host filesystem
 *     perms, so we pass --group-add 0 to grant the agent the root *group*
 *     (this is the file-access group only; the agent process still runs as
 *     UID 1000, not root).
 *
 * Security note: mounting docker.sock grants the sandbox root-equivalent
 * access to the host Docker daemon. The AFK loop already runs with
 * --permission-mode bypassPermissions, so the blast radius is effectively
 * "anything docker can do on this host". Disable via RALPH_DOCKER_SOCK=0
 * when running untrusted prompts.
 */
export function resolveDockerSocketMount(): string[] | null {
  if (process.env.RALPH_DOCKER_SOCK === "0") return null;
  const sockPath = detectDockerSocketPath();
  if (!sockPath) return null;

  const args = ["-v", `${sockPath}:/var/run/docker.sock`];

  if (process.platform === "linux") {
    try {
      const gid = statSync(sockPath).gid;
      if (Number.isFinite(gid) && gid > 0) {
        args.push("--group-add", String(gid));
      }
    } catch {
      // socket gone between detect and statSync — skip group fixup
    }
  } else {
    // Docker Desktop surfaces docker.sock as root:root 0660 inside the
    // container. UID 1000 agent needs the root group to open it.
    args.push("--group-add", "0");
  }

  return args;
}

/**
 * Read one git identity key as the host would resolve it *for this workspace*.
 * Running through `git -C <workspaceDir>` applies git's own precedence
 * (repo-local .git/config over the host's global ~/.gitconfig), so we never
 * override an identity a repo deliberately sets for itself.
 */
function readGitIdentity(
  workspaceDir: string,
  key: string
): string | undefined {
  const res = spawnSync("git", ["-C", workspaceDir, "config", "--get", key], {
    encoding: "utf8",
  });
  if (res.status !== 0) return undefined;
  const value = res.stdout.trim();
  return value === "" ? undefined : value;
}

/**
 * Build the `GIT_CONFIG_*` env args for the sandbox.
 *
 * `safe.directory=*` makes git trust the bind-mounted workspace across the UID
 * mismatch. The identity pair matters just as much: the container never sees
 * the host's `~/.gitconfig`, so without it a commit inside the sandbox dies on
 * "unable to auto-detect email address (got 'agent@<cid>.(none)')" and the
 * agent invents an author to get past it. Repos carrying a local identity
 * inside the bind mount were immune by accident; every other repo got commits
 * attributed to a fabricated name.
 *
 * If the host has no identity at all we inject none and warn — fabricating one
 * here would be the same bug wearing a different hat.
 */
export function resolveGitConfigArgs(workspaceDir: string): string[] {
  const entries: Array<[string, string]> = [["safe.directory", "*"]];

  const name = readGitIdentity(workspaceDir, "user.name");
  const email = readGitIdentity(workspaceDir, "user.email");
  if (name && email) {
    entries.push(["user.name", name], ["user.email", email]);
  } else if (!gitIdentityWarned) {
    gitIdentityWarned = true;
    process.stderr.write(
      `${red(SYM.bullet)} ${bold("no git identity")} ${dim(
        "— git user.name/user.email are unset for this workspace, so commits made in the sandbox carry an author the agent makes up. Set one with `git config --global user.name` and `git config --global user.email`."
      )}\n`
    );
  }

  const args: string[] = ["-e", `GIT_CONFIG_COUNT=${entries.length}`];
  entries.forEach(([key, value], i) => {
    args.push(
      "-e",
      `GIT_CONFIG_KEY_${i}=${key}`,
      "-e",
      `GIT_CONFIG_VALUE_${i}=${value}`
    );
  });
  return args;
}

/**
 * A "floating" image ref is one whose tag may move (no digest pin, and either
 * no explicit tag or the conventional `:latest`). For these we always attempt
 * a fresh pull so a stale local cache doesn't pin users to an old sandbox
 * (e.g. an older .NET SDK) after we republish the image.
 */
export function isFloatingRef(ref: string): boolean {
  if (ref.includes("@sha256:")) return false;
  const lastSlash = ref.lastIndexOf("/");
  const namePart = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;
  const colon = namePart.indexOf(":");
  if (colon < 0) return true;
  return namePart.slice(colon + 1) === "latest";
}

function abortError(): Error {
  const err = new Error("docker command aborted");
  err.name = "AbortError";
  return err;
}

type DockerCommandOptions = {
  signal?: AbortSignal;
  stdio: "ignore" | "inherit";
};

function runDockerCommand(
  args: string[],
  options: DockerCommandOptions
): Promise<number | null> {
  if (options.signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: options.stdio });
    let settled = false;
    let onAbort = (): void => {};

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const rejectOnce = (err: unknown): void => finish(() => reject(err));
    const resolveOnce = (code: number | null): void =>
      finish(() => resolve(code));

    onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // Already dead; close/error handling will settle if needed.
      }
      rejectOnce(abortError());
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", rejectOnce);
    child.on("close", resolveOnce);
  });
}

/**
 * Shared post-pull-failure decision for both ensureImage variants. Returns the
 * Dockerfile path to build from, or `null` to mean "fall back to the cached
 * local copy". Throws when neither pull nor build is possible. Emits the same
 * stderr messages both code paths used to duplicate.
 */
function resolveBuildAfterPullFail(
  hasLocal: boolean,
  buildContext: string | undefined
): string | null {
  if (hasLocal) {
    process.stderr.write(
      `${dim("pull failed; using cached local copy of")} ${IMAGE_REF}\n`
    );
    return null;
  }
  if (!buildContext) {
    throw new Error(
      `docker pull failed for ${IMAGE_REF} and no build context provided. ` +
        `Set RALPH_DOCKER_CONTEXT to a directory containing a Dockerfile, ` +
        `or override RALPH_IMAGE to an image you can pull.`
    );
  }
  const dockerfile = resolveDockerfile(buildContext);
  if (!existsSync(dockerfile)) {
    throw new Error(
      `docker pull failed for ${IMAGE_REF} and no Dockerfile at ${dockerfile}`
    );
  }
  process.stderr.write(
    `${dim("pull failed; building")} ${IMAGE_REF} ${dim("from")} ${buildContext}\n`
  );
  return dockerfile;
}

function ensureImageSync(buildContext?: string): void {
  const hasLocal =
    spawnSync("docker", ["image", "inspect", IMAGE_REF], { stdio: "ignore" })
      .status === 0;

  if (hasLocal && !isFloatingRef(IMAGE_REF)) return;

  process.stderr.write(`${dim("pulling")} ${IMAGE_REF}\n`);
  if (
    spawnSync("docker", ["pull", IMAGE_REF], { stdio: "inherit" }).status === 0
  )
    return;

  const dockerfile = resolveBuildAfterPullFail(hasLocal, buildContext);
  if (dockerfile === null) return;

  const build = spawnSync(
    "docker",
    ["build", "-t", IMAGE_REF, "-f", dockerfile, buildContext as string],
    { stdio: "inherit" }
  );
  if (build.status !== 0) {
    throw new Error(`docker build failed (exit ${build.status})`);
  }
}

async function ensureImageAsync(
  buildContext: string | undefined,
  options: RunStageOptions
): Promise<void> {
  const hasLocal =
    (await runDockerCommand(["image", "inspect", IMAGE_REF], {
      stdio: "ignore",
      signal: options.signal,
    })) === 0;

  if (hasLocal && !isFloatingRef(IMAGE_REF)) return;

  process.stderr.write(`${dim("pulling")} ${IMAGE_REF}\n`);
  const pullStatus = await runDockerCommand(["pull", IMAGE_REF], {
    stdio: "inherit",
    signal: options.signal,
  });
  if (pullStatus === 0) return;

  const dockerfile = resolveBuildAfterPullFail(hasLocal, buildContext);
  if (dockerfile === null) return;

  const buildStatus = await runDockerCommand(
    ["build", "-t", IMAGE_REF, "-f", dockerfile, buildContext as string],
    {
      stdio: "inherit",
      signal: options.signal,
    }
  );
  if (buildStatus !== 0) {
    throw new Error(`docker build failed (exit ${buildStatus})`);
  }
}

export function ensureImage(buildContext?: string): void;
export function ensureImage(
  buildContext: string | undefined,
  options: RunStageOptions
): Promise<void>;
export function ensureImage(
  buildContext?: string,
  options?: RunStageOptions
): void | Promise<void> {
  if (options) return ensureImageAsync(buildContext, options);
  return ensureImageSync(buildContext);
}

// Sandbox volume names already prepared in this process. Preparation is
// idempotent, but every check costs docker calls, so only the first stage of a
// run pays for them.
const preparedVolumes = new Set<string>();

/**
 * Create the volumes `resolveSandboxVolumes` asked for and hand them to the
 * sandbox user. A fresh docker volume mounted where the image has no directory
 * is created `root:root` and the sandbox runs as UID 1000, so without the
 * one-off root `chown` every install inside the container fails with
 * `Permission denied`. Only the missing volumes are created, but one container
 * chowns every pending one.
 */
async function ensureSandboxVolumes(
  volumes: SandboxVolume[],
  options: RunStageOptions
): Promise<void> {
  const pending = volumes.filter((volume) => !preparedVolumes.has(volume.name));
  if (pending.length === 0) return;

  try {
    const listed = spawnSync(
      "docker",
      ["volume", "ls", "--filter", "label=ralph.kind", "--format", "{{.Name}}"],
      { encoding: "utf8" }
    );
    if (listed.status !== 0) {
      throw new Error(`docker volume ls exited with ${listed.status}`);
    }
    const existing = listed.stdout
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);

    const missing = missingVolumes(existing, pending);
    for (const volume of missing) {
      const labelArgs = volume.labels.flatMap((label) => ["--label", label]);
      const created = spawnSync(
        "docker",
        ["volume", "create", ...labelArgs, volume.name],
        { stdio: "ignore" }
      );
      if (created.status !== 0) {
        throw new Error(
          `docker volume create ${volume.name} exited with ${created.status}`
        );
      }
    }

    // Every pending volume, not only the freshly created ones: a create that
    // lands with a chown that does not — an interrupted or failed first run —
    // otherwise leaves a `root:root` volume that the listing above reports as
    // ready for good. `--entrypoint` because a custom `RALPH_IMAGE` may set one
    // (the pg17 variant starts PostgreSQL, which refuses to run as root).
    const targets = pending.map((_, index) => `/mnt/${index}`);
    const chownArgs = ["run", "--rm", "--user", "0:0", "--entrypoint", "chown"];
    pending.forEach((volume, index) =>
      chownArgs.push("-v", `${volume.name}:${targets[index]}`)
    );
    chownArgs.push(IMAGE_REF, "1000:1000", ...targets);
    const status = await runDockerCommand(chownArgs, {
      stdio: "ignore",
      signal: options.signal,
    });
    if (status !== 0) {
      throw new Error(`docker run chown exited with ${status}`);
    }
  } catch (error) {
    // A signal arriving mid-preparation is not a volume problem — keep the
    // abort intact so the loop reports it as one.
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to prepare sandbox node_modules volumes: ${message}. ` +
        `Disable with RALPH_ISOLATE_NODE_MODULES=0.`
    );
  }

  for (const volume of pending) preparedVolumes.add(volume.name);
}

export function stageLogPath(
  workspaceDir: string,
  iteration: number,
  stageName: string
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(
    workspaceDir,
    ".ralph-tmp",
    "logs",
    `${timestamp}-iter${iteration}-${stageName}.ndjson`
  );
}

export function resolveAgentRuntimeArgs(
  adapter: AgentAdapter,
  home: string
): string[] {
  const args: string[] = [];
  if (home) {
    for (const mount of adapter.credentialMounts(home)) {
      if (!existsSync(mount.hostPath)) continue;
      const spec = `${mount.hostPath}:${mount.containerPath}${
        mount.readOnly ? ":ro" : ""
      }`;
      args.push("-v", spec);
    }
    const ghConfigDir =
      process.env.GH_CONFIG_DIR?.trim() || join(home, ".config", "gh");
    if (existsSync(ghConfigDir)) {
      args.push("-v", `${ghConfigDir}:/home/agent/.config/gh:ro`);
    }
  }
  for (const [name, value] of Object.entries(adapter.containerEnv)) {
    args.push("-e", `${name}=${value}`);
  }
  return args;
}

/**
 * Mount the shipped skills directory read-only where the selected provider
 * discovers skills. Returns no args when the directory is absent — the guard
 * credential mounts already apply, so a core packed without `templates/skills`
 * still runs.
 */
export function resolveSkillsMountArgs(
  adapter: AgentAdapter,
  skillsHostDir: string | undefined
): string[] {
  if (!skillsHostDir || !existsSync(skillsHostDir)) return [];
  const mount = adapter.skillsMount(skillsHostDir);
  return ["-v", `${mount.hostPath}:${mount.containerPath}:ro`];
}

/**
 * Mount the provider's own volumes. `--mount` rather than `-v` so the volume
 * docker creates on first use carries the `ralph.kind` label the node_modules
 * volumes have.
 */
export function resolveAgentVolumeArgs(adapter: AgentAdapter): string[] {
  const args: string[] = [];
  for (const volume of adapter.volumeMounts()) {
    const labels = volume.labels.map((label) => `volume-label=${label}`);
    args.push(
      "--mount",
      [
        "type=volume",
        `source=${volume.name}`,
        `target=${volume.containerPath}`,
        ...labels,
      ].join(",")
    );
  }
  return args;
}

export async function runStage(
  stage: Stage,
  renderedPrompt: string,
  workspaceDir: string,
  iteration: number,
  spillHostDir?: string,
  logPathOverride?: string,
  options: RunStageOptions = {}
): Promise<{ text: string; meta: StageMeta }> {
  const adapter = getAgentAdapter(options.agent ?? "claude");
  const tmpHostDir = join(workspaceDir, ".ralph-tmp");
  mkdirSync(tmpHostDir, { recursive: true });

  const logsDir = join(tmpHostDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath =
    logPathOverride ?? stageLogPath(workspaceDir, iteration, stage.name);

  const promptName = `.run-${process.pid}-${iteration}-${Date.now()}.md`;
  const promptHostPath = join(tmpHostDir, promptName);
  const promptContainerPath = posix.join(".ralph-tmp", promptName);

  writeFileSync(promptHostPath, renderedPrompt, "utf8");

  process.stderr.write(`${dim("log → " + logPath)}\n`);

  try {
    const args = [
      "run",
      "--rm",
      "-i",
      "-v",
      `${workspaceDir}:${CONTAINER_WORKSPACE}`,
      "-w",
      CONTAINER_WORKSPACE,
      ...resolveGitConfigArgs(workspaceDir),
    ];

    const home = resolveHostHome();
    args.push(...resolveAgentRuntimeArgs(adapter, home));

    const skillsArgs = resolveSkillsMountArgs(adapter, options.skillsHostDir);
    args.push(...skillsArgs);
    args.push(...resolveAgentVolumeArgs(adapter));

    const sockMount = resolveDockerSocketMount();
    if (sockMount) {
      if (!dockerSockWarned) {
        dockerSockWarned = true;
        const sockPath = detectDockerSocketPath() ?? "docker.sock";
        process.stderr.write(
          `${red(SYM.bullet)} ${bold("docker.sock mounted")} ${dim(`(${sockPath}) — the sandbox has root-equivalent access to the host Docker daemon. Disable with RALPH_DOCKER_SOCK=0. See SECURITY.md.`)}\n`
        );
      }
      args.push(...sockMount);
    }

    // Container-local `node_modules`, so an install inside the sandbox never
    // rewrites the bind-mounted host tree with a Linux one (#128).
    const volumes = resolveSandboxVolumes(workspaceDir);
    if (volumes.length > 0) {
      await ensureSandboxVolumes(volumes, options);
      args.push(...sandboxRunArgs(volumes));
    }

    const promptInstruction = `Read the full instructions from the file ./${promptContainerPath} in the current workspace and execute them.`;
    args.push(
      IMAGE_REF,
      ...adapter.buildCommand({
        stage,
        promptInstruction,
        rawModel: process.env.RALPH_MODEL,
        codexUserConfig: options.codexUserConfig ?? false,
        home,
        skillsMounted: skillsArgs.length > 0,
      })
    );

    return await streamDocker(args, logPath, adapter.createDecoder(), options);
  } finally {
    rmSync(promptHostPath, { force: true });
    if (spillHostDir) rmSync(spillHostDir, { recursive: true, force: true });
  }
}

export function streamDocker(
  args: string[],
  logPath: string,
  decoder: AgentStreamDecoder,
  options: RunStageOptions = {}
): Promise<{ text: string; meta: StageMeta }> {
  if (options.signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const logFd = openSync(logPath, "a");
    const toolMap = new Map<string, ToolTrack>();
    const graceMs = parseGraceMs(process.env.RALPH_RESULT_GRACE_MS);

    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let finalResult = "";
    const meta: StageMeta = {};
    const stderrTail: string[] = [];
    let settled = false;
    let onAbort = (): void => {};
    let rl: ReturnType<typeof createInterface> | undefined;
    let rlErr: ReturnType<typeof createInterface> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
      try {
        rl?.close();
      } catch {
        // Already closed.
      }
      try {
        rlErr?.close();
      } catch {
        // Already closed.
      }
      try {
        closeSync(logFd);
      } catch {
        // Already closed.
      }
      fn();
    };

    const rejectOnce = (err: unknown): void => finish(() => reject(err));
    const resolveOnce = (text: string): void =>
      finish(() => resolve({ text, meta }));

    onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // Already dead; close handling below will settle if needed.
      }
      rejectOnce(abortError());
    };

    rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (settled || !line.startsWith("{")) return;

      appendFileSync(logFd, line + "\n");

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      const decoded = decoder.decode(parsed);
      for (const event of decoded.events) {
        renderEvent(event, toolMap);
      }

      if (decoded.meta) Object.assign(meta, decoded.meta);

      if (decoded.failure !== undefined) {
        try {
          child.kill();
        } catch {
          // Child already exited; rejectOnce remains authoritative.
        }
        rejectOnce(new Error(decoded.failure));
        return;
      }

      if (decoded.completion !== undefined) {
        finalResult = decoded.completion;
        if (!graceTimer && graceMs > 0) {
          graceTimer = setTimeout(() => {
            if (settled) return;
            process.stderr.write(
              `${dim(`grace timer fired after ${graceMs}ms post-completion — killing docker child`)}\n`
            );
            meta.graceTimerFired = true;
            try {
              child.kill();
            } catch {
              // Child already exited; resolveOnce remains authoritative.
            }
            resolveOnce(finalResult);
          }, graceMs);
          graceTimer.unref?.();
        }
      }
    });

    rlErr = createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      if (settled) return;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      process.stderr.write(`${dim("docker  " + line)}\n`);
    });

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      rejectOnce(err);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        rejectOnce(
          new Error(`docker run exited with ${code}\n${stderrTail.join("\n")}`)
        );
        return;
      }
      try {
        resolveOnce(decoder.finish());
      } catch (error) {
        rejectOnce(error);
      }
    });
  });
}
