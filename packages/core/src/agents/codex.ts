import { join, posix } from "node:path";

import { record } from "./shared.js";
import type {
  AgentAdapter,
  AgentCommandContext,
  AgentDecodeResult,
  AgentStreamDecoder,
  StageMeta,
} from "./types.js";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function failureMessage(
  event: Record<string, unknown>,
  fallback: string
): string {
  if (typeof event.message === "string") {
    return event.message.trim() ? event.message : fallback;
  }
  if (typeof event.error === "string") {
    return event.error.trim() ? event.error : fallback;
  }
  const error = record(event.error);
  const message = stringValue(error?.message);
  return message?.trim() ? message : fallback;
}

// Codex emits transient "Reconnecting... X/Y" notices as type:"error" while it
// retries a dropped stream; the turn continues afterward, so these must render
// as progress and not abort the stage. Every other error is a fatal failure.
const RECONNECT_NOTICE = /^\s*reconnecting\b/i;

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "plan",
  "todo_list",
]);

function toolName(item: Record<string, unknown>): string {
  switch (item.type) {
    case "command_execution":
      return "command";
    case "file_change":
      return "file_change";
    case "mcp_tool_call": {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool) ?? stringValue(item.name);
      return [server, tool].filter(Boolean).join(".") || "mcp";
    }
    case "web_search":
      return "web_search";
    case "plan":
    case "todo_list":
      return "plan";
    default:
      return "tool";
  }
}

function toolInput(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case "command_execution":
      return { command: item.command };
    case "mcp_tool_call":
      return item.arguments;
    case "web_search":
      return { query: item.query };
    case "file_change":
      return item.changes;
    case "plan":
    case "todo_list":
      return item.text ?? item.items;
    default:
      return undefined;
  }
}

function toolOutput(item: Record<string, unknown>): unknown {
  return (
    item.aggregated_output ??
    item.output ??
    item.result ??
    item.error ??
    item.changes ??
    item.text ??
    item.items ??
    ""
  );
}

function toolFailed(item: Record<string, unknown>): boolean {
  return (
    item.status === "failed" ||
    item.status === "declined" ||
    (typeof item.exit_code === "number" && item.exit_code !== 0) ||
    item.error != null
  );
}

/**
 * Token usage from a Codex `turn.completed` record. Codex reports only the
 * usage block here (no cost or turn count), so the history header shows tokens
 * alone for Codex stages. Absent or non-numeric fields are left unset.
 */
function codexTurnMeta(event: Record<string, unknown>): StageMeta {
  const meta: StageMeta = {};
  const usage = record(event.usage);
  if (usage) {
    if (typeof usage.input_tokens === "number") {
      meta.inputTokens = usage.input_tokens;
    }
    if (typeof usage.output_tokens === "number") {
      meta.outputTokens = usage.output_tokens;
    }
  }
  return meta;
}

export function createCodexDecoder(): AgentStreamDecoder {
  // The final agent message is the stage's completion string — for the gate
  // stage, loop.ts sentinel-checks it for `<promise>NO MORE TASKS</promise>`.
  // Codex must therefore emit the sentinel in its terminal message (Claude
  // returns it via the `result` record).
  let lastAgentMessage: string | undefined;
  let turnCompleted = false;

  return {
    decode(raw): AgentDecodeResult {
      const event = record(raw);
      if (!event || typeof event.type !== "string") return { events: [] };

      if (event.type === "thread.started") {
        const thread = stringValue(event.thread_id) ?? "?";
        return {
          events: [{ type: "init", detail: `agent=codex thread=${thread}` }],
        };
      }

      if (event.type === "turn.started") {
        return {
          events: [{ type: "diagnostic", message: "turn started" }],
        };
      }

      if (event.type === "item.started" || event.type === "item.completed") {
        const item = record(event.item);
        if (!item || typeof item.type !== "string") return { events: [] };

        if (item.type === "agent_message") {
          if (
            event.type === "item.completed" &&
            typeof item.text === "string"
          ) {
            lastAgentMessage = item.text;
            return {
              events: [{ type: "assistant", text: item.text }],
            };
          }
          return { events: [] };
        }

        if (item.type === "reasoning") {
          return event.type === "item.started"
            ? { events: [{ type: "thinking" }] }
            : { events: [] };
        }

        if (!TOOL_ITEM_TYPES.has(item.type)) return { events: [] };
        const id = stringValue(item.id);
        const name = toolName(item);
        if (event.type === "item.started") {
          return {
            events: [
              {
                type: "tool-start",
                id,
                name,
                input: toolInput(item),
              },
            ],
          };
        }
        return {
          events: [
            {
              type: "tool-result",
              id,
              name,
              content: toolOutput(item),
              isError: toolFailed(item),
            },
          ],
        };
      }

      if (event.type === "turn.completed") {
        if (lastAgentMessage === undefined) {
          return {
            events: [],
            failure: "codex turn completed without a final agent message",
          };
        }
        turnCompleted = true;
        const meta = codexTurnMeta(event);
        const result: AgentDecodeResult = {
          events: [],
          completion: lastAgentMessage,
        };
        if (Object.keys(meta).length > 0) result.meta = meta;
        return result;
      }

      if (event.type === "turn.failed") {
        return {
          events: [],
          failure: failureMessage(event, "codex turn failed"),
        };
      }

      if (event.type === "error") {
        const message = failureMessage(event, "codex error");
        if (RECONNECT_NOTICE.test(message)) {
          return { events: [{ type: "diagnostic", message }] };
        }
        return { events: [], failure: message };
      }

      return { events: [] };
    },
    finish() {
      if (!turnCompleted) {
        throw new Error("codex exited without turn.completed");
      }
      if (lastAgentMessage === undefined) {
        throw new Error("codex turn completed without a final agent message");
      }
      return lastAgentMessage;
    },
  };
}

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT = "high";

export type CodexModelResolution = {
  model?: string;
  modelSource: "explicit" | "user config" | "Ralph default";
  reasoningEffort?: string;
  reasoningSource: "explicit" | "user config" | "Ralph default";
};

/**
 * Resolve model and effort independently: each is the explicit value when one
 * was tuned, else the Ralph default for an isolated run, else whatever the
 * inherited user config holds. Isolated Codex now always sends an effort,
 * whatever the model — an explicitly pinned model used to leave the effort to
 * the Codex CLI's own default.
 */
export function resolveCodexModel(
  rawModel: string | undefined,
  rawEffort: string | undefined,
  codexUserConfig: boolean
): CodexModelResolution {
  const model = rawModel?.trim();
  const effort = rawEffort?.trim();

  const resolution: CodexModelResolution = {
    modelSource: "user config",
    reasoningSource: "user config",
  };
  if (model) {
    resolution.model = model;
    resolution.modelSource = "explicit";
  } else if (!codexUserConfig) {
    resolution.model = DEFAULT_CODEX_MODEL;
    resolution.modelSource = "Ralph default";
  }
  if (effort) {
    resolution.reasoningEffort = effort;
    resolution.reasoningSource = "explicit";
  } else if (!codexUserConfig) {
    resolution.reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
    resolution.reasoningSource = "Ralph default";
  }
  return resolution;
}

// CODEX_HOME must stay off the credential bind mount: Codex creates a unix
// socket and symlinks in its home at startup, which Docker Desktop for
// Windows bind mounts reject with "Operation not permitted (os error 1)"
// (fatal at app-server init). The host ~/.codex is instead mounted read-only
// at this staging path and the setup script copies the credential files into
// a container-local CODEX_HOME before exec'ing codex ($0="codex", $@=rest).
// Trade-off: an OAuth token refresh inside the container is not written back
// to the host; the host CLI re-refreshes on its next use.
const CODEX_CREDS_MOUNT = "/mnt/codex-creds";

// Codex scans $HOME/.agents/skills as a User-scope skills root even under
// --ignore-user-config and --ephemeral, so mounting there needs no flag.
export const CODEX_SKILLS_ROOT = "/home/agent/.agents/skills";

/**
 * The image's codex CLI is frozen at build time, and a stale one is not merely
 * old: the server refuses models it predates ("The 'gpt-6-astra' model requires
 * a newer version of Codex", HTTP 400), which kills every stage of a run. So
 * every stage runs `codex update` first. npm owns the install, so the CLI lives
 * under an agent-owned prefix rather than the root-owned global one — that
 * directory is a named volume shared by every workspace on the host, so the
 * download is paid once and every later stage costs a version check.
 * `RALPH_CODEX_UPDATE=0` skips the update and the mount together: a volume left
 * mounted without updates would shadow a fresher image.
 */
export const CODEX_CLI_VOLUME = "ralph-codex-cli";
export const CODEX_CLI_PATH = "/home/agent/.npm-global";

export function codexUpdateEnabled(): boolean {
  return process.env.RALPH_CODEX_UPDATE?.trim() !== "0";
}

// `codex update` reports on stdout, which the runner decodes as JSONL, so the
// report goes to stderr (shown on the host as `docker  …` lines). A failed
// update (offline, registry down) leaves the installed version in place.
const CODEX_UPDATE_STEP = "codex update 1>&2 || true; ";

export function codexSetupScript(): string {
  return (
    'mkdir -p "$CODEX_HOME"; ' +
    (codexUpdateEnabled() ? CODEX_UPDATE_STEP : "") +
    "for f in auth.json config.toml AGENTS.md; do " +
    `if [ -f "${CODEX_CREDS_MOUNT}/$f" ]; then cp "${CODEX_CREDS_MOUNT}/$f" "$CODEX_HOME/"; fi; ` +
    "done; " +
    'exec "$0" "$@"'
  );
}

export function buildCodexArgs(context: AgentCommandContext): string[] {
  const args = [
    "bash",
    "-c",
    codexSetupScript(),
    "codex",
    "exec",
    "--json",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (!context.codexUserConfig) {
    args.push("--ignore-user-config");
  }
  const resolution = context.configSnapshot
    ? {
        model: context.configSnapshot.model,
        reasoningEffort: context.configSnapshot.effort,
      }
    : resolveCodexModel(
        context.rawModel,
        context.rawEffort,
        context.codexUserConfig
      );
  if (resolution.model) {
    args.push("--model", resolution.model);
  }
  if (resolution.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${resolution.reasoningEffort}"`);
  }
  args.push(context.promptInstruction);
  return args;
}

export const codexAdapter = {
  name: "codex",
  // Ultra is a Codex mode whose availability depends on the selected model.
  effortLevels: [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ],
  containerEnv: {
    CODEX_HOME: "/home/agent/.codex",
  },
  credentialMounts(home) {
    const joinHome = home.startsWith("/") ? posix.join : join;
    return [
      {
        hostPath: joinHome(home, ".codex"),
        containerPath: CODEX_CREDS_MOUNT,
        readOnly: true,
      },
    ];
  },
  skillsMount(hostDir) {
    return {
      hostPath: hostDir,
      containerPath: CODEX_SKILLS_ROOT,
      readOnly: true,
    };
  },
  volumeMounts() {
    if (!codexUpdateEnabled()) return [];
    return [
      {
        name: CODEX_CLI_VOLUME,
        containerPath: CODEX_CLI_PATH,
        labels: ["ralph.kind=codex-cli"],
      },
    ];
  },
  buildCommand: buildCodexArgs,
  createDecoder: createCodexDecoder,
} satisfies AgentAdapter;
