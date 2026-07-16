import type { Stage } from "../stages.js";

export type AgentName = "claude" | "codex";
export type AgentSelectionSource = "--agent" | "RALPH_AGENT" | "default";

export type AgentSelection = {
  agent: AgentName;
  source: AgentSelectionSource;
};

export type AgentMount = {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
};

export type AgentCommandContext = {
  stage: Stage;
  promptInstruction: string;
  rawModel: string | undefined;
  codexUserConfig: boolean;
};

export interface AgentAdapter {
  readonly name: AgentName;
  readonly containerEnv: Readonly<Record<string, string>>;
  credentialMounts(home: string): AgentMount[];
  buildCommand(context: AgentCommandContext): string[];
}
