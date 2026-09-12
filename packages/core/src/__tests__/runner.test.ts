import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getAgentAdapter } from "../agents/index.js";
import {
  buildClaudeArgs,
  parseGraceMs,
  resolveAgentRuntimeArgs,
  resolveAgentVolumeArgs,
  resolveGitConfigArgs,
  resolveModelArgs,
  resolveSkillsMountArgs,
} from "../runner.js";

describe("parseGraceMs", () => {
  it("returns the default when unset", () => {
    expect(parseGraceMs(undefined)).toBe(30_000);
  });

  it("returns the default for an empty string", () => {
    expect(parseGraceMs("")).toBe(30_000);
  });

  it("returns the default for whitespace-only input", () => {
    expect(parseGraceMs("   ")).toBe(30_000);
  });

  it("returns the default for non-numeric input", () => {
    expect(parseGraceMs("abc")).toBe(30_000);
  });

  it("returns the default for negative input", () => {
    expect(parseGraceMs("-5")).toBe(30_000);
  });

  it("returns 0 when explicitly set to 0 (disabled)", () => {
    expect(parseGraceMs("0")).toBe(0);
  });

  it("returns the parsed value for a valid integer", () => {
    expect(parseGraceMs("45000")).toBe(45_000);
  });

  it("floors fractional values", () => {
    expect(parseGraceMs("1500.9")).toBe(1500);
  });

  it("honors a custom default", () => {
    expect(parseGraceMs(undefined, 1000)).toBe(1000);
    expect(parseGraceMs("abc", 1000)).toBe(1000);
  });
});

describe("resolveModelArgs", () => {
  it("returns [] when unset", () => {
    expect(resolveModelArgs(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(resolveModelArgs("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(resolveModelArgs("   ")).toEqual([]);
  });

  it("returns --model + alias for a short alias", () => {
    expect(resolveModelArgs("opus")).toEqual(["--model", "opus"]);
  });

  it("returns --model + full id for a full model spec", () => {
    expect(resolveModelArgs("claude-opus-4-8")).toEqual([
      "--model",
      "claude-opus-4-8",
    ]);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveModelArgs("  opus  ")).toEqual(["--model", "opus"]);
  });
});

describe("buildClaudeArgs", () => {
  const stage = { name: "test", template: "test.md" };
  const stageWithPermissionMode = {
    name: "test",
    template: "test.md",
    permissionMode: "bypassPermissions",
  };
  const promptPath = ".ralph-tmp/prompt.md";

  it("includes the claude invocation and prompt instruction", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args.slice(0, 4)).toEqual([
      "bash",
      "-c",
      expect.stringContaining("claude update"),
      "claude",
    ]);
    expect(args).toContain("--verbose");
    expect(args).toContain("--print");
    expect(args.at(-1)).toContain(promptPath);
  });

  it("appends --model args when RALPH_MODEL is set", () => {
    const args = buildClaudeArgs(stage, promptPath, ["--model", "opus"]);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("opus");
  });

  it("does not include --model when modelArgs is empty", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--model");
  });

  it("includes --permission-mode when stage has permissionMode", () => {
    const args = buildClaudeArgs(stageWithPermissionMode, promptPath, []);
    expect(args).toContain("--permission-mode");
    const idx = args.indexOf("--permission-mode");
    expect(args[idx + 1]).toBe("bypassPermissions");
  });

  it("omits --permission-mode when stage has no permissionMode", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--permission-mode");
  });

  it("places --model args before the prompt instruction", () => {
    const args = buildClaudeArgs(stage, promptPath, ["--model", "opus"]);
    const modelIdx = args.indexOf("--model");
    const promptIdx = args.findIndex((a) => a.includes(promptPath));
    expect(modelIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeLessThan(promptIdx);
  });
});

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
      expect(codexArgs.join(" ")).toContain("/mnt/codex-creds:ro");
      expect(codexArgs.join(" ")).not.toContain(":/home/agent/.codex");
      expect(codexArgs.join(" ")).not.toContain(".claude");
      expect(codexArgs).toContain("CODEX_HOME=/home/agent/.codex");
      expect(codexArgs.join(" ")).toContain("/home/agent/.config/gh:ro");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentVolumeArgs", () => {
  // `--mount` because `-v` cannot label the volume docker creates on first use.
  it("mounts each provider volume with its labels", () => {
    expect(resolveAgentVolumeArgs(getAgentAdapter("claude"))).toEqual([
      "--mount",
      "type=volume,source=ralph-claude-home,target=/home/agent/.local,volume-label=ralph.kind=claude-home",
    ]);
    expect(resolveAgentVolumeArgs(getAgentAdapter("codex"))).toEqual([]);
  });
});

describe("resolveSkillsMountArgs", () => {
  it("mounts the shipped skills read-only where each provider looks", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-skills-"));
    try {
      expect(resolveSkillsMountArgs(getAgentAdapter("claude"), dir)).toEqual([
        "-v",
        `${dir}:/home/agent/ralph-skills/.claude/skills:ro`,
      ]);
      expect(resolveSkillsMountArgs(getAgentAdapter("codex"), dir)).toEqual([
        "-v",
        `${dir}:/home/agent/.agents/skills:ro`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mounts nothing when the skills directory is absent or unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-skills-"));
    try {
      expect(
        resolveSkillsMountArgs(getAgentAdapter("claude"), join(dir, "missing"))
      ).toEqual([]);
      expect(
        resolveSkillsMountArgs(getAgentAdapter("claude"), undefined)
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveGitConfigArgs", () => {
  // Point git at config files we own, so the host's real identity can neither
  // leak into the "no identity" cases nor mask the precedence one.
  const sandbox = mkdtempSync(join(tmpdir(), "ralph-gitid-"));
  const globalCfg = join(sandbox, "gitconfig-global");
  const saved = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_SYSTEM,
  };

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    process.env.GIT_CONFIG_SYSTEM = join(sandbox, "gitconfig-system");
    writeFileSync(globalCfg, "");
  });

  afterAll(() => {
    process.env.GIT_CONFIG_GLOBAL = saved.global;
    process.env.GIT_CONFIG_SYSTEM = saved.system;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function setGlobal(name: string, email: string): void {
    writeFileSync(globalCfg, `[user]\n\tname = ${name}\n\temail = ${email}\n`);
  }

  function repo(name?: string, email?: string): string {
    const dir = mkdtempSync(join(sandbox, "repo-"));
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q");
    if (name !== undefined) git("config", "--local", "user.name", name);
    if (email !== undefined) git("config", "--local", "user.email", email);
    return dir;
  }

  it("always trusts the bind-mounted workspace", () => {
    const args = resolveGitConfigArgs(repo("A", "a@example.com"));
    expect(args).toContain("GIT_CONFIG_KEY_0=safe.directory");
    expect(args).toContain("GIT_CONFIG_VALUE_0=*");
  });

  it("injects the workspace's git identity so the agent cannot invent one", () => {
    const args = resolveGitConfigArgs(repo("Ada Lovelace", "ada@example.com"));
    expect(args).toContain("GIT_CONFIG_COUNT=3");
    expect(args).toContain("GIT_CONFIG_KEY_1=user.name");
    expect(args).toContain("GIT_CONFIG_VALUE_1=Ada Lovelace");
    expect(args).toContain("GIT_CONFIG_KEY_2=user.email");
    expect(args).toContain("GIT_CONFIG_VALUE_2=ada@example.com");
  });

  it("falls back to the host's global identity when the repo sets none", () => {
    setGlobal("Global Name", "global@example.com");
    const args = resolveGitConfigArgs(repo());
    expect(args).toContain("GIT_CONFIG_VALUE_1=Global Name");
    expect(args).toContain("GIT_CONFIG_VALUE_2=global@example.com");
  });

  it("prefers a repo-local identity over the host's global one", () => {
    // We read through `git -C <dir>`, so git's own local-over-global
    // precedence decides — a per-repo identity is never clobbered.
    setGlobal("Global Name", "global@example.com");
    const args = resolveGitConfigArgs(repo("Repo Local", "local@example.com"));
    expect(args).toContain("GIT_CONFIG_VALUE_1=Repo Local");
    expect(args).toContain("GIT_CONFIG_VALUE_2=local@example.com");
  });

  it("injects no identity when neither the repo nor the host has one", () => {
    const args = resolveGitConfigArgs(repo());
    expect(args).toContain("GIT_CONFIG_COUNT=1");
    expect(args).not.toContain("GIT_CONFIG_KEY_1=user.name");
  });

  it("injects no identity when only half the pair is set", () => {
    const args = resolveGitConfigArgs(repo("Half Only"));
    expect(args).toContain("GIT_CONFIG_COUNT=1");
    expect(args.join(" ")).not.toContain("Half Only");
  });
});
