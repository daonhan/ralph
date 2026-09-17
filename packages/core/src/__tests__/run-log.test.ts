import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  STALE_AFTER_MS,
  findLiveRun,
  openRunLog,
  pidAlive,
  pidIsNode,
  pruneRunLogs,
  reduceRunLog,
  runLiveness,
  type LivenessProbe,
  type RunEvent,
  type RunLog,
  type RunView,
} from "../run-log.js";

const roots: string[] = [];
const logs: RunLog[] = [];

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-run-log-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  // Close before removing: Windows refuses to delete a file with an open handle.
  while (logs.length > 0) logs.pop()!.close();
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

const now = new Date(Date.UTC(2026, 8, 17, 10, 15, 0));

const started = {
  pid: 4242,
  hostname: "box",
  platform: "win32",
  agent: "claude",
  iterations: 3,
  inputs: "plan",
  version: "0.15.0",
};

function open(workspaceDir: string, at = now): RunLog {
  const log = openRunLog({ workspaceDir, bin: "afk", started, now: at });
  logs.push(log);
  return log;
}

const stageStarted: RunEvent = {
  type: "stage.started",
  iteration: 1,
  stageIndex: 0,
  stage: "implementer",
  logPath: ".ralph-tmp/logs/a.ndjson",
};

const stageCompleted: RunEvent = {
  type: "stage.completed",
  iteration: 1,
  stage: "implementer",
  status: "ok",
  durationMs: 5_000,
  head: "abc1234",
  logPath: ".ralph-tmp/logs/a.ndjson",
  body: "did the thing",
};

/** A syntactically valid log line with the given envelope and fields. */
function line(seq: number, type: string, fields: object = {}): string {
  return `${JSON.stringify({ v: 1, seq, at: "2026-09-17T10:15:00.000Z", type, ...fields })}\n`;
}

/** `run.started` as the reducer requires it, for hand-built logs. */
const startedLine = line(1, "run.started", {
  runId: "r",
  bin: "afk",
  ...started,
});

describe("openRunLog", () => {
  it("names the log after the run, writes the .gitignore and run.started", () => {
    const ws = makeWorkspace();
    const log = open(ws);

    const dir = join(ws, ".ralph", "history");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
    expect(basename(log.filePath)).toBe("2026-09-17-101500-afk.jsonl");
    expect(log.runId).toBe("2026-09-17-101500-afk");

    const { events, truncated } = reduceRunLog(
      readFileSync(log.filePath, "utf8")
    );
    expect(truncated).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      v: 1,
      seq: 1,
      type: "run.started",
      runId: "2026-09-17-101500-afk",
      bin: "afk",
      pid: 4242,
      inputs: "plan",
    });
  });

  it("takes the next free second when a run already owns the name", () => {
    const ws = makeWorkspace();
    const first = open(ws);
    const second = open(ws);

    expect(basename(first.filePath)).toBe("2026-09-17-101500-afk.jsonl");
    expect(basename(second.filePath)).toBe("2026-09-17-101501-afk.jsonl");
    // Name order is run order, so "newest by name" still finds the second run.
    const names = readdirSync(join(ws, ".ralph", "history"))
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    expect(names.at(-1)).toBe(basename(second.filePath));
  });

  it("numbers records in order and folds them into the in-memory view", () => {
    const log = open(makeWorkspace());
    log.append(stageStarted);
    expect(log.view.stage).toMatchObject({ name: "implementer", index: 0 });

    log.append(stageCompleted);
    expect(log.view.stage).toBeUndefined();
    expect(log.view.entries).toEqual([
      {
        iteration: 1,
        stage: "implementer",
        status: "ok",
        durationMs: 5_000,
        head: "abc1234",
        logPath: ".ralph-tmp/logs/a.ndjson",
        body: "did the thing",
      },
    ]);

    const { events, view } = reduceRunLog(readFileSync(log.filePath, "utf8"));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    // The view rebuilt from disk is the view the writer kept.
    expect(view).toEqual(log.view);
  });

  it("closes on run.ended and ignores later appends", () => {
    const log = open(makeWorkspace());
    log.append({ type: "run.ended", reason: "cap", completedIterations: 3 });
    const text = readFileSync(log.filePath, "utf8");

    log.append(stageStarted);

    expect(readFileSync(log.filePath, "utf8")).toBe(text);
    const { view, truncated } = reduceRunLog(text);
    expect(truncated).toBe(false);
    expect(view.ended).toMatchObject({ reason: "cap", completedIterations: 3 });
  });
});

describe("reduceRunLog", () => {
  it("reads an empty log as no run at all", () => {
    expect(reduceRunLog("")).toEqual({
      events: [],
      view: { entries: [], statusCounts: {} },
      truncated: false,
    });
  });

  it("stops at a torn final record and keeps everything before it", () => {
    const torn = line(2, "stage.started", stageStarted).slice(0, 30);
    const { events, truncated } = reduceRunLog(startedLine + torn);
    expect(truncated).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["run.started"]);
  });

  it("stops at an unparseable interior line", () => {
    const text =
      startedLine + "{not json\n" + line(3, "stage.started", stageStarted);
    const { events, truncated } = reduceRunLog(text);
    expect(truncated).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("stops at a seq gap", () => {
    const text = startedLine + line(3, "stage.started", stageStarted);
    expect(reduceRunLog(text)).toMatchObject({ truncated: true });
    expect(reduceRunLog(text).events).toHaveLength(1);
  });

  it("stops at a record from another schema version", () => {
    const text =
      startedLine +
      JSON.stringify({ ...JSON.parse(line(2, "heartbeat")), v: 2 }) +
      "\n";
    expect(reduceRunLog(text)).toMatchObject({ truncated: true });
  });

  it("stops at a known event missing a required field", () => {
    const text = startedLine + line(2, "stage.started", { iteration: 1 });
    expect(reduceRunLog(text)).toMatchObject({ truncated: true });
  });

  it("requires run.started first and only first", () => {
    expect(reduceRunLog(line(1, "stage.started", stageStarted))).toMatchObject({
      events: [],
      truncated: true,
    });
    expect(
      reduceRunLog(startedLine + line(2, "run.started", { ...started }))
        .truncated
    ).toBe(true);
  });

  it("stops at a record after run.ended", () => {
    const text =
      startedLine +
      line(2, "run.ended", { reason: "cap", completedIterations: 1 }) +
      line(3, "stage.started", stageStarted);
    const { events, truncated } = reduceRunLog(text);
    expect(truncated).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("skips unknown event types without stopping", () => {
    const text =
      startedLine +
      line(2, "future.event", { anything: true }) +
      line(3, "stage.started", stageStarted);
    const { events, view, truncated } = reduceRunLog(text);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(3);
    expect(view.stage).toMatchObject({ name: "implementer" });
  });

  it("keeps the last retry on the open stage", () => {
    const text =
      startedLine +
      line(2, "stage.started", stageStarted) +
      line(3, "stage.retry", {
        iteration: 1,
        stage: "implementer",
        attempt: 1,
        error: "429",
        backoffMs: 5_000,
      });
    expect(reduceRunLog(text).view.stage?.retry).toEqual({
      attempt: 1,
      at: "2026-09-17T10:15:00.000Z",
      backoffMs: 5_000,
    });
  });

  it("reads a real log written through the writer", () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, ".ralph", "history"), { recursive: true });
    writeFileSync(join(ws, ".ralph", "history", ".gitignore"), "x\n", "utf8");
    const log = open(ws);
    log.append(stageStarted);
    log.append({
      type: "stage.retry",
      iteration: 1,
      stage: "implementer",
      attempt: 1,
      error: "boom",
      backoffMs: 5_000,
    });
    log.append(stageCompleted);
    log.append({
      type: "run.ended",
      reason: "no-more-tasks",
      completedIterations: 1,
    });

    // The existing .gitignore is left alone.
    expect(
      readFileSync(join(ws, ".ralph", "history", ".gitignore"), "utf8")
    ).toBe("x\n");
    const { events, truncated } = reduceRunLog(
      readFileSync(log.filePath, "utf8")
    );
    expect(truncated).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "stage.started",
      "stage.retry",
      "stage.completed",
      "run.ended",
    ]);
  });
});

describe("statusCounts", () => {
  it("counts completed stages per status", () => {
    const log = open(makeWorkspace());
    log.append(stageCompleted);
    log.append({ ...stageCompleted, status: "failed" } as RunEvent);
    log.append({ ...stageCompleted, iteration: 2 } as RunEvent);
    expect(log.view.statusCounts).toEqual({ ok: 2, failed: 1 });
  });
});

/** A probe for host "box" / win32 where only the pids in `alive` run, all node. */
function probe(alive: number[] = [], overrides: Partial<LivenessProbe> = {}) {
  return {
    now: Date.UTC(2026, 8, 17, 12, 0, 0),
    hostname: "box",
    platform: "win32",
    isAlive: (pid: number) => alive.includes(pid),
    isNode: () => true,
    ...overrides,
  } satisfies LivenessProbe;
}

/** The view of a run started on host "box" / win32 with `pid`. */
function viewOf(
  pid: number,
  fields: Partial<RunView["started"]> = {}
): RunView {
  return {
    entries: [],
    statusCounts: {},
    started: {
      type: "run.started",
      at: "2026-09-17T11:00:00.000Z",
      runId: "r",
      pid,
      hostname: "box",
      platform: "win32",
      bin: "ghafk",
      agent: "claude",
      iterations: 5,
      inputs: "",
      version: "0.15.0",
      ...fields,
    },
  };
}

describe("runLiveness", () => {
  const recent = Date.UTC(2026, 8, 17, 11, 59, 0);
  const stale = Date.UTC(2026, 8, 17, 11, 0, 0);

  it("reads a logged run.ended as ended, whatever the pid", () => {
    const view: RunView = {
      ...viewOf(7),
      ended: {
        type: "run.ended",
        at: "2026-09-17T11:30:00.000Z",
        reason: "cap",
        completedIterations: 5,
      },
    };
    expect(runLiveness(view, recent, probe([7]))).toBe("ended");
  });

  it("reads a log without a readable run.started as dead", () => {
    expect(
      runLiveness({ entries: [], statusCounts: {} }, recent, probe())
    ).toBe("dead");
  });

  it("on the same host, a live node pid is live even with a stale log", () => {
    expect(runLiveness(viewOf(7), stale, probe([7]))).toBe("live");
  });

  it("on the same host, a gone pid is dead even with a fresh log", () => {
    expect(runLiveness(viewOf(7), recent, probe([]))).toBe("dead");
  });

  it("on the same host, a pid reused by another program is dead", () => {
    expect(
      runLiveness(viewOf(7), recent, probe([7], { isNode: () => false }))
    ).toBe("dead");
  });

  it("from another platform or WSL distro, only the log's age decides", () => {
    const wsl = viewOf(7, { platform: "linux", wslDistro: "Ubuntu" });
    // The pid means nothing across pid spaces, so it is never probed.
    const blind = probe([], {
      isAlive: () => {
        throw new Error("probed a foreign pid");
      },
    });
    expect(runLiveness(wsl, recent, blind)).toBe("live");
    expect(runLiveness(wsl, stale, blind)).toBe("dead");
    expect(
      runLiveness(viewOf(7, { wslDistro: "Ubuntu" }), blind.now, blind)
    ).toBe("live");
    expect(
      runLiveness(
        viewOf(7, { hostname: "other" }),
        blind.now - STALE_AFTER_MS,
        blind
      )
    ).toBe("dead");
  });
});

describe("pidAlive / pidIsNode", () => {
  it("sees this node process as alive and node", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidIsNode(process.pid)).toBe(true);
  });

  it("rejects pids that cannot name a process", () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(Number.NaN)).toBe(false);
  });

  it("sees an exited process as gone", async () => {
    const child = spawn(process.execPath, ["-e", ""]);
    await once(child, "exit");
    expect(pidAlive(child.pid!)).toBe(false);
  });

  it("tells a running non-node process apart from node", async () => {
    const child =
      process.platform === "win32"
        ? spawn("ping", ["-n", "30", "127.0.0.1"], { windowsHide: true })
        : spawn("sleep", ["30"]);
    try {
      await once(child, "spawn");
      expect(pidAlive(child.pid!)).toBe(true);
      expect(pidIsNode(child.pid!)).toBe(false);
    } finally {
      child.kill();
    }
  });
});

describe("findLiveRun", () => {
  /** A run on host "box" / win32 with `pid`, left open unless `end` is set. */
  function run(ws: string, second: number, pid: number, end = false): RunLog {
    const log = openRunLog({
      workspaceDir: ws,
      bin: "ghafk",
      started: { ...started, pid },
      now: new Date(Date.UTC(2026, 8, 17, 10, 0, second)),
    });
    logs.push(log);
    if (end) {
      log.append({ type: "run.ended", reason: "cap", completedIterations: 1 });
    }
    return log;
  }

  const historyDir = (ws: string) => join(ws, ".ralph", "history");

  it("finds a live older run behind ended, dead and torn newer logs", () => {
    const ws = makeWorkspace();
    const live = run(ws, 0, 101);
    run(ws, 1, 102, true); // ended
    run(ws, 2, 103); // no run.ended, but its pid is gone
    writeFileSync(join(historyDir(ws), "2026-09-17-100003-ghafk.jsonl"), "{");
    const self = run(ws, 4, 104);

    const found = findLiveRun(historyDir(ws), self.runId, probe([101, 104]));

    expect(found?.runId).toBe(live.runId);
    expect(found?.view.started?.pid).toBe(101);
  });

  it("never counts the caller's own run", () => {
    const ws = makeWorkspace();
    const self = run(ws, 0, 104);
    expect(
      findLiveRun(historyDir(ws), self.runId, probe([104]))
    ).toBeUndefined();
  });

  it("lets two runs racing each other both see the other", () => {
    const ws = makeWorkspace();
    const a = run(ws, 0, 201);
    const b = run(ws, 0, 202);
    const racing = probe([201, 202]);

    expect(findLiveRun(historyDir(ws), a.runId, racing)?.runId).toBe(b.runId);
    expect(findLiveRun(historyDir(ws), b.runId, racing)?.runId).toBe(a.runId);
  });

  it("finds nothing in a missing history dir", () => {
    expect(
      findLiveRun(join(makeWorkspace(), "nope"), "x", probe())
    ).toBeUndefined();
  });
});

describe("pruneRunLogs", () => {
  it("keeps only the newest logs and never touches Markdown history", () => {
    const dir = join(makeWorkspace(), ".ralph", "history");
    mkdirSync(dir, { recursive: true });
    const names = Array.from(
      { length: 23 },
      (_, k) => `2026-09-17-10${String(k).padStart(2, "0")}00-ghafk`
    );
    for (const name of names) {
      writeFileSync(join(dir, `${name}.jsonl`), startedLine);
      writeFileSync(join(dir, `${name}.md`), "# run\n");
    }

    pruneRunLogs(dir, 20);

    const left = readdirSync(dir);
    expect(left.filter((f) => f.endsWith(".jsonl")).sort()).toEqual(
      names.slice(3).map((n) => `${n}.jsonl`)
    );
    expect(left.filter((f) => f.endsWith(".md"))).toHaveLength(23);
  });
});
