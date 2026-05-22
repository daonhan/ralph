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

export const IMAGE_REF =
  process.env.RALPH_IMAGE ??
  process.env.RALPH_IMAGE_TAG ?? // legacy
  "docker.io/daonhan/ralph-sandbox:latest";
const STDERR_TAIL_LINES = 40;
const TOOL_INPUT_PREVIEW = 200;
const TOOL_RESULT_PREVIEW = 120;
const TOOL_ERROR_PREVIEW = 400;

/* ── TTY-gated styling ────────────────────────────────────────────────── */

const NO_COLOR_ENV =
  process.env.NO_COLOR != null || process.env.TERM === "dumb";

/** Controls ANSI codes on stderr (tool events, banners, docker output). */
const USE_COLOR = process.stderr.isTTY === true && !NO_COLOR_ENV;

/** Controls ANSI codes on stdout (assistant text bullets, completion line).
 *  Separate from USE_COLOR so `ralph-ghafk 1 > out.txt` stays clean even
 *  when stderr is still a TTY. */
const USE_COLOR_STDOUT = process.stdout.isTTY === true && !NO_COLOR_ENV;

const c = (code: string, s: string): string =>
  USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
const cOut = (code: string, s: string): string =>
  USE_COLOR_STDOUT ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = (s: string): string => c("2", s);
const bold = (s: string): string => c("1", s);
const cyan = (s: string): string => c("36", s);
const green = (s: string): string => c("32", s);
const red = (s: string): string => c("31", s);
const boldOut = (s: string): string => cOut("1", s);
const cyanOut = (s: string): string => cOut("36", s);
const greenOut = (s: string): string => cOut("32", s);
const dimOut = (s: string): string => cOut("2", s);

const SYM = USE_COLOR
  ? { bullet: "●", cont: "⎿", check: "✓", cross: "✗", rule: "━", ellip: "…" }
  : {
      bullet: "*",
      cont: "  >",
      check: "ok",
      cross: "FAIL",
      rule: "=",
      ellip: "...",
    };

const SYM_OUT = USE_COLOR_STDOUT ? { bullet: "●" } : { bullet: "*" };

export {
  USE_COLOR,
  USE_COLOR_STDOUT,
  dim,
  bold,
  cyan,
  green,
  red,
  SYM,
  greenOut,
  boldOut,
  dimOut,
  SYM_OUT,
};

type AssistantBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
};
type UserBlock = {
  type: string;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
};
type StreamJson =
  | { type: "assistant"; message?: { content?: AssistantBlock[] } }
  | { type: "user"; message?: { content?: UserBlock[] } }
  | { type: "system"; subtype?: string; [k: string]: unknown }
  | { type: "result"; result?: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };

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

export function ensureImage(buildContext?: string): void {
  const floating = isFloatingRef(IMAGE_REF);
  const hasLocal =
    spawnSync("docker", ["image", "inspect", IMAGE_REF], { stdio: "ignore" })
      .status === 0;

  if (hasLocal && !floating) return;

  process.stderr.write(`${dim("pulling")} ${IMAGE_REF}\n`);
  const pull = spawnSync("docker", ["pull", IMAGE_REF], { stdio: "inherit" });
  if (pull.status === 0) return;

  if (hasLocal) {
    process.stderr.write(
      `${dim("pull failed; using cached local copy of")} ${IMAGE_REF}\n`
    );
    return;
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
  const build = spawnSync(
    "docker",
    ["build", "-t", IMAGE_REF, "-f", dockerfile, buildContext],
    {
      stdio: "inherit",
    }
  );
  if (build.status !== 0) {
    throw new Error(`docker build failed (exit ${build.status})`);
  }
}

export async function runStage(
  stage: Stage,
  renderedPrompt: string,
  workspaceDir: string,
  iteration: number,
  spillHostDir?: string
): Promise<string> {
  const tmpHostDir = join(workspaceDir, ".ralph-tmp");
  mkdirSync(tmpHostDir, { recursive: true });

  const logsDir = join(tmpHostDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(
    logsDir,
    `${timestamp}-iter${iteration}-${stage.name}.ndjson`
  );

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
    if (sockMount) args.push(...sockMount);

    args.push(
      IMAGE_REF,
      "claude",
      "--verbose",
      "--print",
      "--output-format",
      "stream-json"
    );
    if (stage.permissionMode) {
      args.push("--permission-mode", stage.permissionMode);
    }
    args.push(
      `Read the full instructions from the file ./${promptContainerPath} in the current workspace and execute them.`
    );

    return await streamDocker(args, logPath);
  } finally {
    rmSync(promptHostPath, { force: true });
    if (spillHostDir) rmSync(spillHostDir, { recursive: true, force: true });
  }
}

function streamDocker(args: string[], logPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const logFd = openSync(logPath, "a");
    const toolMap = new Map<string, ToolTrack>();

    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let finalResult = "";
    const stderrTail: string[] = [];

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
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
      }
    });

    const rlErr = createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      process.stderr.write(`${dim("docker  " + line)}\n`);
    });

    child.on("error", (err) => {
      closeSync(logFd);
      reject(err);
    });
    child.on("close", (code) => {
      closeSync(logFd);
      if (code !== 0) {
        reject(
          new Error(`docker run exited with ${code}\n${stderrTail.join("\n")}`)
        );
        return;
      }
      resolve(finalResult);
    });
  });
}

type ToolTrack = { name: string; startedAt: number };

function renderEvent(ev: StreamJson, toolMap: Map<string, ToolTrack>): void {
  switch (ev.type) {
    case "system": {
      const sub = (ev as { subtype?: string }).subtype;
      if (sub === "init") {
        const model = (ev as { model?: string }).model ?? "?";
        const cwd = (ev as { cwd?: string }).cwd ?? "?";
        process.stderr.write(
          `${dim("───")} ${bold("init")} ${dim(`model=${model} cwd=${cwd}`)}\n`
        );
      }
      return;
    }
    case "assistant": {
      const content =
        (ev as { message?: { content?: AssistantBlock[] } }).message?.content ??
        [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          const lines = block.text.split("\n");
          const formatted = lines
            .map((l, idx) =>
              idx === 0 ? `${boldOut(cyanOut(SYM_OUT.bullet))} ${l}` : `  ${l}`
            )
            .join("\r\n");
          process.stdout.write(formatted + "\r\n\n");
        } else if (block.type === "thinking") {
          process.stderr.write(
            `${dim(SYM.bullet + " thinking" + SYM.ellip)}\n`
          );
        } else if (block.type === "tool_use") {
          const name = block.name ?? "?";
          const preview = previewInput(name, block.input);
          if (block.id) {
            toolMap.set(block.id, { name, startedAt: Date.now() });
          }
          process.stderr.write(
            `${cyan(SYM.bullet)} ${bold(name)} ${dim(preview)}\n`
          );
        }
      }
      return;
    }
    case "user": {
      const content =
        (ev as { message?: { content?: UserBlock[] } }).message?.content ?? [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const text = stringifyToolResult(block.content);
        const tracked = block.tool_use_id
          ? toolMap.get(block.tool_use_id)
          : undefined;
        const toolName = tracked?.name ?? "tool";
        const elapsed = tracked ? ` (${Date.now() - tracked.startedAt}ms)` : "";
        if (block.tool_use_id) toolMap.delete(block.tool_use_id);

        if (block.is_error) {
          const snippet = text
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, TOOL_ERROR_PREVIEW);
          process.stderr.write(
            `${dim(SYM.cont)} ${red(SYM.cross)} ${bold(toolName)}${red(" failed")}\n  ${red(snippet)}${text.length > snippet.length ? " " + SYM.ellip : ""}\n`
          );
        } else {
          const snippet = text
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, TOOL_RESULT_PREVIEW);
          process.stderr.write(
            `${dim(SYM.cont)} ${green(SYM.check)} ${bold(toolName)}${dim(elapsed)} ${dim(snippet)}${text.length > snippet.length ? " " + SYM.ellip : ""}\n`
          );
        }
      }
      return;
    }
    case "result": {
      const isError = (ev as { is_error?: boolean }).is_error;
      if (isError)
        process.stderr.write(`${red(SYM.bullet + " result errored")}\n`);
      return;
    }
    default:
      return;
  }
}

function previewInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Pick the most informative field per tool.
  const keyOrder: Record<string, string[]> = {
    Bash: ["command"],
    Edit: ["file_path"],
    Write: ["file_path"],
    Read: ["file_path"],
    Glob: ["pattern", "path"],
    Grep: ["pattern", "path"],
    TodoWrite: [],
  };
  const keys = keyOrder[toolName] ?? Object.keys(obj).slice(0, 2);
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${truncate(s, TOOL_INPUT_PREVIEW)}`);
  }
  return parts.join(" ");
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c)
          return String((c as { text: unknown }).text ?? "");
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + SYM.ellip;
}
