import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CLAUDE_MODEL } from "../agents/claude.js";
import {
  describeAgentConfig,
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
});

describe("describeAgentConfig", () => {
  it("describes the Ralph Claude default when no model is set anywhere", () => {
    expect(describeAgentConfig("claude", false, undefined)).toEqual({
      model: `${DEFAULT_CLAUDE_MODEL} (Ralph default)`,
    });
  });

  it("describes the host-settings Claude model", () => {
    expect(
      describeAgentConfig("claude", false, undefined, {
        model: "claude-opus-5[1m]",
      })
    ).toEqual({
      model: "claude-opus-5[1m] (host ~/.claude/settings.json)",
    });
  });

  it("lets RALPH_MODEL win over the host-settings Claude model", () => {
    expect(
      describeAgentConfig("claude", false, " claude-opus-5 ", {
        model: "claude-fable-5[1m]",
      })
    ).toEqual({
      model: "claude-opus-5 (RALPH_MODEL)",
    });
  });

  it("reports that third-party routing leaves the model to the container", () => {
    expect(
      describeAgentConfig("claude", false, undefined, {
        providerFlag: "CLAUDE_CODE_USE_BEDROCK",
      })
    ).toEqual({
      model:
        "container CLI default (host settings enable CLAUDE_CODE_USE_BEDROCK)",
    });
  });

  it("flags an unreadable host settings file next to the fallback model", () => {
    expect(
      describeAgentConfig("claude", false, undefined, {
        unreadable: "/home/me/.claude/settings.json (invalid JSON)",
      })
    ).toEqual({
      model: `${DEFAULT_CLAUDE_MODEL} (Ralph default; host settings unreadable: /home/me/.claude/settings.json (invalid JSON))`,
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
