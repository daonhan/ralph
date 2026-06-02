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

import type { Stage } from "./stages.js";
import {
  bold,
  dim,
  red,
  renderEvent,
  SYM,
  type StreamJson,
  type ToolTrack,
} from "./stream-render.js";

export type RunStageOptions = {
  signal?: AbortSignal;
};

export const IMAGE_REF =
  process.env.RALPH_IMAGE ??
  process.env.RALPH_IMAGE_TAG ?? // legacy
  "docker.io/daonhan/ralph-sandbox:latest";
const STDERR_TAIL_LINES = 40;
const DEFAULT_RESULT_GRACE_MS = 30_000;

// Emit the docker.sock blast-radius warning at most once per process.
let dockerSockWarned = false;

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
 * Resolve `RALPH_MODEL` into a `claude` argv fragment. Returns
 * `["--model", trimmed]` for a non-empty value, or `[]` for unset / empty /
 * whitespace-only input. Pass-through: ralph never validates the model spec,
 * the `claude` CLI owns that.
 */
export function resolveModelArgs(raw: string | undefined): string[] {
  if (raw == null) return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return ["--model", trimmed];
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

/**
 * Build the `claude` argv fragment that follows the image ref in a `docker run`
 * invocation. Extracted as a pure helper so callers can unit-test the argv
 * without spawning docker.
 *
 * @param stage - The stage configuration (name, permissionMode, etc.).
 * @param promptContainerPath - The in-container path to the rendered prompt file.
 * @param modelArgs - The `["--model", "<spec>"]` fragment from {@link resolveModelArgs},
 *   or `[]` when `RALPH_MODEL` is unset.
 * @returns The argv fragment starting with `"claude"` and ending with the prompt
 *   instruction string, ready to be appended after the image ref.
 */
export function buildClaudeArgs(
  stage: Stage,
  promptContainerPath: string,
  modelArgs: string[]
): string[] {
  const args = [
    "claude",
    "--verbose",
    "--print",
    "--output-format",
    "stream-json",
  ];
  if (stage.permissionMode) {
    args.push("--permission-mode", stage.permissionMode);
  }
  args.push(...modelArgs);
  args.push(
    `Read the full instructions from the file ./${promptContainerPath} in the current workspace and execute them.`
  );
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
): Promise<string> {
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
      `${workspaceDir}:/home/agent/workspace`,
      "-w",
      "/home/agent/workspace",
      "-e",
      "GIT_CONFIG_COUNT=1",
      "-e",
      "GIT_CONFIG_KEY_0=safe.directory",
      "-e",
      "GIT_CONFIG_VALUE_0=*",
    ];

    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
      const claudeDir = join(home, ".claude");
      const claudeJson = join(home, ".claude.json");
      const ghConfigDir = join(home, ".config", "gh");
      if (existsSync(claudeDir)) {
        args.push("-v", `${claudeDir}:/home/agent/.claude`);
      }
      if (existsSync(claudeJson)) {
        args.push("-v", `${claudeJson}:/home/agent/.claude.json`);
      }
      if (existsSync(ghConfigDir)) {
        args.push("-v", `${ghConfigDir}:/home/agent/.config/gh:ro`);
      }
    }

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

    args.push(
      IMAGE_REF,
      ...buildClaudeArgs(
        stage,
        promptContainerPath,
        resolveModelArgs(process.env.RALPH_MODEL)
      )
    );

    return await streamDocker(args, logPath, options);
  } finally {
    rmSync(promptHostPath, { force: true });
    if (spillHostDir) rmSync(spillHostDir, { recursive: true, force: true });
  }
}

function streamDocker(
  args: string[],
  logPath: string,
  options: RunStageOptions = {}
): Promise<string> {
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
    const resolveOnce = (value: string): void => finish(() => resolve(value));

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
      if (settled) return;
      if (!line.startsWith("{")) return;

      appendFileSync(logFd, line + "\n");

      let parsed: StreamJson;
      try {
        parsed = JSON.parse(line) as StreamJson;
      } catch {
        return;
      }
      renderEvent(parsed, toolMap);
      if (parsed.type === "result") {
        const r = (parsed as { result?: string }).result;
        if (typeof r === "string") finalResult = r;
        // Arm one-shot post-result grace timer to recover from claude-CLI
        // self-deadlocks where the child emits its final NDJSON but never
        // exits. See docs/prd/result-grace-timer.md. Operators still on
        // @daonhan/ralph-core <= 0.6.0 must recover manually via
        // `docker ps --filter ancestor=docker.io/daonhan/ralph-sandbox:latest`
        // + `docker kill <id>` (the --rm container is removed and the loop
        // aborts the current iteration; prior committed work is preserved).
        if (!graceTimer && graceMs > 0) {
          graceTimer = setTimeout(() => {
            if (settled) return;
            process.stderr.write(
              `${dim(`grace timer fired after ${graceMs}ms post-result — killing docker child`)}\n`
            );
            try {
              child.kill();
            } catch {
              // Already dead; close handler will be a no-op via settle guard.
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
      resolveOnce(finalResult);
    });
  });
}
