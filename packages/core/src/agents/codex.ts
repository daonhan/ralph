import { join, posix } from "node:path";

import { record } from "./shared.js";
import type {
  AgentAdapter,
  AgentCommandContext,
  AgentDecodeResult,
  AgentStreamDecoder,
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
        return { events: [], completion: lastAgentMessage };
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
  modelSource: "RALPH_MODEL" | "user config" | "Ralph default";
  reasoningEffort?: string;
  reasoningSource: "user config" | "Codex CLI default" | "Ralph default";
};

export function resolveCodexModel(
  rawModel: string | undefined,
  codexUserConfig: boolean
): CodexModelResolution {
  const explicit = rawModel?.trim();
  if (explicit) {
    return {
      model: explicit,
      modelSource: "RALPH_MODEL",
      reasoningSource: codexUserConfig ? "user config" : "Codex CLI default",
    };
  }
  if (codexUserConfig) {
    return {
      modelSource: "user config",
      reasoningSource: "user config",
    };
  }
  return {
    model: DEFAULT_CODEX_MODEL,
    modelSource: "Ralph default",
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    reasoningSource: "Ralph default",
  };
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

const CODEX_SETUP_SCRIPT =
  'mkdir -p "$CODEX_HOME"; ' +
  "for f in auth.json config.toml AGENTS.md; do " +
  `if [ -f "${CODEX_CREDS_MOUNT}/$f" ]; then cp "${CODEX_CREDS_MOUNT}/$f" "$CODEX_HOME/"; fi; ` +
  "done; " +
  'exec "$0" "$@"';

export function buildCodexArgs(context: AgentCommandContext): string[] {
  const args = [
    "bash",
    "-c",
    CODEX_SETUP_SCRIPT,
    "codex",
    "exec",
    "--json",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (!context.codexUserConfig) {
    args.push("--ignore-user-config");
  }
  const resolution = resolveCodexModel(
    context.rawModel,
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
  buildCommand: buildCodexArgs,
  createDecoder: createCodexDecoder,
} satisfies AgentAdapter;
