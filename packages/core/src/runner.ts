import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
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
const TOOL_RESULT_PREVIEW = 400;

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

export function ensureImage(buildContext?: string): void {
  const inspect = spawnSync("docker", ["image", "inspect", IMAGE_REF], {
    stdio: "ignore",
  });
  if (inspect.status === 0) return;

  process.stderr.write(`[sandcastle] Pulling image ${IMAGE_REF}\n`);
  const pull = spawnSync("docker", ["pull", IMAGE_REF], { stdio: "inherit" });
  if (pull.status === 0) return;

  if (!buildContext) {
    throw new Error(
      `docker pull failed for ${IMAGE_REF} and no build context provided. ` +
        `Set RALPH_DOCKER_CONTEXT to a directory containing a Dockerfile, ` +
        `or override RALPH_IMAGE to an image you can pull.`
    );
  }
  const dockerfile = join(buildContext, "Dockerfile");
  if (!existsSync(dockerfile)) {
    throw new Error(
      `docker pull failed for ${IMAGE_REF} and no Dockerfile at ${dockerfile}`
    );
  }
  process.stderr.write(
    `[sandcastle] pull failed; building ${IMAGE_REF} from ${buildContext}\n`
  );
  const build = spawnSync("docker", ["build", "-t", IMAGE_REF, buildContext], {
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`docker build failed (exit ${build.status})`);
  }
}

export async function runStage(
  stage: Stage,
  renderedPrompt: string,
  workspaceDir: string,
  iteration: number
): Promise<string> {
  const tmpHostDir = join(workspaceDir, ".ralph-tmp");
  mkdirSync(tmpHostDir, { recursive: true });

  const logsDir = join(tmpHostDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(logsDir, `${timestamp}-iter${iteration}-${stage.name}.ndjson`);

  const promptName = `.run-${process.pid}-${iteration}-${Date.now()}.md`;
  const promptHostPath = join(tmpHostDir, promptName);
  const promptContainerPath = posix.join(".ralph-tmp", promptName);

  writeFileSync(promptHostPath, renderedPrompt, "utf8");

  process.stderr.write(`[sandcastle] log → ${logPath}\n`);

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
  }
}

function streamDocker(args: string[], logPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const logFd = openSync(logPath, "a");

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
      renderEvent(parsed);
      if (parsed.type === "result") {
        const r = (parsed as { result?: string }).result;
        if (typeof r === "string") finalResult = r;
      }
    });

    const rlErr = createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      process.stderr.write(`[docker] ${line}\n`);
    });

    child.on("error", (err) => {
      closeSync(logFd);
      reject(err);
    });
    child.on("close", (code) => {
      closeSync(logFd);
      if (code !== 0) {
        reject(new Error(`docker run exited with ${code}\n${stderrTail.join("\n")}`));
        return;
      }
      resolve(finalResult);
    });
  });
}

function renderEvent(ev: StreamJson): void {
  switch (ev.type) {
    case "system": {
      const sub = (ev as { subtype?: string }).subtype;
      if (sub === "init") {
        const model = (ev as { model?: string }).model ?? "?";
        const cwd = (ev as { cwd?: string }).cwd ?? "?";
        process.stderr.write(`[init] model=${model} cwd=${cwd}\n`);
      }
      return;
    }
    case "assistant": {
      const content = (ev as { message?: { content?: AssistantBlock[] } }).message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          process.stdout.write(block.text.replace(/\n/g, "\r\n") + "\r\n\n");
        } else if (block.type === "thinking") {
          // Thinking blocks are usually long; show one marker line, not full text.
          process.stderr.write(`[thinking]\n`);
        } else if (block.type === "tool_use") {
          const name = block.name ?? "?";
          const preview = previewInput(name, block.input);
          process.stderr.write(`[tool] ${name} ${preview}\n`);
        }
      }
      return;
    }
    case "user": {
      const content = (ev as { message?: { content?: UserBlock[] } }).message?.content ?? [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const text = stringifyToolResult(block.content);
        if (block.is_error) {
          const snippet = text.slice(0, TOOL_RESULT_PREVIEW * 2);
          process.stderr.write(`[tool:error] ${snippet}${text.length > snippet.length ? " …" : ""}\n`);
        } else {
          const snippet = text.replace(/\s+/g, " ").trim().slice(0, TOOL_RESULT_PREVIEW);
          process.stderr.write(`[tool:ok] ${snippet}${text.length > snippet.length ? " …" : ""}\n`);
        }
      }
      return;
    }
    case "result": {
      const isError = (ev as { is_error?: boolean }).is_error;
      if (isError) process.stderr.write(`[result] is_error=true\n`);
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
        if (c && typeof c === "object" && "text" in c) return String((c as { text: unknown }).text ?? "");
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
