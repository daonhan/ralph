import { join, posix } from "node:path";

import type { AgentAdapter, AgentCommandContext } from "./types.js";

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

export function buildCodexArgs(context: AgentCommandContext): string[] {
  const args = [
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
        containerPath: "/home/agent/.codex",
      },
    ];
  },
  buildCommand: buildCodexArgs,
} satisfies AgentAdapter;
