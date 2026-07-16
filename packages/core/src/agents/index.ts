import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { AgentAdapter, AgentName, AgentSelection } from "./types.js";

export type {
  AgentAdapter,
  AgentCommandContext,
  AgentMount,
  AgentName,
  AgentSelection,
  AgentSelectionSource,
} from "./types.js";

const ADAPTERS: Record<AgentName, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function parseAgentName(raw: string): AgentName {
  const value = raw.trim();
  if (value === "claude" || value === "codex") return value;
  throw new Error(
    `Unsupported agent ${JSON.stringify(raw)}; expected "claude" or "codex"`
  );
}

export function resolveAgentSelection(
  explicit: AgentName | undefined,
  envValue: string | undefined
): AgentSelection {
  if (explicit) return { agent: explicit, source: "--agent" };
  if (envValue?.trim()) {
    return {
      agent: parseAgentName(envValue),
      source: "RALPH_AGENT",
    };
  }
  return { agent: "claude", source: "default" };
}

export function getAgentAdapter(name: AgentName): AgentAdapter {
  return ADAPTERS[name];
}
