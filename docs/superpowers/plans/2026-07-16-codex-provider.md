# Codex Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex as an opt-in provider for both Ralph AFK commands while preserving Claude as the default and retaining one shared Docker/loop pipeline.

**Architecture:** Introduce a small provider registry whose Claude and Codex adapters own command construction, credential declarations, and JSONL decoding. Keep Docker lifecycle, retries, cancellation, prompt rendering, logs, grace handling, and sentinel gating shared. Normalize provider events before terminal rendering so the loop always receives one final message string.

**Tech Stack:** Node.js 20+, TypeScript 5.6 with ESM/NodeNext, pnpm 9, Vitest 4, Node `node:test`, Docker, Claude Code CLI, `@openai/codex@0.144.4`.

## Global Constraints

- Claude remains the default for every existing CLI and library invocation.
- `--agent codex` opts into Codex; `--agent` wins over `RALPH_AGENT`.
- `--codex-user-config` is valid only with Codex; Codex ignores user config by default.
- `RALPH_MODEL` stays the single shared model override.
- Isolated Codex with no `RALPH_MODEL` uses `gpt-5.6-sol` and `model_reasoning_effort="high"`.
- Explicit model failures never trigger a fallback run.
- Authentication uses a read-write host `~/.codex` mount; do not add API-key handling.
- Only the selected provider's credentials enter the container.
- Both providers share the shipped templates and first-stage sentinel.
- Keep ESM relative imports ending in `.js`.
- Do not add TypeScript to `apps/cli`, new CLI binaries, or a Codex SDK dependency.
- Keep `permissionMode: "bypassPermissions"` for built-in stages and use Codex's externally-sandboxed bypass flag.
- Do not edit generated changelogs.

---

## File Structure

### Create

- `packages/core/src/agents/types.ts` — provider names, selection, command/mount contracts, normalized stream types, decoder contract.
- `packages/core/src/agents/claude.ts` — Claude argv, credentials, model pass-through, and Claude stream decoder.
- `packages/core/src/agents/codex.ts` — Codex argv, credentials, model precedence, and Codex stream decoder.
- `packages/core/src/agents/index.ts` — registry plus strict CLI/environment selection helpers.
- `packages/core/src/__tests__/agents.test.ts` — selection, command, model, mount, and environment contracts.
- `packages/core/src/__tests__/agent-decoders.test.ts` — provider JSONL translation and final-message contracts.
- `packages/core/src/__tests__/stream-render.test.ts` — normalized stdout/stderr rendering.
- `packages/core/src/__tests__/runner-stream.test.ts` — decoder integration, provider failure, incomplete stream, and grace timer.
- `packages/core/src/__tests__/cli-help.test.ts` — new flags and resolved config descriptions.
- `packages/core/src/__tests__/run-bin.test.ts` — selected provider/config forwarding for both positional shapes.
- `packages/core/src/__tests__/template-contract.test.ts` — shared reviewer convention names.

### Modify

- `packages/core/src/runner.ts` — select an adapter, mount only its credentials, decode normalized events, generalize completion grace handling.
- `packages/core/src/stream-render.ts` — render normalized events while preserving Claude's visible format.
- `packages/core/src/loop.ts` — carry provider/config options to every stage.
- `packages/core/src/cli-help.ts` — parse flags, validate combinations, document and print resolved provider settings.
- `packages/core/src/run-bin.ts` — resolve flag/environment precedence and pass it into the loop.
- `packages/core/src/main.ts` and `packages/core/src/gh-main.ts` — provider-neutral descriptions.
- `packages/core/src/index.ts` — export public provider selection types.
- `packages/core/src/__tests__/runner.test.ts`, `packages/core/src/__tests__/loop.test.ts`, and `packages/core/src/__tests__/detach.test.ts` — preserve helper compatibility and assert forwarding/mounts.
- `packages/core/templates/Dockerfile` — install the pinned Codex CLI alongside Claude.
- `scripts/smoke-image.mjs` and `scripts/smoke-image.test.mjs` — enforce Codex version and automation flags in the image contract.
- `packages/core/templates/review.md` — recognize `AGENTS.md` as well as `CLAUDE.md`.
- `README.md`, `QUICKSTART.md`, `packages/core/README.md`, `apps/cli/README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md` — setup, behavior, security, extension, and troubleshooting guidance.
- `docs/ralph-stack.svg` — provider-aware architecture labels.
- `docs/ralph-stack.png` — rendered copy of the provider-aware SVG.
- `packages/core/package.json` and `apps/cli/package.json` — provider-neutral descriptions and Codex/OpenAI keywords.

---

### Task 1: Provider selection, command, model, and credential contracts

**Files:**

- Create: `packages/core/src/agents/types.ts`
- Create: `packages/core/src/agents/claude.ts`
- Create: `packages/core/src/agents/codex.ts`
- Create: `packages/core/src/agents/index.ts`
- Create: `packages/core/src/__tests__/agents.test.ts`

**Interfaces:**

- Produces: `AgentName`, `AgentSelection`, `AgentMount`, `AgentCommandContext`, `AgentAdapter`.
- Produces: `parseAgentName(raw: string): AgentName`.
- Produces: `resolveAgentSelection(explicit, envValue): AgentSelection`.
- Produces: `getAgentAdapter(name: AgentName): AgentAdapter`.
- Produces: compatibility helpers `resolveModelArgs` and `buildClaudeArgs`.
- Produces: `resolveCodexModel` and `buildCodexArgs`.

- [ ] **Step 1: Write the provider contract tests**

Create `packages/core/src/__tests__/agents.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  getAgentAdapter,
  parseAgentName,
  resolveAgentSelection,
} from "../agents/index.js";
import { buildClaudeArgs, resolveModelArgs } from "../agents/claude.js";
import {
  buildCodexArgs,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  resolveCodexModel,
} from "../agents/codex.js";

const stage = {
  name: "implementer",
  template: "afk.md",
  permissionMode: "bypassPermissions",
};
const promptInstruction =
  "Read the full instructions from the file ./.ralph-tmp/prompt.md in the current workspace and execute them.";

describe("agent selection", () => {
  it("defaults to Claude", () => {
    expect(resolveAgentSelection(undefined, undefined)).toEqual({
      agent: "claude",
      source: "default",
    });
    expect(resolveAgentSelection(undefined, "   ")).toEqual({
      agent: "claude",
      source: "default",
    });
  });

  it("uses RALPH_AGENT when no explicit flag exists", () => {
    expect(resolveAgentSelection(undefined, " codex ")).toEqual({
      agent: "codex",
      source: "RALPH_AGENT",
    });
  });

  it("lets the explicit flag win over RALPH_AGENT", () => {
    expect(resolveAgentSelection("claude", "codex")).toEqual({
      agent: "claude",
      source: "--agent",
    });
  });

  it("rejects unsupported names", () => {
    expect(() => parseAgentName("gemini")).toThrow(
      'Unsupported agent "gemini"; expected "claude" or "codex"'
    );
  });
});

describe("Claude adapter", () => {
  it("preserves model pass-through parsing", () => {
    expect(resolveModelArgs(undefined)).toEqual([]);
    expect(resolveModelArgs("   ")).toEqual([]);
    expect(resolveModelArgs(" opus ")).toEqual(["--model", "opus"]);
  });

  it("preserves the complete Claude argv", () => {
    expect(
      buildClaudeArgs(stage, ".ralph-tmp/prompt.md", ["--model", "opus"])
    ).toEqual([
      "claude",
      "--verbose",
      "--print",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "opus",
      promptInstruction,
    ]);
  });

  it("declares only Claude credentials", () => {
    const adapter = getAgentAdapter("claude");
    expect(adapter.credentialMounts("/home/me")).toEqual([
      {
        hostPath: "/home/me/.claude",
        containerPath: "/home/agent/.claude",
      },
      {
        hostPath: "/home/me/.claude.json",
        containerPath: "/home/agent/.claude.json",
      },
    ]);
    expect(adapter.containerEnv).toEqual({});
  });
});

describe("Codex adapter", () => {
  it("resolves the isolated Sol/high default", () => {
    expect(resolveCodexModel(undefined, false)).toEqual({
      model: DEFAULT_CODEX_MODEL,
      modelSource: "Ralph default",
      reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
      reasoningSource: "Ralph default",
    });
  });

  it("leaves model and effort to inherited user config", () => {
    expect(resolveCodexModel(undefined, true)).toEqual({
      modelSource: "user config",
      reasoningSource: "user config",
    });
  });

  it("uses an explicit model without adding the Ralph effort default", () => {
    expect(resolveCodexModel(" gpt-custom ", false)).toEqual({
      model: "gpt-custom",
      modelSource: "RALPH_MODEL",
      reasoningSource: "Codex CLI default",
    });
    expect(resolveCodexModel(" gpt-custom ", true)).toEqual({
      model: "gpt-custom",
      modelSource: "RALPH_MODEL",
      reasoningSource: "user config",
    });
  });

  it("builds isolated default args", () => {
    expect(
      buildCodexArgs({
        stage,
        promptInstruction,
        rawModel: undefined,
        codexUserConfig: false,
      })
    ).toEqual([
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ignore-user-config",
      "--model",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      promptInstruction,
    ]);
  });

  it("builds inherited-config args without model overrides", () => {
    expect(
      buildCodexArgs({
        stage,
        promptInstruction,
        rawModel: undefined,
        codexUserConfig: true,
      })
    ).toEqual([
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      promptInstruction,
    ]);
  });

  it("builds explicit-model args without a fallback effort", () => {
    expect(
      buildCodexArgs({
        stage,
        promptInstruction,
        rawModel: " gpt-custom ",
        codexUserConfig: false,
      })
    ).toEqual([
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ignore-user-config",
      "--model",
      "gpt-custom",
      promptInstruction,
    ]);
  });

  it("declares only Codex credentials and CODEX_HOME", () => {
    const adapter = getAgentAdapter("codex");
    expect(adapter.credentialMounts("/home/me")).toEqual([
      {
        hostPath: "/home/me/.codex",
        containerPath: "/home/agent/.codex",
      },
    ]);
    expect(adapter.containerEnv).toEqual({
      CODEX_HOME: "/home/agent/.codex",
    });
  });
});
```

- [ ] **Step 2: Run the new test and verify the missing-module failure**

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/agents.test.ts
```

Expected: FAIL because `../agents/index.js`, `claude.js`, and `codex.js` do not exist.

- [ ] **Step 3: Implement the provider command contract**

Create `packages/core/src/agents/types.ts`:

```ts
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
```

Create `packages/core/src/agents/claude.ts`:

```ts
import { join } from "node:path";

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
    return [
      {
        hostPath: join(home, ".claude"),
        containerPath: "/home/agent/.claude",
      },
      {
        hostPath: join(home, ".claude.json"),
        containerPath: "/home/agent/.claude.json",
      },
    ];
  },
  buildCommand: buildFromContext,
} satisfies AgentAdapter;
```

Create `packages/core/src/agents/codex.ts`:

```ts
import { join } from "node:path";

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
    return [
      {
        hostPath: join(home, ".codex"),
        containerPath: "/home/agent/.codex",
      },
    ];
  },
  buildCommand: buildCodexArgs,
} satisfies AgentAdapter;
```

Create `packages/core/src/agents/index.ts`:

```ts
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
```

- [ ] **Step 4: Run the provider tests and typecheck**

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/agents.test.ts
pnpm --filter @daonhan/ralph-core typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the provider command boundary**

```powershell
git add packages/core/src/agents packages/core/src/__tests__/agents.test.ts
git commit -m "feat(core): add agent provider adapters"
```

---

### Task 2: Stateful Claude and Codex stream decoders

**Files:**

- Modify: `packages/core/src/agents/types.ts`
- Modify: `packages/core/src/agents/claude.ts`
- Modify: `packages/core/src/agents/codex.ts`
- Create: `packages/core/src/__tests__/agent-decoders.test.ts`

**Interfaces:**

- Consumes: `AgentAdapter` from Task 1.
- Produces: `AgentRenderEvent`, `AgentDecodeResult`, `AgentStreamDecoder`.
- Produces: `createClaudeDecoder(): AgentStreamDecoder`.
- Produces: `createCodexDecoder(): AgentStreamDecoder`.
- Extends: `AgentAdapter.createDecoder()`.

- [ ] **Step 1: Write decoder contract tests**

Create `packages/core/src/__tests__/agent-decoders.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createClaudeDecoder } from "../agents/claude.js";
import { createCodexDecoder } from "../agents/codex.js";

describe("Claude stream decoder", () => {
  it("normalizes init, assistant, tool, and result records", () => {
    const decoder = createClaudeDecoder();
    expect(
      decoder.decode({
        type: "system",
        subtype: "init",
        model: "sonnet",
        cwd: "/work",
      }).events
    ).toEqual([{ type: "init", detail: "model=sonnet cwd=/work" }]);

    expect(
      decoder.decode({
        type: "assistant",
        message: {
          content: [
            { type: "thinking" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "pnpm test" },
            },
            { type: "text", text: "Done" },
          ],
        },
      }).events
    ).toEqual([
      { type: "thinking" },
      {
        type: "tool-start",
        id: "tool-1",
        name: "Bash",
        input: { command: "pnpm test" },
      },
      { type: "assistant", text: "Done" },
    ]);

    expect(
      decoder.decode({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "passed",
              is_error: false,
            },
          ],
        },
      }).events
    ).toEqual([
      {
        type: "tool-result",
        id: "tool-1",
        content: "passed",
        isError: false,
      },
    ]);

    expect(
      decoder.decode({ type: "result", result: "final", is_error: false })
    ).toEqual({ events: [], completion: "final" });
    expect(decoder.finish()).toBe("final");
  });

  it("preserves Claude's legacy empty finish result", () => {
    expect(createClaudeDecoder().finish()).toBe("");
  });
});

describe("Codex stream decoder", () => {
  it("normalizes a successful turn and returns the last agent message", () => {
    const decoder = createCodexDecoder();
    expect(
      decoder.decode({
        type: "thread.started",
        thread_id: "thread-1",
      }).events
    ).toEqual([{ type: "init", detail: "agent=codex thread=thread-1" }]);

    expect(
      decoder.decode({
        type: "item.started",
        item: {
          id: "item-1",
          type: "command_execution",
          command: "pnpm test",
        },
      }).events
    ).toEqual([
      {
        type: "tool-start",
        id: "item-1",
        name: "command",
        input: { command: "pnpm test" },
      },
    ]);

    expect(
      decoder.decode({
        type: "item.completed",
        item: {
          id: "item-1",
          type: "command_execution",
          aggregated_output: "passed",
          exit_code: 0,
          status: "completed",
        },
      }).events
    ).toEqual([
      {
        type: "tool-result",
        id: "item-1",
        name: "command",
        content: "passed",
        isError: false,
      },
    ]);

    expect(
      decoder.decode({
        type: "item.completed",
        item: {
          id: "item-2",
          type: "agent_message",
          text: "finished",
        },
      }).events
    ).toEqual([{ type: "assistant", text: "finished" }]);

    expect(decoder.decode({ type: "turn.completed" })).toEqual({
      events: [],
      completion: "finished",
    });
    expect(decoder.finish()).toBe("finished");
  });

  it.each([
    [
      "file_change",
      { changes: [{ path: "a.ts", kind: "update" }] },
      "file_change",
    ],
    [
      "mcp_tool_call",
      { server: "github", tool: "search", result: { count: 1 } },
      "github.search",
    ],
    ["web_search", { query: "Codex docs", result: ["hit"] }, "web_search"],
    ["plan", { text: "1. test" }, "plan"],
  ])("normalizes completed %s items", (type, fields, name) => {
    const decoder = createCodexDecoder();
    const decoded = decoder.decode({
      type: "item.completed",
      item: { id: "item-x", type, status: "completed", ...fields },
    });
    expect(decoded.events[0]).toMatchObject({
      type: "tool-result",
      id: "item-x",
      name,
      isError: false,
    });
  });

  it("surfaces turn failures and error records", () => {
    const decoder = createCodexDecoder();
    expect(
      decoder.decode({
        type: "turn.failed",
        error: { message: "model unavailable" },
      }).failure
    ).toBe("model unavailable");
    expect(
      decoder.decode({ type: "error", message: "auth missing" }).failure
    ).toBe("auth missing");
  });

  it("rejects completion without a final agent message", () => {
    expect(createCodexDecoder().decode({ type: "turn.completed" })).toEqual({
      events: [],
      failure: "codex turn completed without a final agent message",
    });
  });

  it("rejects a successful process finish without turn.completed", () => {
    const decoder = createCodexDecoder();
    decoder.decode({
      type: "item.completed",
      item: { type: "agent_message", text: "partial" },
    });
    expect(() => decoder.finish()).toThrow(
      "codex exited without turn.completed"
    );
  });

  it("ignores unknown additive events", () => {
    expect(
      createCodexDecoder().decode({
        type: "future.event",
        payload: { value: 1 },
      })
    ).toEqual({ events: [] });
  });
});
```

- [ ] **Step 2: Run the decoder test and verify interface failures**

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/agent-decoders.test.ts
```

Expected: FAIL because the decoder exports and stream types do not exist.

- [ ] **Step 3: Add normalized stream types to the adapter contract**

Append these types before `AgentAdapter` in `packages/core/src/agents/types.ts` and add `createDecoder` to `AgentAdapter`:

```ts
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
```

The final `AgentAdapter` declaration must be:

```ts
export interface AgentAdapter {
  readonly name: AgentName;
  readonly containerEnv: Readonly<Record<string, string>>;
  credentialMounts(home: string): AgentMount[];
  buildCommand(context: AgentCommandContext): string[];
  createDecoder(): AgentStreamDecoder;
}
```

Add `AgentDecodeResult`, `AgentRenderEvent`, and `AgentStreamDecoder` to the type exports in `packages/core/src/agents/index.ts`.

- [ ] **Step 4: Implement the Claude decoder**

Add these declarations to `packages/core/src/agents/claude.ts`:

```ts
import type {
  AgentAdapter,
  AgentCommandContext,
  AgentDecodeResult,
  AgentRenderEvent,
  AgentStreamDecoder,
} from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

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
```

Replace the imported type block rather than duplicating `AgentAdapter` and `AgentCommandContext`, then add `createDecoder: createClaudeDecoder` to `claudeAdapter`.

- [ ] **Step 5: Implement the Codex decoder**

Add these declarations to `packages/core/src/agents/codex.ts`:

```ts
import type {
  AgentAdapter,
  AgentCommandContext,
  AgentDecodeResult,
  AgentRenderEvent,
  AgentStreamDecoder,
} from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function failureMessage(
  event: Record<string, unknown>,
  fallback: string
): string {
  if (typeof event.message === "string") return event.message;
  if (typeof event.error === "string") return event.error;
  const error = record(event.error);
  return stringValue(error?.message) ?? fallback;
}

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "plan",
  "todo_list",
]);

function toolName(item: Record<string, unknown>): string {
  switch (item.type) {
    case "command_execution":
      return "command";
    case "file_change":
      return "file_change";
    case "mcp_tool_call": {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool) ?? stringValue(item.name);
      return [server, tool].filter(Boolean).join(".") || "mcp";
    }
    case "web_search":
      return "web_search";
    case "plan":
    case "todo_list":
      return "plan";
    default:
      return "tool";
  }
}

function toolInput(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case "command_execution":
      return { command: item.command };
    case "mcp_tool_call":
      return item.arguments;
    case "web_search":
      return { query: item.query };
    case "file_change":
      return item.changes;
    case "plan":
    case "todo_list":
      return item.text ?? item.items;
    default:
      return undefined;
  }
}

function toolOutput(item: Record<string, unknown>): unknown {
  return (
    item.aggregated_output ??
    item.output ??
    item.result ??
    item.error ??
    item.changes ??
    item.text ??
    item.items ??
    ""
  );
}

function toolFailed(item: Record<string, unknown>): boolean {
  return (
    item.status === "failed" ||
    (typeof item.exit_code === "number" && item.exit_code !== 0) ||
    item.error !== undefined
  );
}

export function createCodexDecoder(): AgentStreamDecoder {
  let lastAgentMessage: string | undefined;
  let turnCompleted = false;

  return {
    decode(raw): AgentDecodeResult {
      const event = record(raw);
      if (!event || typeof event.type !== "string") return { events: [] };

      if (event.type === "thread.started") {
        const thread = stringValue(event.thread_id) ?? "?";
        return {
          events: [{ type: "init", detail: `agent=codex thread=${thread}` }],
        };
      }

      if (event.type === "turn.started") {
        return {
          events: [{ type: "diagnostic", message: "turn started" }],
        };
      }

      if (event.type === "item.started" || event.type === "item.completed") {
        const item = record(event.item);
        if (!item || typeof item.type !== "string") return { events: [] };

        if (item.type === "agent_message") {
          if (
            event.type === "item.completed" &&
            typeof item.text === "string"
          ) {
            lastAgentMessage = item.text;
            return {
              events: [{ type: "assistant", text: item.text }],
            };
          }
          return { events: [] };
        }

        if (item.type === "reasoning") {
          return event.type === "item.started"
            ? { events: [{ type: "thinking" }] }
            : { events: [] };
        }

        if (!TOOL_ITEM_TYPES.has(item.type)) return { events: [] };
        const id = stringValue(item.id);
        const name = toolName(item);
        if (event.type === "item.started") {
          return {
            events: [
              {
                type: "tool-start",
                id,
                name,
                input: toolInput(item),
              },
            ],
          };
        }
        return {
          events: [
            {
              type: "tool-result",
              id,
              name,
              content: toolOutput(item),
              isError: toolFailed(item),
            },
          ],
        };
      }

      if (event.type === "turn.completed") {
        if (lastAgentMessage === undefined) {
          return {
            events: [],
            failure: "codex turn completed without a final agent message",
          };
        }
        turnCompleted = true;
        return { events: [], completion: lastAgentMessage };
      }

      if (event.type === "turn.failed") {
        return {
          events: [],
          failure: failureMessage(event, "codex turn failed"),
        };
      }

      if (event.type === "error") {
        return {
          events: [],
          failure: failureMessage(event, "codex error"),
        };
      }

      return { events: [] };
    },
    finish() {
      if (!turnCompleted) {
        throw new Error("codex exited without turn.completed");
      }
      if (lastAgentMessage === undefined) {
        throw new Error("codex turn completed without a final agent message");
      }
      return lastAgentMessage;
    },
  };
}
```

Replace the imported type block rather than duplicating `AgentAdapter` and `AgentCommandContext`, then add `createDecoder: createCodexDecoder` to `codexAdapter`.

- [ ] **Step 6: Run decoder and provider tests**

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/agents.test.ts src/__tests__/agent-decoders.test.ts
pnpm --filter @daonhan/ralph-core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit stream decoder support**

```powershell
git add packages/core/src/agents packages/core/src/__tests__/agent-decoders.test.ts
git commit -m "feat(core): decode Claude and Codex streams"
```

---

### Task 3: Wire provider adapters into the shared runner and renderer

**Files:**

- Modify: `packages/core/src/stream-render.ts:1-186`
- Modify: `packages/core/src/runner.ts:1-633`
- Modify: `packages/core/src/__tests__/runner.test.ts:1-121`
- Create: `packages/core/src/__tests__/stream-render.test.ts`
- Create: `packages/core/src/__tests__/runner-stream.test.ts`

**Interfaces:**

- Consumes: `getAgentAdapter` and `AgentStreamDecoder` from Tasks 1-2.
- Produces: `RunStageOptions = { signal?, agent?, codexUserConfig? }`.
- Produces: `resolveAgentRuntimeArgs(adapter, home): string[]`.
- Produces: `streamDocker(args, logPath, decoder, options): Promise<string>`.
- Preserves: `buildClaudeArgs` and `resolveModelArgs` exports from the `./runner` package subpath.

- [ ] **Step 1: Write normalized renderer tests**

Create `packages/core/src/__tests__/stream-render.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderEvent, type ToolTrack } from "../stream-render.js";

describe("renderEvent", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let tools: Map<string, ToolTrack>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    tools = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the Claude init detail format", () => {
    renderEvent({ type: "init", detail: "model=sonnet cwd=/work" }, tools);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("init model=sonnet cwd=/work")
    );
  });

  it("writes assistant text only to stdout", () => {
    renderEvent({ type: "assistant", text: "line one\nline two" }, tools);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("line one\r\n  line two")
    );
    expect(stderr).not.toHaveBeenCalled();
  });

  it("pairs tool starts and results", () => {
    renderEvent(
      {
        type: "tool-start",
        id: "tool-1",
        name: "command",
        input: { command: "pnpm test" },
      },
      tools
    );
    renderEvent(
      {
        type: "tool-result",
        id: "tool-1",
        content: "passed",
        isError: false,
      },
      tools
    );
    expect(tools.size).toBe(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("command"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("passed"));
  });

  it("renders provider failures as errors", () => {
    renderEvent(
      { type: "diagnostic", message: "auth missing", isError: true },
      tools
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("auth missing")
    );
  });
});
```

- [ ] **Step 2: Write runner stream and mount tests**

Add these imports to `packages/core/src/__tests__/runner.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentAdapter } from "../agents/index.js";
import {
  buildClaudeArgs,
  parseGraceMs,
  resolveAgentRuntimeArgs,
  resolveModelArgs,
} from "../runner.js";
```

Replace the existing runner import with the block above, then append:

```ts
describe("resolveAgentRuntimeArgs", () => {
  it("mounts only the selected provider plus shared GitHub config", () => {
    const home = mkdtempSync(join(tmpdir(), "ralph-agent-home-"));
    try {
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".claude.json"), "{}", "utf8");
      mkdirSync(join(home, ".codex"));
      mkdirSync(join(home, ".config", "gh"), { recursive: true });

      const claudeArgs = resolveAgentRuntimeArgs(
        getAgentAdapter("claude"),
        home
      );
      expect(claudeArgs.join(" ")).toContain(".claude");
      expect(claudeArgs.join(" ")).not.toContain(".codex");

      const codexArgs = resolveAgentRuntimeArgs(getAgentAdapter("codex"), home);
      expect(codexArgs.join(" ")).toContain("/home/agent/.codex");
      expect(codexArgs.join(" ")).not.toContain(".claude");
      expect(codexArgs).toContain("CODEX_HOME=/home/agent/.codex");
      expect(codexArgs.join(" ")).toContain("/home/agent/.config/gh:ro");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

Create `packages/core/src/__tests__/runner-stream.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return { ...actual, spawn: spawnMock };
});

import { createCodexDecoder } from "../agents/codex.js";
import { streamDocker } from "../runner.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

function writeJson(child: FakeChild, value: unknown): void {
  child.stdout.write(JSON.stringify(value) + "\n");
}

describe("streamDocker", () => {
  let root: string;
  let child: FakeChild;
  let originalGrace: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ralph-stream-"));
    child = fakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child as never);
    originalGrace = process.env.RALPH_RESULT_GRACE_MS;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalGrace === undefined) {
      delete process.env.RALPH_RESULT_GRACE_MS;
    } else {
      process.env.RALPH_RESULT_GRACE_MS = originalGrace;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the Codex final message and preserves raw JSONL", async () => {
    const logPath = join(root, "stage.ndjson");
    const run = streamDocker([], logPath, createCodexDecoder());
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "finished" },
    });
    writeJson(child, { type: "turn.completed" });
    child.emit("close", 0);

    await expect(run).resolves.toBe("finished");
    expect(readFileSync(logPath, "utf8")).toContain('"turn.completed"');
  });

  it("kills and rejects on a provider failure event", async () => {
    const run = streamDocker(
      [],
      join(root, "failure.ndjson"),
      createCodexDecoder()
    );
    writeJson(child, { type: "error", message: "auth missing" });

    await expect(run).rejects.toThrow("auth missing");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects exit zero when the Codex terminal record is absent", async () => {
    const run = streamDocker(
      [],
      join(root, "incomplete.ndjson"),
      createCodexDecoder()
    );
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "partial" },
    });
    child.emit("close", 0);

    await expect(run).rejects.toThrow("codex exited without turn.completed");
  });

  it("applies the existing grace timer to Codex completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    process.env.RALPH_RESULT_GRACE_MS = "10";
    const run = streamDocker(
      [],
      join(root, "grace.ndjson"),
      createCodexDecoder()
    );
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "finished" },
    });
    writeJson(child, { type: "turn.completed" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10);

    await expect(run).resolves.toBe("finished");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the runner/renderer tests and verify failures**

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/runner.test.ts src/__tests__/stream-render.test.ts src/__tests__/runner-stream.test.ts
```

Expected: FAIL because normalized rendering, runtime mount resolution, decoder-aware
`streamDocker`, and its export are not implemented.

- [ ] **Step 4: Convert the renderer to normalized events**

At the top of `packages/core/src/stream-render.ts`, import the event type:

```ts
import type { AgentRenderEvent } from "./agents/types.js";
```

Delete `AssistantBlock`, `UserBlock`, and `StreamJson`. Keep `ToolTrack` and
replace `renderEvent` with:

```ts
export function renderEvent(
  ev: AgentRenderEvent,
  toolMap: Map<string, ToolTrack>
): void {
  switch (ev.type) {
    case "init":
      process.stderr.write(`${dim("───")} ${bold("init")} ${dim(ev.detail)}\n`);
      return;
    case "assistant": {
      const lines = ev.text.split("\n");
      const formatted = lines
        .map((line, index) =>
          index === 0
            ? `${boldOut(cyanOut(SYM_OUT.bullet))} ${line}`
            : `  ${line}`
        )
        .join("\r\n");
      process.stdout.write(formatted + "\r\n\n");
      return;
    }
    case "thinking":
      process.stderr.write(`${dim(SYM.bullet + " thinking" + SYM.ellip)}\n`);
      return;
    case "tool-start": {
      if (ev.id) {
        toolMap.set(ev.id, { name: ev.name, startedAt: Date.now() });
      }
      process.stderr.write(
        `${cyan(SYM.bullet)} ${bold(ev.name)} ${dim(
          previewInput(ev.name, ev.input)
        )}\n`
      );
      return;
    }
    case "tool-result": {
      const text = stringifyToolResult(ev.content);
      const tracked = ev.id ? toolMap.get(ev.id) : undefined;
      const toolName = tracked?.name ?? ev.name ?? "tool";
      const elapsed = tracked ? ` (${Date.now() - tracked.startedAt}ms)` : "";
      if (ev.id) toolMap.delete(ev.id);
      if (ev.isError) {
        const snippet = text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, TOOL_ERROR_PREVIEW);
        process.stderr.write(
          `${dim(SYM.cont)} ${red(SYM.cross)} ${bold(toolName)}${red(
            " failed"
          )}\n  ${red(snippet)}${
            text.length > snippet.length ? " " + SYM.ellip : ""
          }\n`
        );
      } else {
        const snippet = text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, TOOL_RESULT_PREVIEW);
        process.stderr.write(
          `${dim(SYM.cont)} ${green(SYM.check)} ${bold(toolName)}${dim(
            elapsed
          )} ${dim(snippet)}${
            text.length > snippet.length ? " " + SYM.ellip : ""
          }\n`
        );
      }
      return;
    }
    case "diagnostic":
      process.stderr.write(
        ev.isError
          ? `${red(SYM.bullet + " " + ev.message)}\n`
          : `${dim(SYM.bullet + " " + ev.message)}\n`
      );
  }
}
```

Add a lowercase command preview key while preserving all existing keys:

```ts
const keyOrder: Record<string, string[]> = {
  Bash: ["command"],
  command: ["command"],
  Edit: ["file_path"],
  Write: ["file_path"],
  Read: ["file_path"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path"],
  TodoWrite: [],
};
```

- [ ] **Step 5: Make runner mount and invoke the selected adapter**

In `packages/core/src/runner.ts`:

1. Remove the direct `Stage` import only if no other type use remains.
2. Remove the local `resolveModelArgs` and `buildClaudeArgs` implementations.
3. Add these imports/re-exports:

```ts
import {
  getAgentAdapter,
  type AgentAdapter,
  type AgentName,
  type AgentStreamDecoder,
} from "./agents/index.js";
import type { Stage } from "./stages.js";
import {
  bold,
  dim,
  red,
  renderEvent,
  SYM,
  type ToolTrack,
} from "./stream-render.js";

export { buildClaudeArgs, resolveModelArgs } from "./agents/claude.js";
```

Set `RunStageOptions` to:

```ts
export type RunStageOptions = {
  signal?: AbortSignal;
  agent?: AgentName;
  codexUserConfig?: boolean;
};
```

Add this helper before `runStage`:

```ts
export function resolveAgentRuntimeArgs(
  adapter: AgentAdapter,
  home: string
): string[] {
  const args: string[] = [];
  if (home) {
    for (const mount of adapter.credentialMounts(home)) {
      if (!existsSync(mount.hostPath)) continue;
      const spec = `${mount.hostPath}:${mount.containerPath}${
        mount.readOnly ? ":ro" : ""
      }`;
      args.push("-v", spec);
    }
    const ghConfigDir = join(home, ".config", "gh");
    if (existsSync(ghConfigDir)) {
      args.push("-v", `${ghConfigDir}:/home/agent/.config/gh:ro`);
    }
  }
  for (const [name, value] of Object.entries(adapter.containerEnv)) {
    args.push("-e", `${name}=${value}`);
  }
  return args;
}
```

At the start of `runStage`, resolve the provider:

```ts
const adapter = getAgentAdapter(options.agent ?? "claude");
```

Replace the existing Claude/GitHub mount block with:

```ts
const home = process.env.HOME || process.env.USERPROFILE || "";
args.push(...resolveAgentRuntimeArgs(adapter, home));
```

Replace the current image/Claude argv append and stream call with:

```ts
const promptInstruction = `Read the full instructions from the file ./${promptContainerPath} in the current workspace and execute them.`;
args.push(
  IMAGE_REF,
  ...adapter.buildCommand({
    stage,
    promptInstruction,
    rawModel: process.env.RALPH_MODEL,
    codexUserConfig: options.codexUserConfig ?? false,
  })
);

return await streamDocker(args, logPath, adapter.createDecoder(), options);
```

- [ ] **Step 6: Generalize streamDocker around decoder outcomes**

Change the signature to:

```ts
export function streamDocker(
  args: string[],
  logPath: string,
  decoder: AgentStreamDecoder,
  options: RunStageOptions = {}
): Promise<string> {
```

Keep the process/cleanup scaffolding. Replace the stdout line handler with:

```ts
rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (settled || !line.startsWith("{")) return;
  appendFileSync(logFd, line + "\n");

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  const decoded = decoder.decode(parsed);
  for (const event of decoded.events) {
    renderEvent(event, toolMap);
  }

  if (decoded.failure) {
    try {
      child.kill();
    } catch {
      // Child already exited; rejectOnce remains authoritative.
    }
    rejectOnce(new Error(decoded.failure));
    return;
  }

  if (decoded.completion !== undefined) {
    finalResult = decoded.completion;
    if (!graceTimer && graceMs > 0) {
      graceTimer = setTimeout(() => {
        if (settled) return;
        process.stderr.write(
          `${dim(
            `grace timer fired after ${graceMs}ms post-completion — killing docker child`
          )}\n`
        );
        try {
          child.kill();
        } catch {
          // Child already exited; resolveOnce remains authoritative.
        }
        resolveOnce(finalResult);
      }, graceMs);
      graceTimer.unref?.();
    }
  }
});
```

Replace the successful branch of the child close handler with:

```ts
try {
  resolveOnce(decoder.finish());
} catch (error) {
  rejectOnce(error);
}
```

Do not change non-zero exit, abort, stderr-tail, file cleanup, or timer cleanup
behavior.

- [ ] **Step 7: Run all core tests and typecheck**

Run:

```powershell
pnpm --filter @daonhan/ralph-core test
pnpm --filter @daonhan/ralph-core typecheck
```

Expected: PASS, including unchanged `buildClaudeArgs` imports through
`../runner.js`.

- [ ] **Step 8: Commit shared runner integration**

```powershell
git add packages/core/src/runner.ts packages/core/src/stream-render.ts packages/core/src/__tests__/runner.test.ts packages/core/src/__tests__/stream-render.test.ts packages/core/src/__tests__/runner-stream.test.ts
git commit -m "feat(core): run stages through agent adapters"
```

---

### Task 4: CLI selection, validation, config reporting, and loop forwarding

**Files:**

- Modify: `packages/core/src/cli-help.ts:1-237`
- Modify: `packages/core/src/run-bin.ts:1-112`
- Modify: `packages/core/src/loop.ts:26-152`
- Modify: `packages/core/src/main.ts:1-19`
- Modify: `packages/core/src/gh-main.ts:1-19`
- Modify: `packages/core/src/index.ts:1-8`
- Modify: `packages/core/src/__tests__/loop.test.ts`
- Modify: `packages/core/src/__tests__/detach.test.ts`
- Create: `packages/core/src/__tests__/cli-help.test.ts`
- Create: `packages/core/src/__tests__/run-bin.test.ts`

**Interfaces:**

- Consumes: `AgentName`, `AgentSelectionSource`, `parseAgentName`, `resolveAgentSelection`.
- Produces: `CliFlags.agent?: AgentName` and `CliFlags.codexUserConfig: boolean`.
- Produces: `describeAgentConfig(agent, codexUserConfig, rawModel)`.
- Extends: `LoopOptions.agent?` and `LoopOptions.codexUserConfig?`.
- Preserves: both existing bin names and positional input shapes.

- [ ] **Step 1: Write CLI parser and display tests**

Create `packages/core/src/__tests__/cli-help.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeAgentConfig, parseFlags, printHelp } from "../cli-help.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseFlags agent options", () => {
  it("parses Codex selection and user config", () => {
    expect(
      parseFlags(["--agent", "codex", "--codex-user-config", "plan", "2"])
    ).toMatchObject({
      agent: "codex",
      codexUserConfig: true,
      rest: ["plan", "2"],
    });
  });

  it("rejects a missing agent value", () => {
    expect(() => parseFlags(["--agent"])).toThrow("--agent requires a value");
    expect(() => parseFlags(["--agent", "--notify"])).toThrow(
      "--agent requires a value"
    );
  });

  it("rejects an unsupported agent", () => {
    expect(() => parseFlags(["--agent", "gemini"])).toThrow(
      'Unsupported agent "gemini"; expected "claude" or "codex"'
    );
  });
});

describe("describeAgentConfig", () => {
  it("describes the unchanged Claude default", () => {
    expect(describeAgentConfig("claude", false, undefined)).toEqual({
      model: "sandbox CLI default (RALPH_MODEL unset)",
    });
  });

  it("describes isolated Codex defaults", () => {
    expect(describeAgentConfig("codex", false, undefined)).toEqual({
      codexConfig: "isolated (--ignore-user-config)",
      model: "gpt-5.6-sol (Ralph default)",
      reasoning: "high (Ralph default)",
    });
  });

  it("describes inherited Codex config", () => {
    expect(describeAgentConfig("codex", true, undefined)).toEqual({
      codexConfig: "inherited (~/.codex/config.toml)",
      model: "user config (RALPH_MODEL unset)",
      reasoning: "user config",
    });
  });

  it("describes an explicit Codex model", () => {
    expect(describeAgentConfig("codex", false, " gpt-custom ")).toEqual({
      codexConfig: "isolated (--ignore-user-config)",
      model: "gpt-custom (RALPH_MODEL)",
      reasoning: "Codex CLI default",
    });
  });
});

it("documents both new flags and RALPH_AGENT", () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  printHelp("ralph-afk", "<plan> <iterations>", "test loop");
  const output = write.mock.calls.map((call) => String(call[0])).join("");
  expect(output).toContain("--agent <claude|codex>");
  expect(output).toContain("--codex-user-config");
  expect(output).toContain("RALPH_AGENT");
  expect(output).toContain("gpt-5.6-sol");
});
```

- [ ] **Step 2: Write runBin forwarding tests**

Create `packages/core/src/__tests__/run-bin.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const runLoopMock = vi.hoisted(() => vi.fn());

vi.mock("../loop.js", () => ({
  runLoop: runLoopMock,
}));

import { runBin, type RunBinConfig } from "../run-bin.js";

const stage = { name: "implementer", template: "afk.md" };

function config(takesInputArg: boolean): RunBinConfig {
  return {
    bin: takesInputArg ? "ralph-afk" : "ralph-ghafk",
    usage: takesInputArg ? "<plan-and-prd> <iterations>" : "<iterations>",
    desc: "test",
    stages: [stage],
    takesInputArg,
  };
}

afterEach(() => {
  runLoopMock.mockReset();
  delete process.env.RALPH_AGENT;
});

describe("runBin agent forwarding", () => {
  it("forwards explicit Codex settings for ralph-afk", async () => {
    await runBin(
      ["--agent", "codex", "--codex-user-config", "plan.md", "2"],
      config(true)
    );
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        codexUserConfig: true,
        inputs: "plan.md",
        iterations: 2,
      })
    );
  });

  it("forwards RALPH_AGENT for ralph-ghafk", async () => {
    process.env.RALPH_AGENT = "codex";
    await runBin(["2"], config(false));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        codexUserConfig: false,
        inputs: "",
        iterations: 2,
      })
    );
  });

  it("keeps Claude as the default", async () => {
    await runBin(["plan.md", "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude",
        codexUserConfig: false,
      })
    );
  });

  it("rejects Codex user config with Claude", async () => {
    await expect(
      runBin(["--codex-user-config", "plan.md", "1"], config(true))
    ).rejects.toThrow(
      "--codex-user-config requires Codex; select it with --agent codex or RALPH_AGENT=codex"
    );
    expect(runLoopMock).not.toHaveBeenCalled();
  });
});
```

Append this test to `packages/core/src/__tests__/loop.test.ts`:

```ts
it("forwards provider settings to every stage", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);
  mocks.runStage.mockResolvedValue(sentinel);

  await runLoop(
    loopOptions(dirs, {
      agent: "codex",
      codexUserConfig: true,
    })
  );

  expect(mocks.runStage).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(String),
    dirs.workspaceDir,
    1,
    expect.any(String),
    expect.any(String),
    expect.objectContaining({
      agent: "codex",
      codexUserConfig: true,
      signal: expect.any(AbortSignal),
    })
  );
});
```

Append this direct-library validation test to the same file:

```ts
it("rejects Codex user config with Claude before image setup", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);

  await expect(
    runLoop(
      loopOptions(dirs, {
        agent: "claude",
        codexUserConfig: true,
      })
    )
  ).rejects.toThrow("codexUserConfig requires agent=codex");
  expect(mocks.ensureImage).not.toHaveBeenCalled();
  expect(mocks.runStage).not.toHaveBeenCalled();
});
```

Append this detach regression test to
`packages/core/src/__tests__/detach.test.ts`:

```ts
it("preserves provider flags in the detached child argv", () => {
  expect(
    stripDetachFlags([
      "--detach",
      "--agent",
      "codex",
      "--codex-user-config",
      "plan.md",
      "3",
    ])
  ).toEqual(["--agent", "codex", "--codex-user-config", "plan.md", "3"]);
});
```

- [ ] **Step 3: Run the new CLI tests and verify failures**

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/cli-help.test.ts src/__tests__/run-bin.test.ts src/__tests__/loop.test.ts
```

Expected: FAIL because parser fields, config descriptions, validation, and
loop forwarding are absent.

- [ ] **Step 4: Extend parseFlags and add pure config descriptions**

In `packages/core/src/cli-help.ts` import:

```ts
import {
  parseAgentName,
  type AgentName,
  type AgentSelectionSource,
} from "./agents/index.js";
import { resolveCodexModel } from "./agents/codex.js";
```

Add to `CliFlags`:

```ts
agent?: AgentName;
codexUserConfig: boolean;
```

In `parseFlags` add `agent`, `expectingAgent`, and `codexUserConfig` state. At
the top of the argv loop, before the other expecting-value branches, add:

```ts
if (expectingAgent) {
  if (a.startsWith("-")) throw new Error("--agent requires a value");
  agent = parseAgentName(a);
  expectingAgent = false;
  continue;
}
```

Add these flag branches:

```ts
else if (a === "--agent") expectingAgent = true;
else if (a === "--codex-user-config") codexUserConfig = true;
```

After the loop add:

```ts
if (expectingAgent) {
  throw new Error("--agent requires a value");
}
```

Return `agent` and `codexUserConfig` with the existing fields.

Add this pure display helper above `PrintConfigOptions`:

```ts
export type AgentConfigDescription = {
  codexConfig?: string;
  model: string;
  reasoning?: string;
};

export function describeAgentConfig(
  agent: AgentName,
  codexUserConfig: boolean,
  rawModel: string | undefined
): AgentConfigDescription {
  const explicit = rawModel?.trim();
  if (agent === "claude") {
    return {
      model: explicit
        ? `${explicit} (RALPH_MODEL)`
        : "sandbox CLI default (RALPH_MODEL unset)",
    };
  }

  const resolution = resolveCodexModel(rawModel, codexUserConfig);
  return {
    codexConfig: codexUserConfig
      ? "inherited (~/.codex/config.toml)"
      : "isolated (--ignore-user-config)",
    model: resolution.model
      ? `${resolution.model} (${resolution.modelSource})`
      : "user config (RALPH_MODEL unset)",
    reasoning: resolution.reasoningEffort
      ? `${resolution.reasoningEffort} (${resolution.reasoningSource})`
      : resolution.reasoningSource,
  };
}
```

Extend `PrintConfigOptions` with:

```ts
agent?: AgentName;
agentSource?: AgentSelectionSource;
codexUserConfig?: boolean;
```

Default them to `"claude"`, `"default"`, and `false` in `printConfig`. Replace
the existing raw-model calculation with:

```ts
const provider = describeAgentConfig(
  agent,
  codexUserConfig,
  process.env.RALPH_MODEL
);
const providerLines = [
  `  agent                 ${agent} (${agentSource})`,
  ...(provider.codexConfig
    ? [`  codex config          ${provider.codexConfig}`]
    : []),
  `  model                 ${provider.model}`,
  ...(provider.reasoning
    ? [`  reasoning             ${provider.reasoning}`]
    : []),
].join("\n");
```

Insert `${providerLines}` after the package directory line and remove the old
single model output line.

Add these exact help entries:

```text
  --agent <claude|codex> select the in-container coding agent (default: claude; overrides RALPH_AGENT)
  --codex-user-config    load ~/.codex/config.toml for Codex (default: isolated; requires Codex)

  RALPH_AGENT           fallback agent selection when --agent is absent
  RALPH_MODEL           model override for the selected agent. Claude passes it
                        through. Isolated Codex defaults to gpt-5.6-sol with high
                        reasoning when this variable is unset.
```

- [ ] **Step 5: Resolve selection in runBin and forward through runLoop**

In `packages/core/src/run-bin.ts` import:

```ts
import { resolveAgentSelection } from "./agents/index.js";
```

After the help/version early returns, add:

```ts
const selection = resolveAgentSelection(flags.agent, process.env.RALPH_AGENT);
if (flags.codexUserConfig && selection.agent !== "codex") {
  throw new Error(
    "--codex-user-config requires Codex; select it with --agent codex or RALPH_AGENT=codex"
  );
}
```

Pass these fields to `printConfig`:

```ts
agent: selection.agent,
agentSource: selection.source,
codexUserConfig: flags.codexUserConfig,
```

Pass these fields to `runLoop`:

```ts
agent: selection.agent,
codexUserConfig: flags.codexUserConfig,
```

In `packages/core/src/loop.ts` import `AgentName`, add optional `agent` and
`codexUserConfig` to `LoopOptions`, default them in the options destructure,
then validate the direct library contract before printing the banner or
acquiring the wake lock:

```ts
if (codexUserConfig && agent !== "codex") {
  throw new Error("codexUserConfig requires agent=codex");
}
```

Replace the final `runStage` call with:

```ts
return runStage(stage, prompt, workspaceDir, i, spillHostDir, stageLog, {
  signal: stageAbort.signal,
  agent,
  codexUserConfig,
});
```

In `packages/core/src/main.ts` use:

```ts
desc: "plan/PRD-driven coding-agent AFK loop",
```

In `packages/core/src/gh-main.ts` use:

```ts
desc: "GitHub-issue-driven coding-agent AFK loop",
```

In `packages/core/src/index.ts` export:

```ts
export type {
  AgentName,
  AgentSelection,
  AgentSelectionSource,
} from "./agents/index.js";
```

- [ ] **Step 6: Run CLI, loop, and full core verification**

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/cli-help.test.ts src/__tests__/run-bin.test.ts src/__tests__/loop.test.ts src/__tests__/detach.test.ts
pnpm --filter @daonhan/ralph-core test
pnpm --filter @daonhan/ralph-core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit selectable-provider CLI support**

```powershell
git add packages/core/src/cli-help.ts packages/core/src/run-bin.ts packages/core/src/loop.ts packages/core/src/main.ts packages/core/src/gh-main.ts packages/core/src/index.ts packages/core/src/__tests__/cli-help.test.ts packages/core/src/__tests__/run-bin.test.ts packages/core/src/__tests__/loop.test.ts packages/core/src/__tests__/detach.test.ts
git commit -m "feat(cli): select Claude or Codex"
```

---

### Task 5: Install and smoke-test the pinned Codex CLI in the sandbox

**Files:**

- Modify: `packages/core/templates/Dockerfile:1-60`
- Modify: `scripts/smoke-image.mjs:1-173`
- Modify: `scripts/smoke-image.test.mjs:1-409`

**Interfaces:**

- Consumes: Codex command flags required by the adapter.
- Produces: sandbox binary `codex-cli 0.144.4`.
- Produces: image contracts for `codex --version` and `codex exec --help`.
- Preserves: image user `agent`, `ENTRYPOINT []`, and `CMD ["claude"]`.

- [ ] **Step 1: Add failing image-contract tests**

At the top of `scripts/smoke-image.test.mjs` add:

```js
const DOCKERFILE = readFileSync(
  new URL("../packages/core/templates/Dockerfile", import.meta.url),
  "utf8"
);
const CODEX_HELP = [
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--model",
  "--dangerously-bypass-approvals-and-sandbox",
].join("\n");
```

Replace `successfulResult` with:

```js
function successfulResult(args) {
  const entrypoint = args[args.indexOf("--entrypoint") + 1];
  let stdout = "";
  if (entrypoint === "id") stdout = "agent\n";
  else if (entrypoint === "codex") {
    stdout = args.includes("exec") ? CODEX_HELP + "\n" : "codex-cli 0.144.4\n";
  } else if (entrypoint === "python" || entrypoint === "python3") {
    stdout = "Python 3.11.2\n";
  } else if (entrypoint === "uv") {
    stdout = "uv 0.11.28 (x86_64-unknown-linux-musl)\n";
  } else if (entrypoint === "uvx") {
    stdout = "uvx 0.11.28 (x86_64-unknown-linux-musl)\n";
  }
  return { status: 0, stdout, stderr: "" };
}
```

Add:

```js
test("Dockerfile pins the verified Codex CLI version", () => {
  assert.match(DOCKERFILE, /ARG CODEX_VERSION=0\.144\.4/);
  assert.match(
    DOCKERFILE,
    /npm install --global "@openai\/codex@\${CODEX_VERSION}"/
  );
});
```

Replace the prebuilt-contract count test with:

```js
test("prebuilt mode runs every sandbox image contract", () => {
  const { calls } = executeSmoke(PREBUILT_ARGS);

  assert.deepEqual(calls.slice(0, 5), [
    ["docker", ["run", "--rm", "--entrypoint", "id", "sandbox:test", "-un"]],
    [
      "docker",
      ["run", "--rm", "--entrypoint", "codex", "sandbox:test", "--version"],
    ],
    [
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "codex",
        "sandbox:test",
        "exec",
        "--help",
      ],
    ],
    [
      "docker",
      ["run", "--rm", "--entrypoint", "python", "sandbox:test", "--version"],
    ],
    [
      "docker",
      ["run", "--rm", "--entrypoint", "python3", "sandbox:test", "--version"],
    ],
  ]);
  assert.equal(calls.length, 10);
  assert.match(calls[5][1].at(-1), /python -m venv/);
  assert.match(calls[6][1].at(-1), /bin\/python" -m pip --version/);
  assert.deepEqual(calls[7], [
    "docker",
    ["run", "--rm", "--entrypoint", "uv", "sandbox:test", "--version"],
  ]);
  assert.deepEqual(calls[8], [
    "docker",
    ["run", "--rm", "--entrypoint", "uvx", "sandbox:test", "--version"],
  ]);
  assert.match(calls[9][1].at(-1), /uv pip install/);
  assert.match(calls[9][1].at(-1), /six==1\.17\.0/);
});
```

Add these two labels at the start of the existing broken-contract label list,
immediately after the default-user label:

```js
"Codex CLI version is pinned",
"Codex exec exposes Ralph automation flags",
```

Replace the skip-network test with:

```js
test("reports when the network package-install check is skipped", () => {
  const { calls, logs } = executeSmoke([...PREBUILT_ARGS, "--skip-network"]);

  assert.equal(calls.length, 9);
  assert.deepEqual(calls.at(-1), [
    "docker",
    ["run", "--rm", "--entrypoint", "uvx", "sandbox:test", "--version"],
  ]);
  assert.match(logs.at(-1), /SKIP.*network package-install check/);
});
```

- [ ] **Step 2: Run the root image tests and verify failure**

Run:

```powershell
node --test scripts/smoke-image.test.mjs
```

Expected: FAIL because the Dockerfile and runtime check list do not contain
Codex.

- [ ] **Step 3: Install the pinned Codex package**

In `packages/core/templates/Dockerfile`, immediately after `RUN corepack enable`
and before renaming/switching to the `agent` user, add:

```dockerfile
ARG CODEX_VERSION=0.144.4
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
  && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}"
```

Change the final comment to:

```dockerfile
# Reset ENTRYPOINT so the orchestrator can pass a full provider command.
```

Keep:

```dockerfile
ENTRYPOINT []
CMD ["claude"]
```

- [ ] **Step 4: Add Codex checks to runImageSmoke**

In `scripts/smoke-image.mjs`, insert these checks immediately after the default
user check:

```js
{
  label: "Codex CLI version is pinned",
  entrypoint: "codex",
  args: ["--version"],
  validateOutput(output) {
    return output.trim() === "codex-cli 0.144.4"
      ? null
      : `got ${output.trim() || "(empty)"}`;
  },
},
{
  label: "Codex exec exposes Ralph automation flags",
  entrypoint: "codex",
  args: ["exec", "--help"],
  validateOutput(output) {
    const required = [
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--model",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    const missing = required.filter((flag) => !output.includes(flag));
    return missing.length === 0
      ? null
      : `missing ${missing.join(", ")}`;
  },
},
```

Change the terminal success message to:

```js
console.log(`All sandbox image contracts passed for ${options.image}.`);
```

- [ ] **Step 5: Run root tests, build the image, and run its contracts**

Run:

```powershell
node --test scripts/smoke-image.test.mjs
docker build --tag ralph-sandbox:codex-provider --file packages/core/templates/Dockerfile .
pnpm smoke:image -- --image ralph-sandbox:codex-provider --skip-network
```

Expected: all tests and offline image contracts PASS. The smoke output includes:

```text
ok  Codex CLI version is pinned
ok  Codex exec exposes Ralph automation flags
```

- [ ] **Step 6: Commit the image contract**

```powershell
git add packages/core/templates/Dockerfile scripts/smoke-image.mjs scripts/smoke-image.test.mjs
git commit -m "feat(sandbox): install Codex CLI"
```

---

### Task 6: Normalize the shared playbook and document the provider contract

**Files:**

- Create: `packages/core/src/__tests__/template-contract.test.ts`
- Modify: `packages/core/templates/review.md:31-35`
- Modify: `packages/core/package.json:1-25`
- Modify: `apps/cli/package.json:1-25`
- Modify: `README.md`
- Modify: `QUICKSTART.md`
- Modify: `packages/core/README.md`
- Modify: `apps/cli/README.md`
- Modify: `SECURITY.md:18-47`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ralph-stack.svg`
- Modify: `docs/ralph-stack.png`

**Interfaces:**

- Consumes: final CLI, model, auth, runtime, and stream behavior.
- Produces: one provider-neutral reviewer playbook.
- Produces: copy-pastable setup for file-backed `codex login`.
- Produces: security disclosure for selected-provider credentials and bypass modes.

- [ ] **Step 1: Add the shared-template regression test**

Create `packages/core/src/__tests__/template-contract.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

it("the shared reviewer checks both provider convention files", () => {
  const review = readFileSync(
    new URL("../../templates/review.md", import.meta.url),
    "utf8"
  );
  expect(review).toContain("AGENTS.md");
  expect(review).toContain("CLAUDE.md");
  expect(review).not.toContain(
    "Style violations vs `CLAUDE.md` or project conventions"
  );
});
```

- [ ] **Step 2: Run the template test and verify failure**

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/template-contract.test.ts
```

Expected: FAIL because `review.md` names only `CLAUDE.md`.

- [ ] **Step 3: Normalize the shared reviewer rule**

In `packages/core/templates/review.md` replace check 3 with:

```markdown
3. Style violations vs `AGENTS.md`, `CLAUDE.md`, or project conventions
```

Run:

```powershell
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/template-contract.test.ts
pnpm -r build
node scripts/smoke-templates.mjs
```

Expected: PASS.

- [ ] **Step 4: Update package metadata**

Set `packages/core/package.json` description to:

```json
"description": "Claude Code and Codex AFK orchestration: iteration loop, Docker runner, template renderer.",
```

Add `"codex"` and `"openai"` after `"claude"` in its keywords.

Set `apps/cli/package.json` description to:

```json
"description": "CLI for Ralph's Claude Code and Codex AFK loops (ralph-afk, ralph-ghafk).",
```

Add `"codex"` and `"openai"` after `"claude"` in its keywords. Do not change
package versions, exports, bins, dependencies, or changelogs.

- [ ] **Step 5: Add the exact user-facing provider contract**

Use this title and opening in `README.md`:

```markdown
# Ralph — Autonomous Coding-Agent Loop

Ralph drives Claude Code by default, or Codex when selected with
`--agent codex`, against a target repository in an iterating implementer →
reviewer pipeline isolated inside a custom Docker image.
```

Add this section before the first-run credential instructions:

````markdown
## Choose the coding agent

Claude remains the default:

```bash
ralph-afk "./docs/plans/x.md ./docs/prd/x.md" 5
```

Select Codex per invocation:

```bash
ralph-afk --agent codex "./docs/plans/x.md ./docs/prd/x.md" 5
ralph-ghafk --agent codex 5
```

For automation, `RALPH_AGENT=codex` is the fallback when `--agent` is absent.
The explicit flag always wins.

Codex ignores `~/.codex/config.toml` by default while still reusing its login.
Pass `--codex-user-config` to load that configuration intentionally. This may
start configured MCP servers and hooks, so their commands and paths must work
inside the Linux sandbox.

`RALPH_MODEL` applies to the selected agent. Isolated Codex defaults to
`gpt-5.6-sol` with high reasoning when `RALPH_MODEL` is unset. In inherited
configuration mode, an unset model and reasoning effort come from
`~/.codex/config.toml`. An explicit invalid model fails; Ralph never reruns the
stage with another model.
````

Add this Codex login subsection next to the Claude first-run commands in both
`README.md` and `QUICKSTART.md`:

````markdown
### Codex login

Codex credentials must be file-backed because a host OS keyring is not
available inside Docker. In `~/.codex/config.toml`, set:

```toml
cli_auth_credentials_store = "file"
```

Then authenticate from the same PowerShell, WSL, Linux, or macOS shell context
that will launch Ralph:

```bash
codex login
codex login status
```

Ralph mounts `~/.codex` read-write at `/home/agent/.codex` so Codex can refresh
the login. It runs with `--ephemeral`, so stage session transcripts are not
persisted there.
````

Update the README environment table with:

```markdown
| `RALPH_AGENT` | `claude` | Agent fallback when `--agent` is absent: `claude` or `codex`. |
| `RALPH_MODEL` | selected CLI default; isolated Codex uses `gpt-5.6-sol`/high | Pass-through model override for the selected agent. |
```

Update `packages/core/README.md` and `apps/cli/README.md` with the same default
and opt-in examples, plus links to the root login and security sections.

- [ ] **Step 6: Update security and maintainer architecture**

Replace the opening threat-model paragraph in `SECURITY.md` with:

```markdown
Ralph is an **autonomous agent harness**. By design it runs the selected coding
agent without interactive approval inside the sandbox container:

- Claude uses `--permission-mode bypassPermissions`.
- Codex uses `--dangerously-bypass-approvals-and-sandbox`.

Treat everything Ralph ingests as instructions the selected agent may execute.
```

Replace the credential bullet with:

```markdown
- **Selected-provider host credentials are bind-mounted read-write.** Claude
  mounts `~/.claude` and `~/.claude.json`; Codex mounts `~/.codex`. The agent
  can read or overwrite the selected provider's reusable credentials.
  `~/.config/gh` is mounted read-only. Isolated Codex configuration prevents
  personal config, MCP, and hook loading; it does not conceal `auth.json` from
  the process.
```

In `docs/ARCHITECTURE.md`:

- Change the overview from a Claude-only harness to a selectable Claude/Codex
  harness.
- Add `agents/{types,claude,codex,index}.ts` to the module map.
- Show both provider argv shapes from the approved spec.
- Document selected-only credentials and `CODEX_HOME`.
- Describe normalized events and the Codex terminal contract.
- Rename post-result prose to post-completion while keeping
  `RALPH_RESULT_GRACE_MS`.
- Add `RALPH_AGENT` and the Codex model/config precedence to the environment
  table.

In `CONTRIBUTING.md`:

- Add the four provider modules and their tests to the repository map.
- State that a new provider implements command, credentials, and decoder
  contracts without branching the loop.
- Expand the image smoke description to include the pinned Codex binary and
  automation flags.
- Keep the existing stage-gate and bypass rules.

- [ ] **Step 7: Update and render the architecture visual**

In `docs/ralph-stack.svg` make these exact label replacements:

```text
This diagram shows how Ralph drives Claude Code or Codex against a target repo while you're AFK.
--agent · --codex-user-config · --detach · --notify
RALPH_AGENT · RALPH_WORKSPACE · RALPH_IMAGE · RALPH_MODEL
parse provider JSONL
Node 22 · Python 3.11 · .NET SDK 10 · gh · Claude Code · Codex.
Selected agent invocation
Claude: claude --print --output-format stream-json
Codex: codex exec --json --ephemeral
Both bypass approval; terminal message = stage output.
Selected: ~/.claude* or ~/.codex · ~/.config/gh (ro).
Live console rendering of normalized provider events.
after the completion event before container cut-off.
```

Keep the existing card coordinates and CSS; replace only text-node content.

Call `codex_app__load_workspace_dependencies`. For the current workspace bundle,
render the edited SVG to its matching PNG with:

```powershell
$env:NODE_PATH = "C:\Users\ADMIN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
@'
const sharp = require("sharp");
sharp("docs/ralph-stack.svg", { density: 96 })
  .png()
  .toFile("docs/ralph-stack.png")
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
'@ | & "C:\Users\ADMIN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
```

Open both files and verify the PNG remains 1440 × 2000 with no clipped labels.

- [ ] **Step 8: Verify documentation coverage and formatting**

Run:

```powershell
pnpm exec prettier --write README.md QUICKSTART.md packages/core/README.md apps/cli/README.md SECURITY.md CONTRIBUTING.md docs/ARCHITECTURE.md packages/core/templates/review.md packages/core/package.json apps/cli/package.json
rg -n -- "--agent codex|RALPH_AGENT|--codex-user-config|gpt-5.6-sol|cli_auth_credentials_store" README.md QUICKSTART.md packages/core/README.md apps/cli/README.md docs/ARCHITECTURE.md
rg -n -- "dangerously-bypass-approvals-and-sandbox|~/.codex" SECURITY.md docs/ARCHITECTURE.md
pnpm --filter @daonhan/ralph-core test
pnpm -r typecheck
pnpm -r build
node scripts/smoke-templates.mjs
git diff --check
```

Expected: each `rg` command finds every named contract, all tests/builds pass,
and `git diff --check` prints nothing.

- [ ] **Step 9: Commit provider docs and shared playbook**

```powershell
git add README.md QUICKSTART.md packages/core/README.md apps/cli/README.md SECURITY.md CONTRIBUTING.md docs/ARCHITECTURE.md docs/ralph-stack.svg docs/ralph-stack.png packages/core/templates/review.md packages/core/package.json apps/cli/package.json packages/core/src/__tests__/template-contract.test.ts
git commit -m "docs: document Codex provider support"
```

---

### Task 7: Full verification, package smoke, and authenticated Codex smoke

**Files:**

- Verify only; change files only to correct a reproduced failure.

**Interfaces:**

- Consumes: every feature contract from Tasks 1-6.
- Produces: evidence that source, packages, image, authentication, JSONL, and
  sentinel behavior work end-to-end.

- [ ] **Step 1: Run the full repository verification**

Run:

```powershell
pnpm -r typecheck
pnpm -r test
pnpm test
pnpm -r build
```

Expected: every command exits 0.

- [ ] **Step 2: Smoke the packed npm artifacts**

Run:

```powershell
$packDir = Join-Path $env:TEMP "ralph-codex-packs-$PID"
New-Item -ItemType Directory -Force $packDir | Out-Null
Push-Location packages/core
pnpm pack --pack-destination $packDir
Pop-Location
Push-Location apps/cli
pnpm pack --pack-destination $packDir
Pop-Location
Get-ChildItem $packDir -Filter "*.tgz"
```

Expected: one core tarball and one CLI tarball. Inspect the core tarball:

```powershell
$corePack = Get-ChildItem $packDir -Filter "*ralph-core*.tgz" | Select-Object -First 1
tar -tf $corePack.FullName | Select-String "dist/agents|templates/Dockerfile"
```

Expected: compiled agent modules and the Dockerfile are present.

- [ ] **Step 3: Re-run the real image contract**

Run:

```powershell
docker build --tag ralph-sandbox:codex-provider --file packages/core/templates/Dockerfile .
pnpm smoke:image -- --image ralph-sandbox:codex-provider
```

Expected: all sandbox contracts pass, including the network package check and
both Codex checks.

- [ ] **Step 4: Verify host and container Codex authentication**

Run from the same PowerShell context used for Ralph:

```powershell
codex login status
docker run --rm `
  -e CODEX_HOME=/home/agent/.codex `
  -v "${HOME}\.codex:/home/agent/.codex" `
  --entrypoint codex `
  ralph-sandbox:codex-provider `
  login status
```

Expected: both commands report an authenticated Codex session. If the container
reports signed out, stop and ask the user to set
`cli_auth_credentials_store = "file"` in `$HOME\.codex\config.toml` and run
`codex login`; resume only after the user confirms authentication.

- [ ] **Step 5: Verify resolved CLI precedence without launching a stage**

Run:

```powershell
Remove-Item Env:RALPH_MODEL -ErrorAction SilentlyContinue
node apps/cli/bin/ralph-afk.js --agent codex --print-config
node apps/cli/bin/ralph-afk.js --agent codex --codex-user-config --print-config
$env:RALPH_AGENT = "codex"
node apps/cli/bin/ralph-ghafk.js --print-config
Remove-Item Env:RALPH_AGENT
```

Expected:

- Isolated output shows Codex, `gpt-5.6-sol`, and high reasoning.
- Inherited output shows `~/.codex/config.toml` as model/reasoning source.
- The environment-only invocation selects Codex.

- [ ] **Step 6: Run one bounded authenticated Codex sentinel iteration**

Create a disposable Git repository under Ralph's ignored scratch directory:

```powershell
$smoke = Join-Path (Resolve-Path ".").Path ".ralph-tmp\codex-provider-smoke"
New-Item -ItemType Directory -Force (Join-Path $smoke "docs\plans") | Out-Null
Set-Content -LiteralPath (Join-Path $smoke "docs\plans\done.md") -Value @(
  "# Complete plan",
  "",
  "- [x] The only task is complete.",
  "",
  "Emit <promise>NO MORE TASKS</promise> without changing files."
)
Set-Content -LiteralPath (Join-Path $smoke ".gitignore") -Value ".ralph-tmp/"
git -C $smoke init
git -C $smoke config user.name "Ralph Smoke"
git -C $smoke config user.email "ralph-smoke@example.invalid"
git -C $smoke add .
git -C $smoke commit -m "test: seed completed plan"

$env:RALPH_WORKSPACE = $smoke
$env:RALPH_IMAGE = "ralph-sandbox:codex-provider"
$env:RALPH_DOCKER_SOCK = "0"
$env:RALPH_RESULT_GRACE_MS = "5000"
Remove-Item Env:RALPH_MODEL -ErrorAction SilentlyContinue
node apps/cli/bin/ralph-afk.js --agent codex "docs/plans/done.md" 1
```

Expected:

```text
Ralph complete after 1 iterations
```

Verify the raw protocol and gate behavior:

```powershell
$logs = Join-Path $smoke ".ralph-tmp\logs"
Get-ChildItem $logs -Filter "*implementer.ndjson" | Select-String '"thread.started"|"turn.completed"|NO MORE TASKS'
if (Get-ChildItem $logs -Filter "*reviewer.ndjson") {
  throw "reviewer ran after the Codex sentinel"
}
git -C $smoke status --short
```

Expected: protocol matches are present, no reviewer log exists, and Git status
is empty.

- [ ] **Step 7: Confirm the final commit series and clean worktree**

Run:

```powershell
git status --short
git log -6 --oneline
```

Expected: a clean worktree and these six commits in order:

```text
docs: document Codex provider support
feat(sandbox): install Codex CLI
feat(cli): select Claude or Codex
feat(core): run stages through agent adapters
feat(core): decode Claude and Codex streams
feat(core): add agent provider adapters
```

Do not create an empty verification commit.
