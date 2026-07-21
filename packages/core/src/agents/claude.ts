import { join, posix } from "node:path";

import type { Stage } from "../stages.js";
import { record } from "./shared.js";
import type {
  AgentAdapter,
  AgentCommandContext,
  AgentDecodeResult,
  AgentRenderEvent,
  AgentStreamDecoder,
} from "./types.js";

export function createClaudeDecoder(): AgentStreamDecoder {
  let finalResult = "";

  return {
    decode(raw): AgentDecodeResult {
      const event = record(raw);
      if (!event || typeof event.type !== "string") return { events: [] };

      if (event.type === "system" && event.subtype === "init") {
        const model = typeof event.model === "string" ? event.model : "?";
        const cwd = typeof event.cwd === "string" ? event.cwd : "?";
        return {
          events: [{ type: "init", detail: `model=${model} cwd=${cwd}` }],
        };
      }

      if (event.type === "assistant") {
        const message = record(event.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        const events: AgentRenderEvent[] = [];
        for (const value of content) {
          const block = record(value);
          if (!block || typeof block.type !== "string") continue;
          if (block.type === "text" && typeof block.text === "string") {
            events.push({ type: "assistant", text: block.text });
          } else if (block.type === "thinking") {
            events.push({ type: "thinking" });
          } else if (block.type === "tool_use") {
            events.push({
              type: "tool-start",
              id: typeof block.id === "string" ? block.id : undefined,
              name: typeof block.name === "string" ? block.name : "?",
              input: block.input,
            });
          }
        }
        return { events };
      }

      if (event.type === "user") {
        const message = record(event.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        const events: AgentRenderEvent[] = [];
        for (const value of content) {
          const block = record(value);
          if (!block || block.type !== "tool_result") continue;
          events.push({
            type: "tool-result",
            id:
              typeof block.tool_use_id === "string"
                ? block.tool_use_id
                : undefined,
            content: block.content,
            isError: block.is_error === true,
          });
        }
        return { events };
      }

      if (event.type === "result") {
        if (typeof event.result === "string") finalResult = event.result;
        return {
          events:
            event.is_error === true
              ? [
                  {
                    type: "diagnostic",
                    message: "result errored",
                    isError: true,
                  },
                ]
              : [],
          completion: finalResult,
        };
      }

      return { events: [] };
    },
    finish() {
      return finalResult;
    },
  };
}

export function resolveModelArgs(raw: string | undefined): string[] {
  const model = raw?.trim();
  return model ? ["--model", model] : [];
}

function buildClaudeCommand(
  stage: Stage,
  promptInstruction: string,
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
  args.push(...modelArgs, promptInstruction);
  return args;
}

export function buildClaudeArgs(
  stage: Stage,
  promptContainerPath: string,
  modelArgs: string[]
): string[] {
  return buildClaudeCommand(
    stage,
    `Read the full instructions from the file ./${promptContainerPath} in the current workspace and execute them.`,
    modelArgs
  );
}

function buildFromContext(context: AgentCommandContext): string[] {
  return buildClaudeCommand(
    context.stage,
    context.promptInstruction,
    resolveModelArgs(context.rawModel)
  );
}

export const claudeAdapter = {
  name: "claude",
  containerEnv: {},
  credentialMounts(home) {
    const joinHome = home.startsWith("/") ? posix.join : join;
    return [
      {
        hostPath: joinHome(home, ".claude"),
        containerPath: "/home/agent/.claude",
      },
      {
        hostPath: joinHome(home, ".claude.json"),
        containerPath: "/home/agent/.claude.json",
      },
    ];
  },
  buildCommand: buildFromContext,
  createDecoder: createClaudeDecoder,
} satisfies AgentAdapter;
