import { join, posix } from "node:path";

import type { Stage } from "../stages.js";
import type { AgentAdapter, AgentCommandContext } from "./types.js";

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
} satisfies AgentAdapter;
