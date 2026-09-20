import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentAdapter,
  parseAgentName,
  resolveAgentSelection,
  resolveAgentTuning,
  SHARED_EFFORT_LEVELS,
  validateAgentTuning,
} from "../agents/index.js";
import {
  buildClaudeArgs,
  CLAUDE_HOME_VOLUME,
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

  // The update runs in the same container as the stage so a fresh CLI is
  // in place before claude starts; `$0` is the claude argv the script execs.
  it("preserves the complete Claude argv", () => {
    expect(
      buildClaudeArgs(stage, ".ralph-tmp/prompt.md", ["--model", "opus"])
    ).toEqual([
      "bash",
      "-c",
      'claude update 1>&2 || true; exec "$0" "$@"',
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

  // ~/.local holds the native installer's versions dir and launcher symlink;
  // one host-wide volume there is what makes the per-stage update cheap.
  it("keeps the updated CLI in a host-wide volume over ~/.local", () => {
    expect(getAgentAdapter("claude").volumeMounts()).toEqual([
      {
        name: CLAUDE_HOME_VOLUME,
        containerPath: "/home/agent/.local",
        labels: ["ralph.kind=claude-home"],
      },
    ]);
  });

  describe("with RALPH_CLAUDE_UPDATE=0", () => {
    const original = process.env.RALPH_CLAUDE_UPDATE;
    afterEach(() => {
      if (original === undefined) delete process.env.RALPH_CLAUDE_UPDATE;
      else process.env.RALPH_CLAUDE_UPDATE = original;
    });

    // Both go together: a volume mounted without the update would shadow a
    // fresher image with whatever it last cached.
    it("runs the image's claude directly and mounts no volume", () => {
      process.env.RALPH_CLAUDE_UPDATE = "0";
      const args = buildClaudeArgs(stage, ".ralph-tmp/prompt.md", []);
      expect(args[0]).toBe("claude");
      expect(args).not.toContain("bash");
      expect(getAgentAdapter("claude").volumeMounts()).toEqual([]);
    });
  });

  it("mounts the shipped skills where Claude discovers them", () => {
    expect(
      getAgentAdapter("claude").skillsMount("/pkg/templates/skills")
    ).toEqual({
      hostPath: "/pkg/templates/skills",
      containerPath: "/home/agent/ralph-skills/.claude/skills",
      readOnly: true,
    });
  });

  // --add-dir is variadic: placed last it would swallow the prompt positional
  // (the argv shape when --model is omitted under third-party routing).
  it("adds --add-dir before --verbose when the skills are mounted", () => {
    const args = getAgentAdapter("claude").buildCommand({
      stage,
      promptInstruction,
      rawModel: "opus",
      rawEffort: undefined,
      codexUserConfig: false,
      home: "",
      skillsMounted: true,
    });
    expect(args.slice(3, 7)).toEqual([
      "claude",
      "--add-dir",
      "/home/agent/ralph-skills",
      "--verbose",
    ]);
    expect(args.at(-1)).toBe(promptInstruction);
  });

  it("omits --add-dir when the skills are not mounted", () => {
    const context = {
      stage,
      promptInstruction,
      rawModel: "opus",
      rawEffort: undefined,
      codexUserConfig: false,
      home: "",
    };
    expect(
      getAgentAdapter("claude").buildCommand({
        ...context,
        skillsMounted: false,
      })
    ).not.toContain("--add-dir");
    expect(getAgentAdapter("claude").buildCommand(context)).not.toContain(
      "--add-dir"
    );
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

  // JSON invites unquoted `1` / `true`; missing a flag written that way would
  // pin a first-party model onto a Bedrock host and fail every stage.
  it("detects provider flags written as JSON numbers or booleans", () => {
    expect(
      readHostClaudeModel(
        makeHome('{ "env": { "CLAUDE_CODE_USE_BEDROCK": 1 } }')
      )
    ).toEqual({ providerFlag: "CLAUDE_CODE_USE_BEDROCK" });
    expect(
      readHostClaudeModel(
        makeHome('{ "env": { "CLAUDE_CODE_USE_VERTEX": true } }')
      )
    ).toEqual({ providerFlag: "CLAUDE_CODE_USE_VERTEX" });
    expect(
      readHostClaudeModel(
        makeHome('{ "env": { "CLAUDE_CODE_USE_BEDROCK": 0 } }')
      )
    ).toEqual({ providerFlag: undefined });
    expect(
      readHostClaudeModel(
        makeHome('{ "env": { "CLAUDE_CODE_USE_FOUNDRY": false } }')
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
      rawEffort: undefined,
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
      rawEffort: undefined,
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
        rawEffort: undefined,
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
      rawEffort: undefined,
      codexUserConfig: false,
      home: makeHome('{ "env": { "CLAUDE_CODE_USE_BEDROCK": "1" } }'),
    });
    expect(args).not.toContain("--model");
  });

  it("sends --effort after --model and right before the prompt", () => {
    const args = getAgentAdapter("claude").buildCommand({
      stage,
      promptInstruction,
      rawModel: "claude-opus-5",
      rawEffort: "xhigh",
      codexUserConfig: false,
      home: makeHome(),
    });
    expect(args.slice(-5)).toEqual([
      "--model",
      "claude-opus-5",
      "--effort",
      "xhigh",
      promptInstruction,
    ]);
  });

  it("sends no --effort when none was tuned", () => {
    const args = getAgentAdapter("claude").buildCommand({
      stage,
      promptInstruction,
      rawModel: "claude-opus-5",
      rawEffort: undefined,
      codexUserConfig: false,
      home: makeHome(),
    });
    expect(args).not.toContain("--effort");
  });

  // Third-party routing drops --model, so --effort becomes the last flag
  // before the prompt positional — and --add-dir, being variadic, must still
  // lead or it would swallow that prompt.
  it("sends --effort with no --model under third-party routing", () => {
    const args = getAgentAdapter("claude").buildCommand({
      stage,
      promptInstruction,
      rawModel: undefined,
      rawEffort: "max",
      codexUserConfig: false,
      home: makeHome('{ "env": { "CLAUDE_CODE_USE_BEDROCK": "1" } }'),
      skillsMounted: true,
    });
    expect(args).not.toContain("--model");
    expect(args.slice(-3)).toEqual(["--effort", "max", promptInstruction]);
    expect(args.indexOf("--add-dir")).toBe(args.indexOf("claude") + 1);
  });
});

describe("agent tuning", () => {
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => extra;

  it("prefers the flag, then the agent's variable, then the generic one", () => {
    expect(
      resolveAgentTuning(
        "codex",
        { effort: "low" },
        env({ RALPH_CODEX_EFFORT: "high", RALPH_EFFORT: "max" })
      ).effort
    ).toEqual({ value: "low", source: "--effort" });
    expect(
      resolveAgentTuning(
        "codex",
        {},
        env({ RALPH_CODEX_EFFORT: "high", RALPH_EFFORT: "max" })
      ).effort
    ).toEqual({ value: "high", source: "RALPH_CODEX_EFFORT" });
    expect(
      resolveAgentTuning("codex", {}, env({ RALPH_EFFORT: "max" })).effort
    ).toEqual({ value: "max", source: "RALPH_EFFORT" });
  });

  it("ignores the other agent's variables", () => {
    expect(
      resolveAgentTuning(
        "codex",
        {},
        env({ RALPH_CLAUDE_MODEL: "claude-opus-5", RALPH_CLAUDE_EFFORT: "max" })
      )
    ).toEqual({});
    expect(
      resolveAgentTuning(
        "claude",
        {},
        env({ RALPH_CODEX_MODEL: "gpt-5.6-sol", RALPH_CODEX_EFFORT: "none" })
      )
    ).toEqual({});
  });

  it("trims values and counts a blank one as unset", () => {
    expect(
      resolveAgentTuning(
        "claude",
        { model: "  " },
        env({ RALPH_CLAUDE_MODEL: "\t\n", RALPH_MODEL: "  claude-opus-5  " })
      ).model
    ).toEqual({ value: "claude-opus-5", source: "RALPH_MODEL" });
  });

  it("resolves model and effort independently", () => {
    expect(
      resolveAgentTuning(
        "claude",
        { effort: "max" },
        env({ RALPH_MODEL: "claude-opus-5" })
      )
    ).toEqual({
      model: { value: "claude-opus-5", source: "RALPH_MODEL" },
      effort: { value: "max", source: "--effort" },
    });
  });
});

describe("agent tuning validation", () => {
  const fromFlag = (value: string) => ({
    effort: { value, source: "--effort" },
  });

  it("accepts every level each adapter declares", () => {
    for (const agent of ["claude", "codex"] as const) {
      for (const level of getAgentAdapter(agent).effortLevels) {
        expect(validateAgentTuning(agent, fromFlag(level))).toBeUndefined();
      }
    }
  });

  it("accepts a tuning with no effort, and never checks the model", () => {
    expect(validateAgentTuning("claude", {})).toBeUndefined();
    expect(
      validateAgentTuning("claude", {
        model: { value: "no-such-model", source: "--model" },
      })
    ).toBeUndefined();
  });

  // ultracode starts workflow orchestration, which an unattended stage cannot
  // steer — so it is deliberately absent from the Claude list.
  it("rejects ultracode for Claude, naming the flag and the levels", () => {
    expect(validateAgentTuning("claude", fromFlag("ultracode"))).toBe(
      "--effort=ultracode is not a claude effort level; expected one of low|medium|high|xhigh|max"
    );
  });

  it("checks a per-agent variable against that agent's own levels (B)", () => {
    expect(
      validateAgentTuning("codex", {
        effort: { value: "ultracode", source: "RALPH_CODEX_EFFORT" },
      })
    ).toBe(
      "RALPH_CODEX_EFFORT=ultracode is not a codex effort level; expected one of none|minimal|low|medium|high|xhigh|max"
    );
    expect(
      validateAgentTuning("codex", {
        effort: { value: "none", source: "RALPH_CODEX_EFFORT" },
      })
    ).toBeUndefined();
  });

  // The gate on SHARED_EFFORT_LEVELS: Claude's five levels are a strict subset
  // of Codex's seven, so every Claude-side assertion here reads the same if the
  // intersection were never computed. Mutation: replace the intersection with
  // `getAgentAdapter(agent).effortLevels` — this case must go red.
  it("rejects a Codex-only level from the generic variable, with the hint (A1)", () => {
    expect(
      validateAgentTuning("codex", {
        effort: { value: "none", source: "RALPH_EFFORT" },
      })
    ).toBe(
      "RALPH_EFFORT=none is not an effort level every agent accepts; expected one of low|medium|high|xhigh|max; set RALPH_CODEX_EFFORT=none for a codex effort level"
    );
  });

  it("drops the hint when no adapter accepts the level (A2)", () => {
    expect(
      validateAgentTuning("codex", {
        effort: { value: "turbo", source: "RALPH_EFFORT" },
      })
    ).toBe(
      "RALPH_EFFORT=turbo is not an effort level every agent accepts; expected one of low|medium|high|xhigh|max"
    );
  });

  it("shares only the levels every adapter declares", () => {
    expect([...SHARED_EFFORT_LEVELS]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("Codex adapter", () => {
  it("resolves the isolated Sol/high default", () => {
    expect(resolveCodexModel(undefined, undefined, false)).toEqual({
      model: DEFAULT_CODEX_MODEL,
      modelSource: "Ralph default",
      reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
      reasoningSource: "Ralph default",
    });
  });

  it("leaves model and effort to inherited user config", () => {
    expect(resolveCodexModel(undefined, undefined, true)).toEqual({
      modelSource: "user config",
      reasoningSource: "user config",
    });
  });

  it("resolves an explicit model with the Ralph high default", () => {
    expect(resolveCodexModel(" gpt-custom ", undefined, false)).toEqual({
      model: "gpt-custom",
      modelSource: "explicit",
      reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
      reasoningSource: "Ralph default",
    });
    expect(resolveCodexModel(" gpt-custom ", undefined, true)).toEqual({
      model: "gpt-custom",
      modelSource: "explicit",
      reasoningSource: "user config",
    });
  });

  it("resolves an explicit effort over both defaults", () => {
    expect(resolveCodexModel(undefined, " minimal ", false)).toEqual({
      model: DEFAULT_CODEX_MODEL,
      modelSource: "Ralph default",
      reasoningEffort: "minimal",
      reasoningSource: "explicit",
    });
    expect(resolveCodexModel(undefined, "minimal", true)).toEqual({
      modelSource: "user config",
      reasoningEffort: "minimal",
      reasoningSource: "explicit",
    });
  });

  // CODEX_HOME lives inside the container; the setup script copies credentials
  // from the read-only staging mount before exec'ing codex ($0="codex",
  // $@=rest). A bind-mounted CODEX_HOME breaks on Docker Desktop for Windows
  // (EPERM on the unix socket / symlinks Codex creates at startup).
  const setupScript =
    'mkdir -p "$CODEX_HOME"; ' +
    "codex update 1>&2 || true; " +
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
        rawEffort: undefined,
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
        rawEffort: undefined,
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

  it("builds explicit-model args with the high default", () => {
    expect(
      buildCodexArgs({
        stage,
        promptInstruction,
        rawModel: " gpt-custom ",
        rawEffort: undefined,
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
      "-c",
      'model_reasoning_effort="high"',
      promptInstruction,
    ]);
  });

  it("builds explicit-effort args", () => {
    expect(
      buildCodexArgs({
        stage,
        promptInstruction,
        rawModel: undefined,
        rawEffort: "xhigh",
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
      DEFAULT_CODEX_MODEL,
      "-c",
      'model_reasoning_effort="xhigh"',
      promptInstruction,
    ]);
  });

  it("sends an explicit effort and no model under --codex-user-config", () => {
    expect(
      buildCodexArgs({
        stage,
        promptInstruction,
        rawModel: undefined,
        rawEffort: "low",
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
      "-c",
      'model_reasoning_effort="low"',
      promptInstruction,
    ]);
  });

  it("caches the updated CLI in a named volume", () => {
    expect(getAgentAdapter("codex").volumeMounts()).toEqual([
      {
        name: "ralph-codex-cli",
        containerPath: "/home/agent/.npm-global",
        labels: ["ralph.kind=codex-cli"],
      },
    ]);
  });

  describe("with RALPH_CODEX_UPDATE=0", () => {
    const original = process.env.RALPH_CODEX_UPDATE;
    afterEach(() => {
      if (original === undefined) delete process.env.RALPH_CODEX_UPDATE;
      else process.env.RALPH_CODEX_UPDATE = original;
    });

    // Both go together: a volume mounted without the update would shadow a
    // fresher image with whatever it last cached.
    it("skips the update step and mounts no volume", () => {
      process.env.RALPH_CODEX_UPDATE = "0";
      const args = buildCodexArgs({
        stage,
        promptInstruction,
        rawModel: undefined,
        rawEffort: undefined,
        codexUserConfig: false,
        home: "",
      });
      expect(args[2]).not.toContain("codex update");
      expect(args[2]).toContain('mkdir -p "$CODEX_HOME"');
      expect(getAgentAdapter("codex").volumeMounts()).toEqual([]);
    });
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

  it("mounts the shipped skills where Codex discovers them", () => {
    expect(
      getAgentAdapter("codex").skillsMount("/pkg/templates/skills")
    ).toEqual({
      hostPath: "/pkg/templates/skills",
      containerPath: "/home/agent/.agents/skills",
      readOnly: true,
    });
  });

  // Codex scans $HOME/.agents/skills on its own; the mount alone is enough.
  it("builds the same argv whether or not the skills are mounted", () => {
    const context = {
      stage,
      promptInstruction,
      rawModel: undefined,
      rawEffort: undefined,
      codexUserConfig: false,
      home: "",
    };
    expect(buildCodexArgs({ ...context, skillsMounted: true })).toEqual(
      buildCodexArgs({ ...context, skillsMounted: false })
    );
  });
});
