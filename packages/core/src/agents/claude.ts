import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import type { Stage } from "../stages.js";
import { bold, dim, red, SYM } from "../stream-render.js";
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

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5[1m]";

export type ClaudeModelResolution = {
  /** Undefined means: send no `--model` and let the container CLI resolve. */
  model?: string;
  modelSource:
    | "RALPH_MODEL"
    | "host settings"
    | "Ralph default"
    | "host provider config";
};

/**
 * Third-party routing flags. When one is enabled in the host settings, model
 * identifiers are provider-specific (Bedrock uses inference-profile IDs such
 * as `us.anthropic.claude-opus-4-8`), so a first-party ID like
 * DEFAULT_CLAUDE_MODEL would be rejected.
 */
const PROVIDER_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

export type HostClaudeModel = {
  /** Explicit model from the host settings, if any. */
  model?: string;
  /** Name of a third-party provider flag enabled in the host settings. */
  providerFlag?: string;
  /**
   * Set when a settings file exists but is unusable. Kept distinct from an
   * absent file because the two mean opposite things: no file means the user
   * chose nothing, while an unreadable one means their choice exists and Ralph
   * is about to override it with a default.
   */
  unreadable?: string;
};

// Settings env values are documented as strings, but JSON makes `1` or `true`
// an easy slip — and missing an enabled provider flag here would pin a
// first-party model onto a Bedrock/Vertex/Foundry host, failing every stage.
function envValue(env: unknown, key: string): string {
  const table = record(env);
  const value = table?.[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/**
 * Read the model the host chose from `~/.claude/settings.json`. The `/model`
 * picker only stores a `model` key for an explicit pick: choosing its
 * "(default)" entry deletes the key, which leaves the host's effective model
 * unreadable from disk (`claude doctor` and `~/.claude.json` don't expose it
 * either). The literal "default" sentinel is treated the same as an absent
 * key.
 *
 * The settings `env` block is read too: it applies to the container session
 * through the bind-mounted settings file, and `ANTHROPIC_MODEL` set there
 * outranks the `model` key — but is itself outranked by the `--model` flag
 * Ralph passes, so it has to be honored here or it would be silently
 * overridden.
 *
 * Only `$HOME/.claude` is consulted; a host that relocates its config with
 * CLAUDE_CONFIG_DIR is not supported here, matching `credentialMounts`.
 */
export function readHostClaudeModel(home: string): HostClaudeModel {
  if (!home) return {};
  const joinHome = home.startsWith("/") ? posix.join : join;
  const settingsPath = joinHome(home, ".claude", "settings.json");

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return { unreadable: `${settingsPath} (${code ?? "read failed"})` };
  }

  let parsed: { model?: unknown; env?: unknown };
  try {
    parsed = JSON.parse(raw) as { model?: unknown; env?: unknown };
  } catch {
    return { unreadable: `${settingsPath} (invalid JSON)` };
  }

  const providerFlag = PROVIDER_FLAGS.find((flag) => {
    const value = envValue(parsed.env, flag);
    return value !== "" && value !== "0" && value !== "false";
  });

  const envModel = envValue(parsed.env, "ANTHROPIC_MODEL");
  const settingsModel =
    typeof parsed.model === "string" ? parsed.model.trim() : "";
  const model = envModel || settingsModel;
  if (!model || model === "default") return { providerFlag };
  return { model, providerFlag };
}

/**
 * Resolve the model the sandbox should run: RALPH_MODEL, then whatever the
 * host settings pin, then Ralph's own default. The default exists because the
 * sandbox image's claude CLI is frozen at image build time and its built-in
 * default lags the host's (observed: host 2.1.220 defaults to Opus 5 while the
 * image's 2.1.216 defaults to Opus 4.8), so leaving the choice to the
 * container silently downgrades the model.
 *
 * The one case that still defers to the container is third-party routing,
 * where a first-party model ID would be rejected outright — there, the
 * container CLI resolves a provider-appropriate model as it did before.
 */
export function resolveClaudeModel(
  rawModel: string | undefined,
  host: HostClaudeModel | undefined
): ClaudeModelResolution {
  const explicit = rawModel?.trim();
  if (explicit) return { model: explicit, modelSource: "RALPH_MODEL" };
  const hostModel = host?.model?.trim();
  if (hostModel) return { model: hostModel, modelSource: "host settings" };
  if (host?.providerFlag) return { modelSource: "host provider config" };
  return { model: DEFAULT_CLAUDE_MODEL, modelSource: "Ralph default" };
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

let unreadableSettingsWarned = false;

function buildFromContext(context: AgentCommandContext): string[] {
  const host = readHostClaudeModel(context.home);
  if (host.unreadable && !unreadableSettingsWarned) {
    unreadableSettingsWarned = true;
    process.stderr.write(
      `${red(SYM.bullet)} ${bold("host claude settings unreadable")} ${dim(
        `(${host.unreadable}) — any model set there is being ignored; pin one with RALPH_MODEL.`
      )}\n`
    );
  }
  const resolution = resolveClaudeModel(context.rawModel, host);
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
