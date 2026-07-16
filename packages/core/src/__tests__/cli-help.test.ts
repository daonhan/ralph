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
