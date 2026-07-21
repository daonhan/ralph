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

export type AgentRenderEvent =
  | { type: "init"; detail: string }
  | { type: "assistant"; text: string }
  | { type: "thinking" }
  | {
      type: "tool-start";
      id?: string;
      name: string;
      input?: unknown;
    }
  | {
      type: "tool-result";
      id?: string;
      name?: string;
      content?: unknown;
      isError?: boolean;
    }
  | { type: "diagnostic"; message: string; isError?: boolean };

export type AgentDecodeResult = {
  events: AgentRenderEvent[];
  completion?: string;
  failure?: string;
};

export interface AgentStreamDecoder {
  decode(raw: unknown): AgentDecodeResult;
  finish(): string;
}

export interface AgentAdapter {
  readonly name: AgentName;
  readonly containerEnv: Readonly<Record<string, string>>;
  credentialMounts(home: string): AgentMount[];
  buildCommand(context: AgentCommandContext): string[];
  createDecoder(): AgentStreamDecoder;
}
