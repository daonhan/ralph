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
  openRunLog,
  reduceRunLog,
  type RunEvent,
  type RunLog,
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
      view: { entries: [] },
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
