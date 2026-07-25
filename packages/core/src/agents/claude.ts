import { readFileSync } from "node:fs";
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

export type ClaudeModelResolution = {
  model?: string;
  modelSource: "RALPH_MODEL" | "host settings" | "sandbox CLI default";
};

/**
 * Read the model the host `/model` picker saved to `~/.claude/settings.json`.
 * The picker's "(default)" entry stores no `model` key, and the sandbox
 * image's claude CLI is frozen at image build time — its built-in default can
 * lag the host CLI's (observed: host 2.1.220 defaults to Opus 5 while the
 * image's 2.1.216 defaults to Opus 4.8). Forwarding the host's explicit
 * choice as `--model` pins the sandbox to what the host shows. The literal
 * "default" sentinel is skipped so the sandbox CLI keeps resolving it itself.
 */
export function readHostClaudeModel(home: string): string | undefined {
  if (!home) return undefined;
  const joinHome = home.startsWith("/") ? posix.join : join;
  try {
    const raw = readFileSync(
      joinHome(home, ".claude", "settings.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as { model?: unknown };
    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    if (!model || model === "default") return undefined;
    return model;
  } catch {
    return undefined;
  }
}

export function resolveClaudeModel(
  rawModel: string | undefined,
  hostModel: string | undefined
): ClaudeModelResolution {
  const explicit = rawModel?.trim();
  if (explicit) return { model: explicit, modelSource: "RALPH_MODEL" };
  const host = hostModel?.trim();
  if (host) return { model: host, modelSource: "host settings" };
  return { modelSource: "sandbox CLI default" };
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
  const resolution = resolveClaudeModel(
    context.rawModel,
    readHostClaudeModel(context.home)
  );
  return buildClaudeCommand(
    context.stage,
    context.promptInstruction,
    resolution.model ? ["--model", resolution.model] : []
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
