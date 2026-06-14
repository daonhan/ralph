import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, posix } from "node:path";

import type { Stage } from "./stages.js";
import {
  dim,
  renderEvent,
  type StreamJson,
  type ToolTrack,
} from "./stream-render.js";

export type RunStageOptions = {
  signal?: AbortSignal;
};

const STDERR_TAIL_LINES = 40;
const DEFAULT_RESULT_GRACE_MS = 30_000;

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

export type Runner = "sandbox" | "host";

/** `RALPH_RUNNER=host` → bare host run; anything else (incl. unset) → sandbox. */
export function resolveRunner(raw: string | undefined): Runner {
  return raw?.trim() === "host" ? "host" : "sandbox";
}

/** Parse `RALPH_SANDBOX_NET` into a domain allowlist. Empty = unrestricted. */
export function resolveSandboxNet(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Go-based CLIs fail TLS verification under macOS Seatbelt; run them outside the
// sandbox so `gh`/`gcloud`/`terraform` keep working (ralph-ghafk relies on gh).
const SANDBOX_EXCLUDED_COMMANDS = ["gh *", "gcloud *", "terraform *"];

/**
 * Claude Code native-sandbox settings: confine writes to the workspace and run
 * the Go-TLS CLIs unsandboxed. When `allowedDomains` is non-empty, also restrict
 * network egress to that list; otherwise leave network unrestricted (filesystem
 * is the blast-radius control; network commands fall back to the bypass-approved
 * escape hatch).
 */
export function buildSandboxSettings(
  workspaceDir: string,
  allowedDomains: string[]
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    enabled: true,
    filesystem: { allowWrite: [workspaceDir] },
    excludedCommands: SANDBOX_EXCLUDED_COMMANDS,
  };
  if (allowedDomains.length > 0) {
    sandbox.network = { allowedDomains };
  }
  return { sandbox };
}

function abortError(): Error {
  const err = new Error("claude command aborted");
  err.name = "AbortError";
  return err;
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
 * Build the `claude` argv. Extracted as a pure helper so callers can unit-test
 * the argv without spawning a process.
 *
 * @param stage - The stage configuration (name, permissionMode, etc.).
 * @param promptRelPath - The workspace-relative path to the rendered prompt file.
 * @param modelArgs - The `["--model", "<spec>"]` fragment from {@link resolveModelArgs},
 *   or `[]` when `RALPH_MODEL` is unset.
 * @param settingsPath - Optional absolute path to a transient settings JSON file
 *   (written by `runStage` when `RALPH_RUNNER=sandbox`).
 * @returns The full argv starting with `"claude"` and ending with the prompt
 *   instruction string.
 */
export function buildClaudeArgs(
  stage: Stage,
  promptRelPath: string,
  modelArgs: string[],
  settingsPath?: string
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
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }
  args.push(...modelArgs);
  args.push(
    `Read the full instructions from the file ./${promptRelPath} in the current workspace and execute them.`
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
  const promptRelPath = posix.join(".ralph-tmp", promptName);
  writeFileSync(promptHostPath, renderedPrompt, "utf8");

  let settingsHostPath: string | undefined;
  if (resolveRunner(process.env.RALPH_RUNNER) === "sandbox") {
    const settings = buildSandboxSettings(
      workspaceDir,
      resolveSandboxNet(process.env.RALPH_SANDBOX_NET)
    );
    settingsHostPath = join(
      tmpHostDir,
      `.sandbox-${process.pid}-${iteration}-${Date.now()}.json`
    );
    writeFileSync(settingsHostPath, JSON.stringify(settings), "utf8");
  }

  process.stderr.write(`${dim("log → " + logPath)}\n`);

  try {
    const argv = buildClaudeArgs(
      stage,
      promptRelPath,
      resolveModelArgs(process.env.RALPH_MODEL),
      settingsHostPath
    );
    return await streamClaude(argv, workspaceDir, logPath, options);
  } finally {
    rmSync(promptHostPath, { force: true });
    if (settingsHostPath) rmSync(settingsHostPath, { force: true });
    if (spillHostDir) rmSync(spillHostDir, { recursive: true, force: true });
  }
}

function streamClaude(
  argv: string[],
  cwd: string,
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

    // Spawn claude (argv[0]) on the host instead of docker.
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
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
        // exits. See docs/prd/result-grace-timer.md.
        if (!graceTimer && graceMs > 0) {
          graceTimer = setTimeout(() => {
            if (settled) return;
            process.stderr.write(
              `${dim(`grace timer fired after ${graceMs}ms post-result — killing claude child`)}\n`
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
      process.stderr.write(`${dim("claude  " + line)}\n`);
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
          new Error(`claude exited with ${code}\n${stderrTail.join("\n")}`)
        );
        return;
      }
      resolveOnce(finalResult);
    });
  });
}
