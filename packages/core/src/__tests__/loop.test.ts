import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
}));

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

import { deriveStatus, runLoop } from "../loop.js";

const stage: Stage = { name: "implementer", template: "stage.md" };
const sentinel = "<promise>NO MORE TASKS</promise>";

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

function readHistory(workspaceDir: string): string {
  const dir = join(workspaceDir, ".ralph", "history");
  const md = readdirSync(dir).find((f) => f.endsWith(".md"));
  return readFileSync(join(dir, md!), "utf8");
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
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
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

    await loop; // let the aborted stage's rejection settle
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
    // the `current` slot is empty, so the handler records nothing.
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
    expect(existsSync(join(dirs.workspaceDir, ".ralph"))).toBe(false);

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
    expect(existsSync(join(dirs.workspaceDir, ".ralph"))).toBe(false);
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
