import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { AgentAdapter, AgentName, AgentSelection } from "./types.js";

export type {
  AgentAdapter,
  AgentCommandContext,
  AgentConfigSnapshot,
  AgentDecodeResult,
  AgentMount,
  AgentName,
  AgentRenderEvent,
  AgentSelection,
  AgentSelectionSource,
  AgentStreamDecoder,
  StageMeta,
} from "./types.js";

const ADAPTERS: Record<AgentName, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/** Single source of truth for the `--codex-user-config` + non-Codex invariant. */
export const CODEX_USER_CONFIG_REQUIRES_CODEX =
  "--codex-user-config requires Codex; select it with --agent codex or RALPH_AGENT=codex";

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

/** A tuned model or effort, with the literal name of where it came from. */
export type TuningValue = { value: string; source: string };
export type AgentTuning = { model?: TuningValue; effort?: TuningValue };

const AGENT_NAMES = Object.keys(ADAPTERS) as AgentName[];

/**
 * The effort levels every adapter accepts, so the agent-agnostic RALPH_EFFORT
 * can be validated before the agent is even known to be the one that runs.
 * Computed from ADAPTERS: a new provider narrows it without a table edit.
 */
export const SHARED_EFFORT_LEVELS: readonly string[] = AGENT_NAMES.reduce<
  readonly string[]
>(
  (shared, name) =>
    shared.filter((level) => ADAPTERS[name].effortLevels.includes(level)),
  ADAPTERS[AGENT_NAMES[0]].effortLevels
);

function envName(agent: AgentName | undefined, field: string): string {
  return agent ? `RALPH_${agent.toUpperCase()}_${field}` : `RALPH_${field}`;
}

function firstTuned(
  flagName: string,
  explicit: string | undefined,
  agent: AgentName,
  field: "MODEL" | "EFFORT",
  env: NodeJS.ProcessEnv
): TuningValue | undefined {
  const candidates: [string, string | undefined][] = [
    [flagName, explicit],
    [envName(agent, field), env[envName(agent, field)]],
    [envName(undefined, field), env[envName(undefined, field)]],
  ];
  for (const [source, raw] of candidates) {
    const value = raw?.trim();
    if (value) return { value, source };
  }
  return undefined;
}

/**
 * Resolve the model and effort for this run: flag, then the agent's own env
 * var, then the agent-agnostic one. Blank or whitespace-only counts as unset.
 * Pure — it applies no adapter default and checks no level.
 */
export function resolveAgentTuning(
  agent: AgentName,
  explicit: { model?: string; effort?: string },
  env: NodeJS.ProcessEnv
): AgentTuning {
  const tuning: AgentTuning = {};
  const model = firstTuned("--model", explicit.model, agent, "MODEL", env);
  if (model) tuning.model = model;
  const effort = firstTuned("--effort", explicit.effort, agent, "EFFORT", env);
  if (effort) tuning.effort = effort;
  return tuning;
}

/**
 * Check a resolved tuning against the agent's CLI, returning one message or
 * undefined. An effort from the agent-agnostic RALPH_EFFORT has to hold for
 * every agent, so it is checked against the shared levels — a level only one
 * provider knows is reachable through that provider's own variable, which the
 * message says. The model is never checked: any non-blank string is a model
 * identifier as far as Ralph is concerned.
 */
export function validateAgentTuning(
  agent: AgentName,
  tuning: AgentTuning
): string | undefined {
  const effort = tuning.effort;
  if (!effort) return undefined;
  const generic = effort.source === envName(undefined, "EFFORT");
  const allowed = generic ? SHARED_EFFORT_LEVELS : ADAPTERS[agent].effortLevels;
  if (allowed.includes(effort.value)) return undefined;

  const stem = generic
    ? `is not an effort level every agent accepts`
    : `is not a ${agent} effort level`;
  const message = `${effort.source}=${effort.value} ${stem}; expected one of ${allowed.join("|")}`;
  if (!generic) return message;
  // Only worth pointing at a provider-specific variable when one of them does
  // accept this level; otherwise the hint buys a second identical failure.
  const owner = AGENT_NAMES.find((name) =>
    ADAPTERS[name].effortLevels.includes(effort.value)
  );
  if (!owner) return message;
  return `${message}; set ${envName(owner, "EFFORT")}=${effort.value} for a ${owner} effort level`;
}
