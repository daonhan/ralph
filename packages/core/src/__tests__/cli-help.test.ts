import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CLAUDE_MODEL } from "../agents/claude.js";
import {
  describeAgentConfig,
  formatAttemptConfig,
  parseFlags,
  printConfig,
  printHelp,
} from "../cli-help.js";

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

  it("parses --model and --effort", () => {
    expect(
      parseFlags(["--model", "gpt-custom", "--effort", "xhigh", "2"])
    ).toMatchObject({
      model: "gpt-custom",
      effort: "xhigh",
      rest: ["2"],
    });
  });

  it("preserves an Ultra effort token for agent-aware validation", () => {
    expect(
      parseFlags(["--agent", "codex", "--effort", "ultra", "2"])
    ).toMatchObject({ agent: "codex", effort: "ultra", rest: ["2"] });
  });

  it("rejects a missing --model value", () => {
    expect(() => parseFlags(["--model"])).toThrow("--model requires a value");
    expect(() => parseFlags(["--model", "--notify"])).toThrow(
      "--model requires a value"
    );
  });

  it("rejects a missing --effort value", () => {
    expect(() => parseFlags(["--effort"])).toThrow("--effort requires a value");
    expect(() => parseFlags(["--effort", "--notify"])).toThrow(
      "--effort requires a value"
    );
  });

  // parseFlags cannot check the level: the agent may still come from
  // RALPH_AGENT, and each agent takes a different set. runLoop checks it.
  it("leaves an unknown effort level for the loop to reject", () => {
    expect(parseFlags(["--effort", "turbo", "2"])).toMatchObject({
      effort: "turbo",
    });
  });
});

describe("describeAgentConfig", () => {
  it("describes the Ralph Claude default when nothing is tuned anywhere", () => {
    expect(describeAgentConfig("claude", false, {})).toEqual({
      model: `${DEFAULT_CLAUDE_MODEL} (Ralph default)`,
      reasoning: "Claude CLI default (host settings effortLevel applies)",
      resolved: {
        model: DEFAULT_CLAUDE_MODEL,
        modelSource: "Ralph default",
        effortSource: "Claude CLI default",
      },
    });
  });

  it("describes the host-settings Claude model", () => {
    expect(
      describeAgentConfig("claude", false, {}, { model: "claude-opus-5[1m]" })
    ).toMatchObject({
      model: "claude-opus-5[1m] (host ~/.claude/settings.json)",
      resolved: {
        model: "claude-opus-5[1m]",
        modelSource: "host ~/.claude/settings.json",
      },
    });
  });

  it("lets a tuned model win over the host-settings Claude model, named by its source", () => {
    expect(
      describeAgentConfig(
        "claude",
        false,
        { model: { value: "claude-opus-5", source: "RALPH_CLAUDE_MODEL" } },
        { model: "claude-fable-5[1m]" }
      )
    ).toMatchObject({
      model: "claude-opus-5 (RALPH_CLAUDE_MODEL)",
      resolved: {
        model: "claude-opus-5",
        modelSource: "RALPH_CLAUDE_MODEL",
      },
    });
  });

  it("names --effort as the Claude reasoning source", () => {
    expect(
      describeAgentConfig("claude", false, {
        effort: { value: "xhigh", source: "--effort" },
      })
    ).toMatchObject({
      reasoning: "xhigh (--effort)",
      resolved: { effort: "xhigh", effortSource: "--effort" },
    });
  });

  it("flags a Claude effort level the CLI does not take", () => {
    expect(
      describeAgentConfig("claude", false, {
        effort: { value: "none", source: "RALPH_EFFORT" },
      })
    ).toMatchObject({
      reasoning:
        "none (RALPH_EFFORT; invalid: allowed low|medium|high|xhigh|max)",
      resolved: { effort: "none", effortSource: "RALPH_EFFORT" },
    });
  });

  it("reports that third-party routing leaves the model to the container", () => {
    expect(
      describeAgentConfig(
        "claude",
        false,
        {},
        { providerFlag: "CLAUDE_CODE_USE_BEDROCK" }
      )
    ).toEqual({
      model:
        "container CLI default (host settings enable CLAUDE_CODE_USE_BEDROCK)",
      reasoning: "Claude CLI default (host settings effortLevel applies)",
      resolved: {
        modelSource: "host provider config",
        effortSource: "Claude CLI default",
      },
    });
  });

  // The run log's consumers read all four fields absent as "an older Ralph
  // ignored the request", so this branch has to carry both sources too.
  it("keeps both sources on the third-party branch when an effort is tuned", () => {
    expect(
      describeAgentConfig(
        "claude",
        false,
        { effort: { value: "max", source: "--effort" } },
        { providerFlag: "CLAUDE_CODE_USE_VERTEX" }
      )
    ).toEqual({
      model:
        "container CLI default (host settings enable CLAUDE_CODE_USE_VERTEX)",
      reasoning: "max (--effort)",
      resolved: {
        modelSource: "host provider config",
        effort: "max",
        effortSource: "--effort",
      },
    });
  });

  it("flags an unreadable host settings file next to the fallback model", () => {
    expect(
      describeAgentConfig(
        "claude",
        false,
        {},
        { unreadable: "/home/me/.claude/settings.json (invalid JSON)" }
      )
    ).toMatchObject({
      model: `${DEFAULT_CLAUDE_MODEL} (Ralph default; host settings unreadable: /home/me/.claude/settings.json (invalid JSON))`,
      resolved: { modelSource: "Ralph default" },
    });
  });

  it("describes isolated Codex defaults", () => {
    expect(describeAgentConfig("codex", false, {})).toEqual({
      codexConfig: "isolated (--ignore-user-config)",
      model: "gpt-6-sol (Ralph default)",
      reasoning: "high (Ralph default)",
      resolved: {
        model: "gpt-6-sol",
        modelSource: "Ralph default",
        effort: "high",
        effortSource: "Ralph default",
      },
    });
  });

  it("describes inherited Codex config", () => {
    expect(describeAgentConfig("codex", true, {})).toEqual({
      codexConfig: "inherited (~/.codex/config.toml)",
      model: "user config (RALPH_MODEL unset)",
      reasoning: "user config",
      resolved: { modelSource: "user config", effortSource: "user config" },
    });
  });

  it("describes an explicit Codex model with the Ralph effort default", () => {
    expect(
      describeAgentConfig("codex", false, {
        model: { value: "gpt-custom", source: "RALPH_CODEX_MODEL" },
      })
    ).toEqual({
      codexConfig: "isolated (--ignore-user-config)",
      model: "gpt-custom (RALPH_CODEX_MODEL)",
      reasoning: "high (Ralph default)",
      resolved: {
        model: "gpt-custom",
        modelSource: "RALPH_CODEX_MODEL",
        effort: "high",
        effortSource: "Ralph default",
      },
    });
  });

  it("names a Codex-only effort level by its own variable", () => {
    expect(
      describeAgentConfig("codex", false, {
        effort: { value: "none", source: "RALPH_CODEX_EFFORT" },
      })
    ).toMatchObject({
      reasoning: "none (RALPH_CODEX_EFFORT)",
      resolved: { effort: "none", effortSource: "RALPH_CODEX_EFFORT" },
    });
  });

  it("describes valid Codex Ultra without claiming compatibility", () => {
    expect(
      describeAgentConfig("codex", false, {
        effort: { value: "ultra", source: "--effort" },
      })
    ).toMatchObject({
      reasoning: "ultra (--effort)",
      resolved: { effort: "ultra", effortSource: "--effort" },
    });
  });

  it("marks Ultra invalid for Claude and the generic Codex variable", () => {
    expect(
      describeAgentConfig("claude", false, {
        effort: { value: "ultra", source: "--effort" },
      }).reasoning
    ).toBe("ultra (--effort; invalid: allowed low|medium|high|xhigh|max)");
    expect(
      describeAgentConfig("codex", false, {
        effort: { value: "ultra", source: "RALPH_EFFORT" },
      }).reasoning
    ).toBe("ultra (RALPH_EFFORT; invalid: allowed low|medium|high|xhigh|max)");
  });
});

describe("formatAttemptConfig", () => {
  it("labels inherited provider settings without inventing values", () => {
    expect(
      formatAttemptConfig(2, "codex", {
        modelSource: "user config",
        effortSource: "user config",
      })
    ).toBe(
      "attempt 2 · codex · configured model=provider-managed (user config) · effort=provider-managed (user config)"
    );
  });

  it("sanitizes display controls without changing the snapshot", () => {
    const snapshot = {
      model: "gpt\nunsafe\u001b[31m",
      modelSource: "--model",
      effort: "high\rnext",
      effortSource: "--effort",
    };

    const line = formatAttemptConfig(1, "codex", snapshot);

    expect(line).toContain("gpt\\nunsafe\\u001b[31m");
    expect(line).toContain("high\\rnext");
    expect(line).not.toMatch(/[\r\n\u001b]/);
    expect(snapshot.model).toBe("gpt\nunsafe\u001b[31m");
    expect(snapshot.effort).toBe("high\rnext");
  });

  it("labels Claude-owned omitted fields as provider-managed", () => {
    expect(
      formatAttemptConfig(1, "claude", {
        modelSource: "host provider config",
        effortSource: "Claude CLI default",
      })
    ).toBe(
      "attempt 1 · claude · configured model=provider-managed (host provider config) · effort=provider-managed (Claude CLI default)"
    );
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
  expect(output).toContain("gpt-6-sol");
  expect(output).toContain("--model <name>");
  expect(output).toContain("--effort <level>");
  expect(output).toContain("Codex adds none|minimal|ultra");
  expect(output).toContain("model-dependent");
  expect(output).toContain("RALPH_CLAUDE_MODEL");
  expect(output).toContain("RALPH_CODEX_EFFORT");
  expect(output).toContain("RALPH_EFFORT");
});

it("prints the history dir under the resolved workspace", () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  printConfig("ralph-afk", "/repo", "/ctx", "/pkg");
  const output = write.mock.calls.map((call) => String(call[0])).join("");
  expect(output).toContain(
    `history dir           ${join("/repo", ".ralph", "history")}`
  );
});

describe("printConfig claude update", () => {
  const KNOB = "RALPH_CLAUDE_UPDATE";
  const original = process.env[KNOB];

  function capture(): string {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    printConfig("ralph-afk", "/repo", "/ctx", "/pkg");
    return write.mock.calls.map((call) => String(call[0])).join("");
  }

  afterEach(() => {
    if (original === undefined) delete process.env[KNOB];
    else process.env[KNOB] = original;
  });

  it("reports the per-stage update and its volume by default", () => {
    delete process.env[KNOB];
    expect(capture()).toContain(
      "claude update         on before every stage, cached in volume ralph-claude-home (RALPH_CLAUDE_UPDATE=0 to run the image's copy)"
    );
  });

  it("reports the variable turning the update off", () => {
    process.env[KNOB] = "0";
    expect(capture()).toContain(
      "claude update         off (RALPH_CLAUDE_UPDATE=0) — running the image's copy"
    );
  });
});

describe("printConfig codex update", () => {
  const KNOB = "RALPH_CODEX_UPDATE";
  const original = process.env[KNOB];

  function capture(): string {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    printConfig("ralph-afk", "/repo", "/ctx", "/pkg", { agent: "codex" });
    return write.mock.calls.map((call) => String(call[0])).join("");
  }

  afterEach(() => {
    if (original === undefined) delete process.env[KNOB];
    else process.env[KNOB] = original;
  });

  it("reports the per-stage update and its volume by default", () => {
    delete process.env[KNOB];
    expect(capture()).toContain(
      "codex update          on before every stage, cached in volume ralph-codex-cli (RALPH_CODEX_UPDATE=0 to run the image's copy)"
    );
  });

  it("reports the variable turning the update off", () => {
    process.env[KNOB] = "0";
    expect(capture()).toContain(
      "codex update          off (RALPH_CODEX_UPDATE=0) — running the image's copy"
    );
  });

  it("does not report a codex update line for Claude", () => {
    delete process.env[KNOB];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    printConfig("ralph-afk", "/repo", "/ctx", "/pkg");
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).not.toContain("codex update");
  });
});

describe("printConfig node_modules isolation", () => {
  const KNOB = "RALPH_ISOLATE_NODE_MODULES";
  const original = process.env[KNOB];
  const roots: string[] = [];

  function setKnob(value: string | undefined): void {
    if (value === undefined) delete process.env[KNOB];
    else process.env[KNOB] = value;
  }

  function capture(workspaceDir: string): string {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    printConfig("ralph-afk", workspaceDir, "/ctx", "/pkg");
    return write.mock.calls.map((call) => String(call[0])).join("");
  }

  afterEach(() => {
    setKnob(original);
    while (roots.length > 0)
      rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it("reports the linux default when the variable is unset", () => {
    setKnob(undefined);
    // printConfig takes no platform argument, so pin the one branch that reads
    // process.platform rather than trusting the host running the suite.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
      expect(capture("/repo")).toContain(
        "node_modules          shared with the host bind mount (linux default; RALPH_ISOLATE_NODE_MODULES=1 to isolate)"
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("reports the variable turning isolation off", () => {
    setKnob("0");
    const output = capture("/repo");
    expect(output).toContain(
      "node_modules          shared with the host bind mount (RALPH_ISOLATE_NODE_MODULES=0)"
    );
    expect(output).not.toContain("isolated in");
  });

  it("counts the node_modules volumes when isolation is on", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-print-config-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{}\n", "utf8");
    setKnob("1");
    expect(capture(root)).toContain(
      "node_modules          isolated in 1 container volumes (RALPH_ISOLATE_NODE_MODULES=0 to share the host tree)"
    );
  });

  it("says nothing is mounted when the workspace has no package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-print-config-"));
    roots.push(root);
    setKnob("1");
    const output = capture(root);
    expect(output).toContain(
      "node_modules          isolation on, but this workspace has no package.json — nothing mounted"
    );
    expect(output).not.toContain("isolated in");
  });
});

describe("printConfig model and effort", () => {
  const KNOBS = ["RALPH_EFFORT", "RALPH_MODEL", "RALPH_CODEX_EFFORT"] as const;
  const original = KNOBS.map((knob) => [knob, process.env[knob]] as const);

  function capture(opts = {}): string {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    printConfig("ralph-afk", "/repo", "/ctx", "/pkg", opts);
    return write.mock.calls.map((call) => String(call[0])).join("");
  }

  afterEach(() => {
    for (const [knob, value] of original) {
      if (value === undefined) delete process.env[knob];
      else process.env[knob] = value;
    }
  });

  it("names --effort as the Codex reasoning source", () => {
    for (const knob of KNOBS) delete process.env[knob];
    expect(capture({ agent: "codex", effort: "ultra" })).toContain(
      "  reasoning             ultra (--effort)\n"
    );
  });

  it("shows Ultra from its Codex-specific variable as valid", () => {
    delete process.env.RALPH_EFFORT;
    delete process.env.RALPH_MODEL;
    process.env.RALPH_CODEX_EFFORT = "ultra";
    const output = capture({ agent: "codex" });
    expect(output).toContain(
      "  reasoning             ultra (RALPH_CODEX_EFFORT)\n"
    );
    expect(output).not.toContain("invalid:");
  });

  it("prints a reasoning line for Claude too", () => {
    for (const knob of KNOBS) delete process.env[knob];
    expect(capture()).toContain(
      "  reasoning             Claude CLI default (host settings effortLevel applies)\n"
    );
  });

  // A bad level ends a run, but never --print-config: the printer is what a
  // user reaches for to see which variable supplied it.
  it("reports an unusable RALPH_EFFORT without throwing", () => {
    delete process.env.RALPH_MODEL;
    process.env.RALPH_EFFORT = "none";
    expect(capture()).toContain(
      "  reasoning             none (RALPH_EFFORT; invalid: allowed low|medium|high|xhigh|max)\n"
    );
  });

  it("names the variable a Codex model came from", () => {
    delete process.env.RALPH_EFFORT;
    process.env.RALPH_MODEL = "gpt-custom";
    expect(capture({ agent: "codex" })).toContain(
      "  model                 gpt-custom (RALPH_MODEL)\n"
    );
  });
});
