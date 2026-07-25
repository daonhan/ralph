import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentAdapter,
  parseAgentName,
  resolveAgentSelection,
} from "../agents/index.js";
import {
  buildClaudeArgs,
  DEFAULT_CLAUDE_MODEL,
  readHostClaudeModel,
  resolveClaudeModel,
  resolveModelArgs,
} from "../agents/claude.js";
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

describe("Claude host model resolution", () => {
  const homes: string[] = [];

  const makeHome = (settingsJson?: string): string => {
    const home = mkdtempSync(join(tmpdir(), "ralph-claude-home-"));
    homes.push(home);
    if (settingsJson !== undefined) {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), settingsJson);
    }
    return home;
  };

  afterEach(() => {
    while (homes.length > 0) {
      rmSync(homes.pop() as string, { recursive: true, force: true });
    }
  });

  it("reads the model the host /model picker stored", () => {
    const home = makeHome('{ "model": " claude-opus-5[1m] " }');
    expect(readHostClaudeModel(home)).toEqual({ model: "claude-opus-5[1m]" });
  });

  it("reports no model for missing or non-string settings", () => {
    expect(readHostClaudeModel("")).toEqual({});
    expect(readHostClaudeModel(makeHome())).toEqual({});
    expect(readHostClaudeModel(makeHome('{ "model": 5 }'))).toEqual({});
    expect(readHostClaudeModel(makeHome("{}"))).toEqual({});
  });

  it("skips blank models and the default sentinel", () => {
    expect(readHostClaudeModel(makeHome('{ "model": "  " }'))).toEqual({});
    expect(readHostClaudeModel(makeHome('{ "model": "default" }'))).toEqual({});
  });

  // A present-but-broken settings file must not look like "user chose
  // nothing": that would silently swap their model for Ralph's default, the
  // exact failure this resolution chain exists to prevent.
  it("distinguishes an unusable settings file from an absent one", () => {
    const home = makeHome("not json");
    const result = readHostClaudeModel(home);
    expect(result.model).toBeUndefined();
    expect(result.unreadable).toContain("invalid JSON");
    expect(readHostClaudeModel(makeHome()).unreadable).toBeUndefined();
  });

  // ANTHROPIC_MODEL in the settings env block reaches the container through
  // the bind-mounted settings file, and --model outranks it — so ignoring it
  // would silently override the user's own pin.
  it("honors env.ANTHROPIC_MODEL over the model key", () => {
    expect(
      readHostClaudeModel(
        makeHome(
          '{ "model": "claude-opus-5", "env": { "ANTHROPIC_MODEL": " claude-fable-5[1m] " } }'
        )
      )
    ).toEqual({ model: "claude-fable-5[1m]", providerFlag: undefined });
  });

  it("detects third-party provider routing in the settings env block", () => {
    expect(
      readHostClaudeModel(
        makeHome('{ "env": { "CLAUDE_CODE_USE_BEDROCK": "1" } }')
      )
    ).toEqual({ providerFlag: "CLAUDE_CODE_USE_BEDROCK" });
    expect(
      readHostClaudeModel(
        makeHome('{ "env": { "CLAUDE_CODE_USE_VERTEX": "true" } }')
      )
    ).toEqual({ providerFlag: "CLAUDE_CODE_USE_VERTEX" });
    expect(
      readHostClaudeModel(
        makeHome('{ "env": { "CLAUDE_CODE_USE_BEDROCK": "0" } }')
      )
    ).toEqual({ providerFlag: undefined });
  });

  it("prefers RALPH_MODEL, then host settings, then the Ralph default", () => {
    expect(
      resolveClaudeModel(" claude-opus-5 ", { model: "claude-fable-5[1m]" })
    ).toEqual({ model: "claude-opus-5", modelSource: "RALPH_MODEL" });
    expect(
      resolveClaudeModel(undefined, { model: "claude-opus-5[1m]" })
    ).toEqual({ model: "claude-opus-5[1m]", modelSource: "host settings" });
    expect(resolveClaudeModel("   ", undefined)).toEqual({
      model: DEFAULT_CLAUDE_MODEL,
      modelSource: "Ralph default",
    });
  });

  // Bedrock and friends use provider-specific model IDs, so forcing a
  // first-party default would fail a setup that worked before.
  it("leaves model resolution to the container under third-party routing", () => {
    expect(
      resolveClaudeModel(undefined, {
        providerFlag: "CLAUDE_CODE_USE_BEDROCK",
      })
    ).toEqual({ modelSource: "host provider config" });
    expect(
      resolveClaudeModel("us.anthropic.claude-opus-4-8", {
        providerFlag: "CLAUDE_CODE_USE_BEDROCK",
      })
    ).toEqual({
      model: "us.anthropic.claude-opus-4-8",
      modelSource: "RALPH_MODEL",
    });
    expect(
      resolveClaudeModel(undefined, {
        model: "us.anthropic.claude-opus-4-8",
        providerFlag: "CLAUDE_CODE_USE_BEDROCK",
      })
    ).toEqual({
      model: "us.anthropic.claude-opus-4-8",
      modelSource: "host settings",
    });
  });

  // The constant is the whole safety net; referencing it everywhere else means
  // only this assertion would catch an accidental edit.
  it("pins the Ralph default model value", () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5[1m]");
  });

  it("passes the host-selected model to the sandbox argv", () => {
    const home = makeHome('{ "model": "claude-opus-5[1m]" }');
    const args = getAgentAdapter("claude").buildCommand({
      stage,
      promptInstruction,
      rawModel: undefined,
      codexUserConfig: false,
      home,
    });
    expect(args).toEqual(
      buildClaudeArgs(stage, ".ralph-tmp/prompt.md", [
        "--model",
        "claude-opus-5[1m]",
      ])
    );
  });

  it("lets RALPH_MODEL override the host settings model in argv", () => {
    const home = makeHome('{ "model": "claude-fable-5[1m]" }');
    const args = getAgentAdapter("claude").buildCommand({
      stage,
      promptInstruction,
      rawModel: " claude-opus-5 ",
      codexUserConfig: false,
      home,
    });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
  });

  // The host /model picker deletes the `model` key when its "(default)" entry
  // is chosen, so an unpinned sandbox would fall back to the frozen image
  // CLI's own default (observed: claude-opus-4-8[1m]). Ralph must always send
  // --model so the container can never silently run an older model.
  it("falls back to the Ralph default instead of the sandbox CLI default", () => {
    const homes = [
      makeHome(), // no settings.json at all
      makeHome("{}"), // settings.json without a model key ("(default)" pick)
      makeHome('{ "model": "default" }'),
    ];
    for (const home of homes) {
      const args = getAgentAdapter("claude").buildCommand({
        stage,
        promptInstruction,
        rawModel: undefined,
        codexUserConfig: false,
        home,
      });
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe(DEFAULT_CLAUDE_MODEL);
    }
  });

  it("omits --model when host settings route to a third-party provider", () => {
    const args = getAgentAdapter("claude").buildCommand({
      stage,
      promptInstruction,
      rawModel: undefined,
      codexUserConfig: false,
      home: makeHome('{ "env": { "CLAUDE_CODE_USE_BEDROCK": "1" } }'),
    });
    expect(args).not.toContain("--model");
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

  // CODEX_HOME lives inside the container; the setup script copies credentials
  // from the read-only staging mount before exec'ing codex ($0="codex",
  // $@=rest). A bind-mounted CODEX_HOME breaks on Docker Desktop for Windows
  // (EPERM on the unix socket / symlinks Codex creates at startup).
  const setupScript =
    'mkdir -p "$CODEX_HOME"; ' +
    "for f in auth.json config.toml AGENTS.md; do " +
    'if [ -f "/mnt/codex-creds/$f" ]; then cp "/mnt/codex-creds/$f" "$CODEX_HOME/"; fi; ' +
    "done; " +
    'exec "$0" "$@"';

  it("builds isolated default args", () => {
    expect(
      buildCodexArgs({
        stage,
        promptInstruction,
        rawModel: undefined,
        codexUserConfig: false,
        home: "",
      })
    ).toEqual([
      "bash",
      "-c",
      setupScript,
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
        home: "",
      })
    ).toEqual([
      "bash",
      "-c",
      setupScript,
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
        home: "",
      })
    ).toEqual([
      "bash",
      "-c",
      setupScript,
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
        containerPath: "/mnt/codex-creds",
        readOnly: true,
      },
    ]);
    expect(adapter.containerEnv).toEqual({
      CODEX_HOME: "/home/agent/.codex",
    });
  });
});
