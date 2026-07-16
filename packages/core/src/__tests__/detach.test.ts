import { describe, expect, it, vi } from "vitest";

import {
  detachAndExit,
  stripDetachFlags,
  type DetachOptions,
  type DetachedChild,
} from "../detach.js";

describe("stripDetachFlags", () => {
  it("removes --detach when present", () => {
    expect(stripDetachFlags(["--detach", "plan", "3"])).toEqual(["plan", "3"]);
  });

  it("removes --log and its value when present", () => {
    expect(stripDetachFlags(["--log", "/tmp/a.log", "plan", "3"])).toEqual([
      "plan",
      "3",
    ]);
  });

  it("removes both --detach and --log <value> while preserving other flags", () => {
    expect(
      stripDetachFlags([
        "--no-keep-alive",
        "--detach",
        "--max-retries",
        "5",
        "--log",
        "/tmp/a.log",
        "plan",
        "3",
      ])
    ).toEqual(["--no-keep-alive", "--max-retries", "5", "plan", "3"]);
  });

  it("is a no-op when neither flag is present", () => {
    expect(stripDetachFlags(["plan", "3"])).toEqual(["plan", "3"]);
  });

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
});

type SpawnCall = {
  cmd: string;
  args: readonly string[];
  options: {
    detached: boolean;
    stdio: readonly ["ignore", number, number];
    windowsHide: boolean;
  };
};

function makeCtx(overrides: Partial<DetachOptions> = {}) {
  const spawnCalls: SpawnCall[] = [];
  const fakeChild: DetachedChild & { unref: ReturnType<typeof vi.fn> } = {
    pid: 99999,
    unref: vi.fn(),
  };
  const spawnFn = vi.fn((cmd, args, options) => {
    spawnCalls.push({ cmd, args, options });
    return fakeChild;
  });
  const stderr = { write: vi.fn() };
  const exit = vi.fn((_code?: number) => {
    throw new Error("__exit__");
  }) as unknown as (code?: number) => never;
  const ensureDir = vi.fn();
  const openFd = vi.fn(() => 42);
  const opts: DetachOptions = {
    logPath: "/tmp/x/y.log",
    argv: ["--detach", "plan", "3"],
    binEntry: "/path/to/ralph-afk.js",
    execPath: "/usr/bin/node",
    spawnFn,
    openFd,
    ensureDir,
    stderr,
    exit,
    ...overrides,
  };
  return { opts, spawnCalls, fakeChild, stderr, exit, ensureDir, openFd };
}

describe("detachAndExit", () => {
  it("ensures log dir, opens fd, spawns child with stripped argv + detached options, unrefs, writes stderr, exits 0", () => {
    const ctx = makeCtx();

    expect(() => detachAndExit(ctx.opts)).toThrow("__exit__");

    expect(ctx.ensureDir).toHaveBeenCalledWith("/tmp/x");
    expect(ctx.openFd).toHaveBeenCalledWith("/tmp/x/y.log");

    expect(ctx.spawnCalls).toHaveLength(1);
    expect(ctx.spawnCalls[0].cmd).toBe("/usr/bin/node");
    expect(ctx.spawnCalls[0].args).toEqual([
      "/path/to/ralph-afk.js",
      "plan",
      "3",
    ]);
    expect(ctx.spawnCalls[0].options).toEqual({
      detached: true,
      stdio: ["ignore", 42, 42],
      windowsHide: true,
    });

    expect(ctx.fakeChild.unref).toHaveBeenCalledTimes(1);
    expect(ctx.stderr.write).toHaveBeenCalledWith(
      "detached pid 99999, log /tmp/x/y.log\n"
    );
    expect(ctx.exit).toHaveBeenCalledWith(0);
  });

  it("strips --log <value> from the child argv too", () => {
    const ctx = makeCtx({
      argv: ["--detach", "--log", "/tmp/old.log", "plan", "3"],
    });

    expect(() => detachAndExit(ctx.opts)).toThrow("__exit__");

    expect(ctx.spawnCalls[0].args).toEqual([
      "/path/to/ralph-afk.js",
      "plan",
      "3",
    ]);
  });
});
