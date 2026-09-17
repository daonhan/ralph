import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "../stages.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  ensureImage: vi.fn(),
  notifyComplete: vi.fn(),
  notifyError: vi.fn(),
  release: vi.fn(),
  runStage: vi.fn(),
  runningRunContainers: vi.fn(),
}));

// Disk faults for the run log, armed per test: a write that fails partway
// through a record, or an fsync that fails after the bytes landed.
const faults = vi.hoisted(() => ({
  write: undefined as ((data: unknown) => boolean) | undefined,
  fsync: false,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (faults.write?.(args[1])) {
        if (typeof args[0] === "number") {
          actual.writeSync(args[0], String(args[1]).slice(0, 12));
        }
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      }
      return actual.writeFileSync(...args);
    },
    fsyncSync: (fd: number) => {
      if (faults.fsync) {
        throw Object.assign(new Error("EIO: i/o error, fsync"), {
          code: "EIO",
        });
      }
      return actual.fsyncSync(fd);
    },
  };
});

vi.mock("../keepalive.js", () => ({
  acquire: mocks.acquire,
}));

vi.mock("../notify.js", () => ({
  notifyComplete: mocks.notifyComplete,
  notifyError: mocks.notifyError,
}));

vi.mock("../runner.js", () => ({
  ensureImage: mocks.ensureImage,
  runStage: mocks.runStage,
  runningRunContainers: mocks.runningRunContainers,
  stageLogPath: (workspaceDir: string, iteration: number, stageName: string) =>
    join(
      workspaceDir,
      ".ralph-tmp",
      "logs",
      `iter${iteration}-${stageName}.ndjson`
    ),
}));

vi.mock("../stream-render.js", () => ({
  USE_COLOR: false,
  dim: (s: string) => s,
  bold: (s: string) => s,
  red: (s: string) => s,
  greenOut: (s: string) => s,
  redOut: (s: string) => s,
  boldOut: (s: string) => s,
  dimOut: (s: string) => s,
  SYM: { cross: "FAIL" },
  SYM_OUT: { bullet: "*" },
}));

import { deriveStatus, hasSentinel, runLoop } from "../loop.js";
import { openRunLog, reduceRunLog } from "../run-log.js";

const stage: Stage = { name: "implementer", template: "stage.md" };
const sentinel = "<promise>NO MORE TASKS</promise>";
// The closing sentence every `no-more-tasks` exit in this repo's own history on
// 2026-09-08 ended on: the agent naming the sentinel, not emitting it.
const mention = `Opening/merging the PR is HITL, so the next iteration should emit \`${sentinel}\`.`;
// What an emission looks like: the report of an empty queue, sentinel last.
const emission = `**Done**\n\n- nothing to pick up\n\n**Blocked**\n\n- Nothing.\n\n**Next**\n\n- none\n\n${sentinel}`;

// runStage resolves { text, meta }; meta is empty in this slice.
const ok = (text: string) => ({ text, meta: {} });

type LoopDirs = {
  root: string;
  ralphDir: string;
  packageDir: string;
  workspaceDir: string;
};

function makeDirs(): LoopDirs {
  const root = mkdtempSync(join(tmpdir(), "ralph-loop-"));
  const ralphDir = join(root, "ralph");
  const packageDir = join(root, "sandcastle");
  const workspaceDir = join(root, "workspace");

  mkdirSync(join(packageDir, "templates"), { recursive: true });
  mkdirSync(ralphDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(packageDir, "templates", stage.template),
    "run {{ INPUTS }}",
    "utf8"
  );

  return { root, ralphDir, packageDir, workspaceDir };
}

function loopOptions(dirs: LoopDirs, overrides = {}) {
  return {
    stages: [stage] as [Stage],
    inputs: "plan",
    iterations: 1,
    ralphDir: dirs.ralphDir,
    workspaceDir: dirs.workspaceDir,
    packageDir: dirs.packageDir,
    ...overrides,
  };
}

/** Everything the stdout spy was handed, joined — the loop's summary line. */
function readStdout(): string {
  return (
    process.stdout.write as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls
    .map((c) => String(c[0]))
    .join("");
}

/** Everything the stderr spy was handed, joined. */
function readStderr(): string {
  return (
    process.stderr.write as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls
    .map((c) => String(c[0]))
    .join("");
}

function readHistory(workspaceDir: string): string {
  const dir = join(workspaceDir, ".ralph", "history");
  const md = readdirSync(dir).find((f) => f.endsWith(".md"));
  return readFileSync(join(dir, md!), "utf8");
}

/** Names in the history dir with the given extension, oldest run first. */
function historyFiles(workspaceDir: string, ext: string): string[] {
  return readdirSync(join(workspaceDir, ".ralph", "history"))
    .filter((f) => f.endsWith(ext))
    .sort();
}

/** The newest run's event log, folded. */
function readRunLog(workspaceDir: string) {
  const file = historyFiles(workspaceDir, ".jsonl").at(-1)!;
  return reduceRunLog(
    readFileSync(join(workspaceDir, ".ralph", "history", file), "utf8")
  );
}

/**
 * Turn a workspace into a git repo with one committed `.gitignore` (so the
 * loop's own `.ralph-tmp/` and `.ralph/` scratch never counts as dirty) and
 * nothing else outstanding, so `dirtySnapshot` reports a clean tree.
 */
function makeCleanRepo(dir: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, ".gitignore"), ".ralph-tmp/\n.ralph/\n", "utf8");
  git("add", ".gitignore");
  git("commit", "-m", "init");
}

/**
 * {@link makeCleanRepo} plus a single untracked file, so `dirtySnapshot`
 * reports exactly one path.
 */
function makeDirtyRepo(dir: string): void {
  makeCleanRepo(dir);
  writeFileSync(join(dir, "wip.txt"), "draft\n", "utf8");
}

/**
 * Leave the fingerprint a sandbox install writes into the bind-mounted tree: a
 * `node_modules/.modules.yaml` whose pnpm store lives under the sandbox home.
 */
function makeSandboxInstall(dir: string): void {
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", ".modules.yaml"),
    "storeDir: /home/agent/workspace/.pnpm-store/v3\n",
    "utf8"
  );
}

/**
 * Move HEAD in `dir` by committing one new file — what a stage stub calls to
 * play an implementer that actually landed work.
 */
function commitInWorkspace(dir: string, name: string): void {
  writeFileSync(join(dir, name), "work\n", "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("add", name);
  git("commit", "-m", name);
}

/** Short HEAD sha of `dir`, for asserting the sha a skipped entry carries. */
function headOf(dir: string): string {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

describe("runLoop", () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.useRealTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.acquire.mockReturnValue({ release: mocks.release });
    mocks.runningRunContainers.mockReturnValue([]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    faults.write = undefined;
    faults.fsync = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("acquires the wake-lock before image setup and releases on completion", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const order: string[] = [];
    mocks.acquire.mockImplementation(() => {
      order.push("acquire");
      return { release: mocks.release };
    });
    mocks.ensureImage.mockImplementation(() => {
      order.push("ensureImage");
    });
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { notify: true }));

    expect(order).toEqual(["acquire", "ensureImage"]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.notifyComplete).toHaveBeenCalledWith(1, true);
  });

  it("prints the cli + core version banner at loop init", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk", cliVersion: "9.9.9" }));

    const stderr = (
      process.stderr.write as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(stderr).toContain("ralph-afk 9.9.9 (core ");
  });

  it("uses the bin name in the wake-lock reason", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-ghafk" }));

    expect(mocks.acquire).toHaveBeenCalledWith({ reason: "ralph-ghafk loop" });
  });

  it("forwards provider settings to every stage", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

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
        skillsHostDir: join(dirs.packageDir, "templates", "skills"),
        signal: expect.any(AbortSignal),
      })
    );
  });

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
    ).rejects.toThrow(
      "--codex-user-config requires Codex; select it with --agent codex or RALPH_AGENT=codex"
    );
    expect(mocks.ensureImage).not.toHaveBeenCalled();
    expect(mocks.runStage).not.toHaveBeenCalled();
  });

  it("logs terminal stage failure and continues with the next iteration", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(ok(sentinel));

    await runLoop(loopOptions(dirs, { iterations: 2, maxRetries: 0 }));

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    const firstLog = readFileSync(
      join(dirs.workspaceDir, ".ralph-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(firstLog).toContain(
      "[failure] iteration 1 stage implementer failed after 0 retries: boom"
    );
  });

  it("retries a failed stage before continuing", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValueOnce(ok(sentinel));

    const loop = runLoop(loopOptions(dirs, { maxRetries: 1 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await loop;

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    const firstLog = readFileSync(
      join(dirs.workspaceDir, ".ralph-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(firstLog).toContain("[retry] attempt 1 of 1 after 5000 ms");
  });

  it("retries a failing render and surfaces it as a terminal failure (no false completion)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    // Template whose shell tag always fails — emulates a flaky `gh issue list`.
    // Such a failure must abort/retry the stage, never silently degrade the
    // prompt into a false `<promise>NO MORE TASKS</promise>` completion.
    const failStage: Stage = { name: "implementer", template: "fail.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "fail.md"),
      "!`exit 1`",
      "utf8"
    );

    await runLoop(
      loopOptions(dirs, { stages: [failStage] as [Stage], maxRetries: 0 })
    );

    // Render threw before the stage ran: runStage never invoked, loop did not
    // reject, and the terminal failure was logged.
    expect(mocks.runStage).not.toHaveBeenCalled();
    const log = readFileSync(
      join(dirs.workspaceDir, ".ralph-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(log).toContain("[failure] iteration 1 stage implementer failed");
  });

  it("records retries and attempt bullets on a stage that recovers", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValue(ok("recovered"));

    const loop = runLoop(
      loopOptions(dirs, { maxRetries: 2, bin: "ralph-afk" })
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000); // wait before attempt 2
    await vi.advanceTimersByTimeAsync(30_000); // wait before attempt 3
    await loop;

    expect(mocks.runStage).toHaveBeenCalledTimes(3);
    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · ok · ");
    expect(text).toContain("retries: 2");
    expect(text).toContain("- attempt 1: e1");
    expect(text).toContain("- attempt 2: e2");
    expect(text).toContain("recovered");
    vi.useRealTimers();
  });

  it("records a failed entry with dirty snapshot and a failed footer", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    makeDirtyRepo(dirs.workspaceDir);
    mocks.runStage
      .mockRejectedValueOnce(new Error("first boom"))
      .mockRejectedValue(new Error("final boom"));

    const loop = runLoop(
      loopOptions(dirs, { maxRetries: 1, bin: "ralph-afk" })
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000); // wait before the final attempt
    await loop;

    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · failed · ");
    expect(text).toContain("retries: 1");
    expect(text).toContain("- attempt 1: first boom");
    expect(text).toContain("dirty: 1 files — wip.txt");
    expect(text).toContain("final boom"); // final error is the body
    expect(text).toMatch(/--- ended · 1\/1 iterations · failed/);
    vi.useRealTimers();
  });

  it("records a render failure as a failed history entry", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const failStage: Stage = { name: "implementer", template: "fail.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "fail.md"),
      "!`exit 7`",
      "utf8"
    );

    await runLoop(
      loopOptions(dirs, {
        stages: [failStage] as [Stage],
        maxRetries: 0,
        bin: "ralph-afk",
      })
    );

    expect(mocks.runStage).not.toHaveBeenCalled();
    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · failed · ");
    expect(text).toMatch(/--- ended · 1\/1 iterations · failed/);
  });

  it("aborts the active stage and releases the wake-lock on SIGINT", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    let capturedSignal: AbortSignal | undefined;
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) => {
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          capturedSignal!.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      }
    );

    const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    expect(() => process.emit("SIGINT")).toThrow("exit 130");

    expect(capturedSignal?.aborted).toBe(true);
    await loop;
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("aborts image setup and releases the wake-lock on SIGTERM", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    let capturedSignal: AbortSignal | undefined;
    mocks.ensureImage.mockImplementation((_ralphDir, options) => {
      capturedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        capturedSignal!.addEventListener("abort", () =>
          reject(new Error("image aborted"))
        );
      });
    });

    const loop = runLoop(loopOptions(dirs));
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    expect(() => process.emit("SIGTERM")).toThrow("exit 143");

    expect(capturedSignal?.aborted).toBe(true);
    await expect(loop).rejects.toThrow("image aborted");
    expect(readRunLog(dirs.workspaceDir).view.ended).toMatchObject({
      reason: "aborted",
      signal: "SIGTERM",
    });
    expect(mocks.runStage).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("records an aborted entry as the terminal marker on SIGINT mid-stage", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    makeDirtyRepo(dirs.workspaceDir);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );

    const loop = runLoop(
      loopOptions(dirs, { maxRetries: 0, bin: "ralph-afk" })
    );
    await Promise.resolve();
    await Promise.resolve();

    // The handler writes the entry synchronously, before process.exit throws.
    expect(() => process.emit("SIGINT")).toThrow("exit 130");

    // Read at the exit moment: the aborted entry is the file's last content and
    // no footer follows it (the process would have exited here in production).
    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · aborted · ");
    expect(text).toContain("dirty: 1 files — wip.txt");
    expect(text).toContain("Interrupted (SIGINT).");
    expect(text).not.toMatch(/--- ended/);
    expect(readStdout()).not.toContain("Ralph ended");
    const atExit = readRunLog(dirs.workspaceDir);
    expect(atExit.events.map((e) => e.type)).toEqual([
      "run.started",
      "stage.started",
      "stage.completed",
      "run.ended",
    ]);
    expect(atExit.view.entries[0]).toMatchObject({
      status: "aborted",
      dirty: "1 files — wip.txt",
    });
    expect(atExit.view.ended).toMatchObject({
      reason: "aborted",
      signal: "SIGINT",
    });

    await loop; // let the aborted stage's rejection settle
    // The loop kept going only because process.exit is mocked; the closed log
    // took none of that.
    expect(readRunLog(dirs.workspaceDir)).toEqual(atExit);
    expect(exit).toHaveBeenCalledWith(130);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("records an aborted entry and preserves exit 143 on SIGTERM mid-stage", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    makeDirtyRepo(dirs.workspaceDir);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );

    const loop = runLoop(
      loopOptions(dirs, { maxRetries: 0, bin: "ralph-afk" })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(() => process.emit("SIGTERM")).toThrow("exit 143");

    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · aborted · ");
    expect(text).toContain("Terminated (SIGTERM).");
    expect(text).not.toMatch(/--- ended/);

    await loop;
    expect(exit).toHaveBeenCalledWith(143);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("writes no aborted entry when a signal arrives before any stage runs", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    // Signal lands while the image is still resolving: history is not open and
    // the `current` slot is empty, so the handler records no entry — only the
    // log's run.ended.
    mocks.ensureImage.mockImplementation((_ralphDir, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new Error("image aborted"))
        );
      });
    });

    const loop = runLoop(loopOptions(dirs));
    await Promise.resolve();
    await Promise.resolve();

    expect(() => process.emit("SIGINT")).toThrow("exit 130");
    expect(historyFiles(dirs.workspaceDir, ".md")).toEqual([]);
    const log = readRunLog(dirs.workspaceDir);
    expect(log.events.map((e) => e.type)).toEqual(["run.started", "run.ended"]);
    expect(log.view.ended).toMatchObject({
      reason: "aborted",
      signal: "SIGINT",
      completedIterations: 0,
    });

    await expect(loop).rejects.toThrow("image aborted");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("renders a prior run's aborted entry into the next implementer prompt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 8, 13, 0, 0)));
    const dirs = makeDirs();
    roots.push(dirs.root);
    makeDirtyRepo(dirs.workspaceDir);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "<history>\n{{ HISTORY }}\n</history>\nrun",
      "utf8"
    );
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    // Run 1: the stage is aborted mid-flight by SIGINT, writing an aborted entry.
    mocks.runStage.mockImplementationOnce(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );
    const run1 = runLoop(
      loopOptions(dirs, {
        stages: [impl] as [Stage],
        maxRetries: 0,
        bin: "ralph-afk",
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(() => process.emit("SIGINT")).toThrow("exit 130");
    await run1; // settles after the abort rejection

    // Run 2 (distinct UTC second → distinct filename) reads run 1's aborted entry.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 8, 13, 0, 1)));
    mocks.runStage.mockResolvedValue(ok(sentinel));
    await runLoop(
      loopOptions(dirs, { stages: [impl] as [Stage], bin: "ralph-afk" })
    );

    const secondPrompt = String(mocks.runStage.mock.calls.at(-1)![1]);
    expect(secondPrompt).toContain("· aborted · ");
    expect(secondPrompt).toContain("dirty: 1 files — wip.txt");
    vi.useRealTimers();
  });

  it("records a history file with header, entry, and footer on sentinel", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));

    expect(
      readFileSync(
        join(dirs.workspaceDir, ".ralph", "history", ".gitignore"),
        "utf8"
      )
    ).toBe("*\n");
    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("# ralph-afk ");
    expect(text).toContain("inputs: plan");
    expect(text).toContain("## iter 1/1 · implementer · no-more-tasks · ");
    expect(text).toMatch(/--- ended · 1\/1 iterations · no-more-tasks/);
  });

  it("closes the footer with 'cap' when the loop runs to its iteration cap", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok("still working"));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk", iterations: 2 }));

    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/2 · implementer · ok · ");
    expect(text).toContain("## iter 2/2 · implementer · ok · ");
    expect(text).toMatch(/--- ended · 2\/2 iterations · cap/);
  });

  it("prints the run summary line and footer totals on the sentinel exit", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue({
      text: sentinel,
      meta: { costUsd: 0.25 },
    });

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));

    expect(readStdout()).toContain(
      "* Ralph ended · no-more-tasks · 1/1 iterations · 1 stages · $0.25 · "
    );
    expect(readHistory(dirs.workspaceDir)).toContain(
      "--- ended · 1/1 iterations · no-more-tasks · 1 stages · $0.25 · "
    );
  });

  it("counts the skipped reviewer in the summary line at the iteration cap", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    // The gate commits nothing, so the reviewer is skipped, not run.
    makeCleanRepo(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok("still working"));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
      })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    expect(readStdout()).toContain(
      "* Ralph ended · cap · 1/1 iterations · 1 stages (1 skipped) · "
    );
  });

  it("marks the summary line failed when the last iteration failed", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockRejectedValue(new Error("boom"));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk", maxRetries: 0 }));

    expect(readStdout()).toContain(
      "* Ralph ended · failed · 1/1 iterations · 1 stages · "
    );
  });

  it("omits cost and tokens from the summary line when no stage reported them", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));

    const stdout = readStdout();
    expect(stdout).toContain(
      "* Ralph ended · no-more-tasks · 1/1 iterations · 1 stages · "
    );
    expect(stdout).not.toContain("$");
    expect(stdout).not.toContain("k in");
  });

  it("warns on stderr and marks the footer when the sandbox rewrote node_modules", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    makeSandboxInstall(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));

    expect(readStderr()).toContain(
      "[warning] sandbox install rewrote the host node_modules:\n" +
        "  - node_modules/.modules.yaml storeDir: /home/agent/workspace/.pnpm-store/v3\n" +
        "  repair on the host: delete node_modules/ and .pnpm-store/, then run your install command\n"
    );
    expect(readHistory(dirs.workspaceDir).trimEnd()).toMatch(
      / · warning: sandbox-install$/
    );
    expect(readStdout()).toContain("Ralph ended");
    expect(readStdout()).not.toContain("warning");
  });

  it("warns once and marks the footer on the cap exit too", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    makeSandboxInstall(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok("still working"));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));

    const warnings = readStderr().split(
      "[warning] sandbox install rewrote the host node_modules:"
    );
    expect(warnings).toHaveLength(2);
    expect(readHistory(dirs.workspaceDir).trimEnd()).toMatch(
      /--- ended · 1\/1 iterations · cap · .* · warning: sandbox-install$/
    );
  });

  it("stays silent when the host tree carries no sandbox-install fingerprint", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));

    expect(readStderr()).not.toContain("[warning]");
    expect(readHistory(dirs.workspaceDir)).not.toContain("warning");
  });

  it("does not rewrite the history .gitignore on a second run", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));
    const gitignore = join(
      dirs.workspaceDir,
      ".ralph",
      "history",
      ".gitignore"
    );
    writeFileSync(gitignore, "custom\n", "utf8");

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));
    expect(readFileSync(gitignore, "utf8")).toBe("custom\n");
  });

  it("writes no history file when image setup fails before the loop", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.ensureImage.mockRejectedValue(new Error("no image"));

    await expect(runLoop(loopOptions(dirs))).rejects.toThrow("no image");
    expect(historyFiles(dirs.workspaceDir, ".md")).toEqual([]);
    // The event log still records the attempt and why it ended.
    const log = readRunLog(dirs.workspaceDir);
    expect(log.truncated).toBe(false);
    expect(log.events.map((e) => e.type)).toEqual(["run.started", "run.ended"]);
    expect(log.view.ended).toMatchObject({
      reason: "error",
      error: "no image",
    });
  });

  it("logs run.started, each stage, and run.ended beside the history file", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "ralph-ghafk", inputs: "" }));

    const log = readRunLog(dirs.workspaceDir);
    expect(log.truncated).toBe(false);
    expect(log.events.map((e) => e.type)).toEqual([
      "run.started",
      "stage.started",
      "stage.completed",
      "run.ended",
    ]);
    expect(log.view.started).toMatchObject({
      pid: process.pid,
      platform: process.platform,
      bin: "ghafk",
      agent: "claude",
      iterations: 1,
    });
    expect(log.view.entries[0]).toMatchObject({
      iteration: 1,
      stage: "implementer",
      status: "no-more-tasks",
    });
    expect(log.view.ended).toMatchObject({
      reason: "no-more-tasks",
      completedIterations: 1,
    });
    // One run, one base name for both files.
    expect(historyFiles(dirs.workspaceDir, ".md")).toEqual([
      `${log.view.started!.runId}.md`,
    ]);
  });

  it("logs a skipped stage as completed without a start, then the cap", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(join(dirs.packageDir, "templates", "impl.md"), "impl");
    writeFileSync(join(dirs.packageDir, "templates", "rev.md"), "review");
    makeCleanRepo(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok("changed nothing"));

    await runLoop(loopOptions(dirs, { stages: [impl, rev] as [Stage, Stage] }));

    const { events, view } = readRunLog(dirs.workspaceDir);
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "stage.started",
      "stage.completed",
      "stage.completed",
      "run.ended",
    ]);
    expect(view.entries.map((e) => e.status)).toEqual(["ok", "skipped"]);
    expect(view.ended).toMatchObject({ reason: "cap", completedIterations: 1 });
  });

  it("logs each retry and a failed run", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage
      .mockRejectedValueOnce(new Error("first boom"))
      .mockRejectedValue(new Error("final boom"));

    const loop = runLoop(loopOptions(dirs, { maxRetries: 1 }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await loop;

    const { events, view } = readRunLog(dirs.workspaceDir);
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "stage.started",
      "stage.retry",
      "stage.completed",
      "run.ended",
    ]);
    expect(events[2]).toMatchObject({
      iteration: 1,
      stage: "implementer",
      attempt: 1,
      error: "first boom",
      backoffMs: 5_000,
    });
    expect(view.entries[0]).toMatchObject({
      status: "failed",
      body: "final boom",
      retries: 1,
    });
    expect(view.ended).toMatchObject({ reason: "failed" });
    vi.useRealTimers();
  });

  it("names a container per stage attempt and labels it with the run", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(join(dirs.packageDir, "templates", "impl.md"), "impl");
    writeFileSync(join(dirs.packageDir, "templates", "rev.md"), "review");
    makeCleanRepo(dirs.workspaceDir);
    mocks.runStage
      .mockRejectedValueOnce(new Error("flaky"))
      .mockImplementationOnce(async () => {
        commitInWorkspace(dirs.workspaceDir, "work.txt");
        return ok("landed");
      })
      .mockResolvedValueOnce(ok("<review>OK</review>"));

    const loop = runLoop(
      loopOptions(dirs, { stages: [impl, rev] as [Stage, Stage] })
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await loop;

    const { events, view } = readRunLog(dirs.workspaceDir);
    const runId = view.started!.runId;
    const names = mocks.runStage.mock.calls.map((call) => call[6].container);
    expect(names).toEqual([
      { name: `ralph-${runId}-i1-s0-a1`, runId },
      { name: `ralph-${runId}-i1-s0-a2`, runId },
      { name: `ralph-${runId}-i1-s1-a1`, runId },
    ]);
    const logged = events.flatMap((e) =>
      e.type === "stage.started" || e.type === "stage.retry"
        ? [`${e.type} ${e.container}`]
        : []
    );
    expect(logged).toEqual([
      `stage.started ralph-${runId}-i1-s0-a1`,
      `stage.retry ralph-${runId}-i1-s0-a2`,
      `stage.started ralph-${runId}-i1-s1-a1`,
    ]);
  });

  it("heartbeats the agent's last output time while a stage runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 17, 10, 0, 0)));
    const dirs = makeDirs();
    roots.push(dirs.root);
    let finish!: (value: unknown) => void;
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) => {
        options.onOutput(); // the agent writes its first record at 10:00:00
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    );

    const loop = runLoop(loopOptions(dirs));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    const during = readRunLog(dirs.workspaceDir);
    expect(during.events.map((e) => e.type)).toEqual([
      "run.started",
      "stage.started",
      "heartbeat",
    ]);
    expect(during.view.stage?.name).toBe("implementer");
    expect(during.view.lastOutputAt).toBe("2026-09-17T10:00:00.000Z");
    expect(during.view.lastHeartbeatAt).toBe("2026-09-17T10:00:30.000Z");

    finish(ok(sentinel));
    await loop;
    await vi.advanceTimersByTimeAsync(60_000);

    // The heartbeat stops with the run: nothing follows run.ended.
    const after = readRunLog(dirs.workspaceDir);
    expect(after.truncated).toBe(false);
    expect(after.events.at(-1)?.type).toBe("run.ended");
    expect(after.events.filter((e) => e.type === "heartbeat")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("heartbeats a null last output before the agent has written anything", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    // Image setup hangs: no stage, no output — the heartbeat still proves the
    // host process is alive.
    let failImage!: (err: Error) => void;
    mocks.ensureImage.mockReturnValue(
      new Promise((_resolve, reject) => {
        failImage = reject;
      })
    );

    const loop = runLoop(loopOptions(dirs));
    await vi.advanceTimersByTimeAsync(30_000);

    const { events, view } = readRunLog(dirs.workspaceDir);
    expect(events.map((e) => e.type)).toEqual(["run.started", "heartbeat"]);
    expect(view.lastOutputAt).toBeNull();
    expect(view.stage).toBeUndefined();

    // Settle the run so its handlers, timer and log handle are released.
    failImage(new Error("pull hung"));
    await expect(loop).rejects.toThrow("pull hung");
    vi.useRealTimers();
  });

  it("warns once and carries on when heartbeats cannot be fsynced", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    let finish!: (value: unknown) => void;
    mocks.runStage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );

    const loop = runLoop(loopOptions(dirs));
    await Promise.resolve();
    await Promise.resolve();
    faults.fsync = true;
    await vi.advanceTimersByTimeAsync(60_000);
    faults.fsync = false;
    finish(ok(sentinel));

    await expect(loop).resolves.toBe("no-more-tasks");
    expect(
      readStderr().split("[warning] run log heartbeat failed: EIO")
    ).toHaveLength(2);
    // The heartbeats landed unsynced; the log still reads through to the end.
    const { events, truncated } = readRunLog(dirs.workspaceDir);
    expect(truncated).toBe(false);
    expect(events.filter((e) => e.type === "heartbeat")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("run.ended");
  });

  it("ends the run when a stage event cannot be written", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    faults.write = (data) => String(data).includes('"stage.started"');

    await expect(runLoop(loopOptions(dirs))).rejects.toThrow("ENOSPC");

    expect(mocks.runStage).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("ends the run at once when a retry cannot be logged", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockRejectedValue(new Error("boom"));
    faults.write = (data) => String(data).includes('"stage.retry"');

    // No backoff wait, no further attempt: the log is known to be broken.
    await expect(runLoop(loopOptions(dirs))).rejects.toThrow("ENOSPC");

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("still exits 130 and releases once when the abort cannot be logged", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );

    const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
    await Promise.resolve();
    await Promise.resolve();
    faults.write = (data) => String(data).includes('"stage.completed"');

    expect(() => process.emit("SIGINT")).toThrow("exit 130");

    await loop.catch(() => {});
    expect(exit).toHaveBeenCalledWith(130);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("resolves with how the run ended", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);

    mocks.runStage.mockResolvedValue(ok(sentinel));
    await expect(runLoop(loopOptions(dirs))).resolves.toBe("no-more-tasks");

    mocks.runStage.mockResolvedValue(ok("still working"));
    await expect(runLoop(loopOptions(dirs))).resolves.toBe("cap");

    mocks.runStage.mockRejectedValue(new Error("boom"));
    await expect(runLoop(loopOptions(dirs, { maxRetries: 0 }))).resolves.toBe(
      "failed"
    );
  });

  it("refuses to start while another run of the workspace is live", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    // A run this very (node) process started and never ended: live by pid.
    const live = openRunLog({
      workspaceDir: dirs.workspaceDir,
      bin: "ghafk",
      started: {
        pid: process.pid,
        hostname: hostname(),
        platform: process.platform,
        wslDistro: process.env.WSL_DISTRO_NAME,
        agent: "claude",
        iterations: 5,
        inputs: "",
        version: "0.15.0",
      },
    });

    try {
      await expect(runLoop(loopOptions(dirs))).resolves.toBe("refused");
    } finally {
      live.close();
    }

    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.ensureImage).not.toHaveBeenCalled();
    expect(mocks.runStage).not.toHaveBeenCalled();
    expect(readStderr()).toContain(
      `[refused] another ralph run is live in this workspace: pid ${process.pid} on ${hostname()}`
    );
    const refused = readRunLog(dirs.workspaceDir);
    expect(refused.view.started?.runId).not.toBe(live.runId);
    expect(refused.events.map((e) => e.type)).toEqual([
      "run.started",
      "run.ended",
    ]);
    expect(refused.view.ended).toMatchObject({
      reason: "refused",
      blockedBy: live.runId,
    });
    expect(historyFiles(dirs.workspaceDir, ".md")).toEqual([]);
  });

  it("does not block the next launch when its refusal cannot be logged", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const live = openRunLog({
      workspaceDir: dirs.workspaceDir,
      bin: "ghafk",
      started: {
        pid: process.pid,
        hostname: hostname(),
        platform: process.platform,
        wslDistro: process.env.WSL_DISTRO_NAME,
        agent: "claude",
        iterations: 5,
        inputs: "",
        version: "0.15.0",
      },
    });
    faults.write = (data) => String(data).includes('"refused"');

    try {
      await expect(runLoop(loopOptions(dirs))).rejects.toThrow("ENOSPC");
    } finally {
      faults.write = undefined;
      live.close();
    }

    // The failed refusal's log never ended, but its launch is over: this
    // process must not read it as a run it still has open.
    mocks.runStage.mockResolvedValue(ok(sentinel));
    await expect(runLoop(loopOptions(dirs))).resolves.toBe("no-more-tasks");
  });

  it("refuses beside a live run written by a newer ralph", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const historyDir = join(dirs.workspaceDir, ".ralph", "history");
    mkdirSync(historyDir, { recursive: true });
    const newer = "2026-01-01-000000-ghafk";
    writeFileSync(
      join(historyDir, `${newer}.jsonl`),
      `${JSON.stringify({ v: 2, seq: 1, at: "2026-01-01T00:00:00.000Z", type: "run.started" })}\n`
    );

    await expect(runLoop(loopOptions(dirs))).resolves.toBe("refused");

    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(readStderr()).toContain(
      "[refused] another ralph run is live in this workspace: written by a newer ralph"
    );
    expect(readRunLog(dirs.workspaceDir).view.ended).toMatchObject({
      reason: "refused",
      blockedBy: newer,
    });
  });

  it("prunes older refused launches when it refuses too", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const identity = {
      pid: process.pid,
      hostname: hostname(),
      platform: process.platform,
      wslDistro: process.env.WSL_DISTRO_NAME,
      agent: "claude",
      iterations: 1,
      inputs: "",
      version: "0.15.0",
    };
    const at = (day: number) => new Date(Date.UTC(2026, 0, day));
    for (const day of [1, 2, 3]) {
      openRunLog({
        workspaceDir: dirs.workspaceDir,
        bin: "afk",
        started: identity,
        now: at(day),
      }).append({
        type: "run.ended",
        reason: "refused",
        completedIterations: 0,
        blockedBy: "x",
      });
    }
    const live = openRunLog({
      workspaceDir: dirs.workspaceDir,
      bin: "afk",
      started: identity,
      now: at(4),
    });

    try {
      await expect(runLoop(loopOptions(dirs))).resolves.toBe("refused");
    } finally {
      live.close();
    }

    const self = readRunLog(dirs.workspaceDir).view.started!.runId;
    expect(historyFiles(dirs.workspaceDir, ".jsonl")).toEqual([
      `${live.runId}.jsonl`,
      `${self}.jsonl`,
    ]);
  });

  it("starts after a run whose log never ended once its process is gone", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const crashed = openRunLog({
      workspaceDir: dirs.workspaceDir,
      bin: "ghafk",
      started: {
        pid: 2 ** 31 - 1, // no such process
        hostname: hostname(),
        platform: process.platform,
        wslDistro: process.env.WSL_DISTRO_NAME,
        agent: "claude",
        iterations: 5,
        inputs: "",
        version: "0.15.0",
      },
    });
    crashed.close(); // killed: no run.ended

    mocks.runStage.mockResolvedValue(ok(sentinel));
    await expect(runLoop(loopOptions(dirs))).resolves.toBe("no-more-tasks");
  });

  it("refuses while a container of a killed run is still running", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const killed = openRunLog({
      workspaceDir: dirs.workspaceDir,
      bin: "ghafk",
      started: {
        pid: 2 ** 31 - 1, // the host process is gone
        hostname: hostname(),
        platform: process.platform,
        wslDistro: process.env.WSL_DISTRO_NAME,
        agent: "claude",
        iterations: 5,
        inputs: "",
        version: "0.15.0",
      },
    });
    killed.close();
    const orphan = {
      runId: killed.runId,
      name: `ralph-${killed.runId}-i2-s0-a1`,
    };
    mocks.runningRunContainers.mockReturnValue([orphan]);

    await expect(runLoop(loopOptions(dirs))).resolves.toBe("refused");

    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.ensureImage).not.toHaveBeenCalled();
    expect(mocks.runStage).not.toHaveBeenCalled();
    expect(readStderr()).toContain(
      `[refused] run ${killed.runId} still has a running container (${orphan.name}); remove it: docker rm -f $(docker ps -aq --filter label=ralph.run=${killed.runId})`
    );
    expect(readRunLog(dirs.workspaceDir).view.ended).toMatchObject({
      reason: "refused",
      blockedBy: killed.runId,
    });
    expect(historyFiles(dirs.workspaceDir, ".md")).toEqual([]);
  });

  it("keeps only the newest 20 run logs", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    for (let k = 0; k < 22; k++) {
      openRunLog({
        workspaceDir: dirs.workspaceDir,
        bin: "afk",
        started: {
          pid: process.pid,
          hostname: hostname(),
          platform: process.platform,
          agent: "claude",
          iterations: 1,
          inputs: "",
          version: "0.15.0",
        },
        now: new Date(Date.UTC(2026, 0, 1, 0, 0, k)),
      }).append({ type: "run.ended", reason: "cap", completedIterations: 1 });
    }
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs));

    const left = historyFiles(dirs.workspaceDir, ".jsonl");
    expect(left).toHaveLength(20);
    expect(left[0]).toBe("2026-01-01-000003-afk.jsonl");
    expect(readRunLog(dirs.workspaceDir).view.ended?.reason).toBe(
      "no-more-tasks"
    );
  });

  it("records the sandbox-install findings on run.ended", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    makeSandboxInstall(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs));

    expect(readRunLog(dirs.workspaceDir).view.ended?.findings).toEqual([
      "node_modules/.modules.yaml storeDir: /home/agent/workspace/.pnpm-store/v3",
    ]);
  });

  it("injects the previous run's history into the next implementer prompt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 8, 12, 0, 0)));
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "<history>\n{{ HISTORY }}\n</history>\nrun {{ INPUTS }}",
      "utf8"
    );

    mocks.runStage
      .mockResolvedValueOnce(ok("FIRST-RUN-MARKER did the work"))
      .mockResolvedValue(ok(sentinel));

    // Run 1: implementer text is not the sentinel → runs to the cap, one 'ok' entry.
    await runLoop(
      loopOptions(dirs, {
        stages: [impl] as [Stage],
        iterations: 1,
        bin: "ralph-afk",
      })
    );

    // A distinct UTC second yields a distinct history filename, so run 1's file
    // is not overwritten by run 2's fresh header.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 8, 12, 0, 1)));

    // Run 2: implementer returns the sentinel and exits after the one stage.
    await runLoop(
      loopOptions(dirs, {
        stages: [impl] as [Stage],
        iterations: 1,
        bin: "ralph-afk",
      })
    );

    const secondRunPrompt = String(mocks.runStage.mock.calls.at(-1)![1]);
    expect(secondRunPrompt).toContain("<history>");
    expect(secondRunPrompt).toContain("FIRST-RUN-MARKER did the work");
    vi.useRealTimers();
  });

  it("does not inject history into the reviewer prompt", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "<history>\n{{ HISTORY }}\n</history>",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review {{ INPUTS }}",
      "utf8"
    );
    // Implementer neither hits the sentinel nor leaves HEAD unchanged, so the
    // reviewer stage also runs.
    makeDirtyRepo(dirs.workspaceDir);
    mocks.runStage
      .mockImplementationOnce(() => {
        commitInWorkspace(dirs.workspaceDir, "impl.txt");
        return Promise.resolve(ok("working"));
      })
      .mockResolvedValue(ok("working"));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        iterations: 1,
      })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    const reviewerPrompt = String(mocks.runStage.mock.calls[1]![1]);
    expect(reviewerPrompt).not.toContain("<history>");
  });

  it("records the reviewer verdict and stage meta in the history entry", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    // Implementer neither hits the sentinel nor leaves HEAD unchanged → the
    // reviewer stage also runs.
    makeDirtyRepo(dirs.workspaceDir);
    mocks.runStage
      .mockImplementationOnce(() => {
        commitInWorkspace(dirs.workspaceDir, "impl.txt");
        return Promise.resolve({
          text: "did work",
          meta: { turns: 8, costUsd: 0.6 },
        });
      })
      .mockResolvedValueOnce({ text: "<review>OK</review>", meta: {} });

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
      })
    );

    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · ok · ");
    expect(text).toContain("· 8 turns · $0.60 · HEAD");
    expect(text).toContain("## iter 1/1 · reviewer · review-ok · ");
  });

  it("skips the reviewer when the implementer left HEAD unchanged", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    makeDirtyRepo(dirs.workspaceDir);
    // The implementer commits nothing, so the reviewer has nothing to review.
    mocks.runStage.mockResolvedValue(ok("looked around, changed nothing"));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
      })
    );

    const head = headOf(dirs.workspaceDir);
    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · ok · ");
    expect(text).toContain(
      `## iter 1/1 · reviewer · skipped · 0s · HEAD ${head}`
    );
    expect(text).toContain("log: -");
    const stderr = (
      process.stderr.write as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(stderr).toContain(`skipped · HEAD unchanged (${head})`);
  });

  it("runs the reviewer when the implementer moved HEAD", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    makeDirtyRepo(dirs.workspaceDir);
    mocks.runStage
      .mockImplementationOnce(() => {
        commitInWorkspace(dirs.workspaceDir, "impl.txt");
        return Promise.resolve(ok("did work"));
      })
      .mockResolvedValueOnce(ok("<review>OK</review>"));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
      })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · reviewer · review-ok · ");
    expect(text).not.toContain("· skipped ·");
  });

  it("skips the reviewer in a workspace without git", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    // No repo: HEAD reads `-` on both sides, which counts as unchanged.
    mocks.runStage.mockResolvedValue(ok("working"));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
      })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    expect(readHistory(dirs.workspaceDir)).toContain(
      "## iter 1/1 · reviewer · skipped · 0s · HEAD -"
    );
  });

  it("carries the dirty-tree snapshot on the skipped entry", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    // The implementer commits nothing but leaves `wip.txt` behind.
    makeDirtyRepo(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(
      ok("started something, committed nothing")
    );

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
      })
    );

    const skipped = readHistory(dirs.workspaceDir).split(
      "## iter 1/1 · reviewer · skipped ·"
    )[1];
    expect(skipped).toContain("dirty: 1 files — wip.txt");
  });

  it("adds no dirty line to the skipped entry in a clean workspace", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    makeCleanRepo(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok("looked around, changed nothing"));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
      })
    );

    const skipped = readHistory(dirs.workspaceDir).split(
      "## iter 1/1 · reviewer · skipped ·"
    )[1];
    expect(skipped).toContain("log: -");
    expect(skipped).not.toContain("dirty:");
  });

  it("shows the skipped entry and its dirty line to the next implementer", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "<history>\n{{ HISTORY }}\n</history>",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    makeDirtyRepo(dirs.workspaceDir);
    mocks.runStage
      // Iteration 1: nothing committed → the reviewer is skipped.
      .mockResolvedValueOnce(ok("left it uncommitted"))
      // Iteration 2: the implementer lands work, so the reviewer runs.
      .mockImplementationOnce(() => {
        commitInWorkspace(dirs.workspaceDir, "impl.txt");
        return Promise.resolve(ok("did work"));
      })
      .mockResolvedValueOnce(ok("<review>OK</review>"));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        iterations: 2,
        bin: "ralph-afk",
      })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(3);
    const secondImplPrompt = String(mocks.runStage.mock.calls[1]![1]);
    expect(secondImplPrompt).toContain("reviewer · skipped");
    expect(secondImplPrompt).toContain("dirty: 1 files — wip.txt");
    expect(readHistory(dirs.workspaceDir)).toContain(
      "## iter 2/2 · reviewer · review-ok · "
    );
  });

  it("writes no skipped entry when the gate emits the sentinel", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    makeDirtyRepo(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
      })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    const text = readHistory(dirs.workspaceDir);
    expect(text).not.toContain("· skipped ·");
    expect(text).toMatch(/--- ended · 1\/1 iterations · no-more-tasks/);
  });

  it("writes no skipped entry when the gate stage fails", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    makeDirtyRepo(dirs.workspaceDir);
    // A failed gate breaks out of the iteration before the skip decision, so
    // the `failed` entry stays the iteration's last one.
    mocks.runStage.mockRejectedValue(new Error("boom"));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        bin: "ralph-afk",
        maxRetries: 0,
      })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · failed · ");
    expect(text).not.toContain("· skipped ·");
    expect(text).toMatch(/--- ended · 1\/1 iterations · failed/);
  });

  it("records an error status when the provider reports an error", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    // Text would otherwise read 'ok', but the error signal wins.
    mocks.runStage.mockResolvedValue({
      text: "looks fine",
      meta: { isError: true, apiErrorStatus: 429 },
    });

    await runLoop(loopOptions(dirs, { bin: "ralph-afk" }));

    const text = readHistory(dirs.workspaceDir);
    expect(text).toContain("## iter 1/1 · implementer · error · ");
    // The loop still advances to the iteration cap exactly as before.
    expect(text).toMatch(/--- ended · 1\/1 iterations · cap/);
  });

  it("warns and keeps iterating when the gate only mentions the sentinel", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    makeCleanRepo(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok(mention));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        iterations: 2,
        bin: "ralph-afk",
      })
    );

    const text = readHistory(dirs.workspaceDir);
    expect(text).toMatch(/--- ended · 2\/2 iterations · cap/);
    expect(text).toContain("## iter 1/2 · implementer · ok · ");
    expect(text).toContain("## iter 2/2 · implementer · ok · ");
    expect(text).toContain("## iter 1/2 · reviewer · skipped · ");
    expect(text).toContain("## iter 2/2 · reviewer · skipped · ");
    const stderr = readStderr();
    for (const i of [1, 2]) {
      expect(stderr).toContain(
        `[warning] iteration ${i}: the gate mentioned ${sentinel} without emitting it on a line of its own; the loop continues`
      );
    }
  });

  it("ends the run when the sentinel closes a Done / Blocked / Next message", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const impl: Stage = { name: "implementer", template: "impl.md" };
    const rev: Stage = { name: "reviewer", template: "rev.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "impl.md"),
      "impl",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "rev.md"),
      "review",
      "utf8"
    );
    makeCleanRepo(dirs.workspaceDir);
    mocks.runStage.mockResolvedValue(ok(emission));

    await runLoop(
      loopOptions(dirs, {
        stages: [impl, rev] as [Stage, Stage],
        iterations: 2,
        bin: "ralph-afk",
      })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    const text = readHistory(dirs.workspaceDir);
    expect(text).toMatch(/--- ended · 1\/2 iterations · no-more-tasks/);
    expect(readStderr()).not.toContain("[warning] iteration");
  });
});

describe("hasSentinel", () => {
  it("accepts the sentinel on a line of its own", () => {
    expect(hasSentinel(sentinel)).toBe(true);
    expect(hasSentinel(`\n  ${sentinel}  \n`)).toBe(true);
    expect(hasSentinel(`shipped nothing\n\n\`${sentinel}\`\n`)).toBe(true);
    expect(hasSentinel(emission)).toBe(true);
  });

  it("rejects a mention that shares its line with other words", () => {
    expect(hasSentinel(mention)).toBe(false);
    expect(hasSentinel(`${sentinel} — nothing left`)).toBe(false);
    expect(hasSentinel("still working")).toBe(false);
  });
});

describe("deriveStatus", () => {
  const clean = { headBefore: "-", headAfter: "-" };

  it("judges the gate by the completion sentinel", () => {
    expect(
      deriveStatus({ isGate: true, text: sentinel, meta: {}, ...clean })
    ).toBe("no-more-tasks");
    expect(
      deriveStatus({ isGate: true, text: "still working", meta: {}, ...clean })
    ).toBe("ok");
  });

  it("reads a prose mention of the sentinel as an ordinary gate turn", () => {
    expect(
      deriveStatus({ isGate: true, text: mention, meta: {}, ...clean })
    ).toBe("ok");
  });

  it("judges the reviewer by its verdict tag, then by HEAD movement", () => {
    expect(
      deriveStatus({
        isGate: false,
        text: "<review>OK</review>",
        meta: {},
        ...clean,
      })
    ).toBe("review-ok");
    expect(
      deriveStatus({
        isGate: false,
        text: "<review>SKIP</review>",
        meta: {},
        ...clean,
      })
    ).toBe("review-skip");
    expect(
      deriveStatus({
        isGate: false,
        text: "committed a fix",
        meta: {},
        headBefore: "aaa1111",
        headAfter: "bbb2222",
      })
    ).toBe("review-fix");
    expect(
      deriveStatus({
        isGate: false,
        text: "nothing to change",
        meta: {},
        headBefore: "aaa1111",
        headAfter: "aaa1111",
      })
    ).toBe("ok");
  });

  it("lets a provider error win over any text-derived status", () => {
    expect(
      deriveStatus({
        isGate: true,
        text: "still working",
        meta: { isError: true },
        ...clean,
      })
    ).toBe("error");
    expect(
      deriveStatus({
        isGate: false,
        text: "<review>OK</review>",
        meta: { apiErrorStatus: 429 },
        ...clean,
      })
    ).toBe("error");
  });
});
