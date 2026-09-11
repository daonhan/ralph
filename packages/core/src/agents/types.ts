import type { SandboxVolume } from "../sandbox-volumes.js";
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
  /** Host home dir (HOME || USERPROFILE); "" when neither is set. */
  home: string;
  /** True when runStage mounted the shipped skills directory into the container. */
  skillsMounted?: boolean;
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

/**
 * Per-stage metadata surfaced to the loop alongside the completion text. Every
 * field is optional: the decoders fill what the provider reports and the stream
 * runner owns `graceTimerFired`. Consumed by the iteration-history writer.
 */
export type StageMeta = {
  costUsd?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError?: boolean;
  apiErrorStatus?: number;
  graceTimerFired?: boolean;
};

export type AgentDecodeResult = {
  events: AgentRenderEvent[];
  completion?: string;
  failure?: string;
  meta?: StageMeta;
};

export interface AgentStreamDecoder {
  decode(raw: unknown): AgentDecodeResult;
  finish(): string;
}

export interface AgentAdapter {
  readonly name: AgentName;
  readonly containerEnv: Readonly<Record<string, string>>;
  credentialMounts(home: string): AgentMount[];
  /** Read-only mount of the shipped skills directory where this provider discovers skills. */
  skillsMount(hostDir: string): AgentMount;
  /**
   * Named volumes mounted over image paths the provider writes to at runtime.
   * Docker creates each on first use and seeds it from the image, so the
   * mount needs no preparation. Empty when the provider keeps nothing.
   */
  volumeMounts(): SandboxVolume[];
  buildCommand(context: AgentCommandContext): string[];
  createDecoder(): AgentStreamDecoder;
}
