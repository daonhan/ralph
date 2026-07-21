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
