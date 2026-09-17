import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import {
  currentBranch,
  fileTimestamp,
  historyBaseName,
  sanitizeBranch,
  type StageEntry,
} from "./history.js";

// Harness-owned, append-only event log for one run, beside its Markdown history:
// <workspace>/.ralph/history/<base>.jsonl. One JSON record per line, numbered by
// `seq` and fsynced before the loop acts on it, so a supervisor reading the file
// never sees a step the log does not hold. The log is the durable state;
// `reduceRunLog` folds it into a disposable RunView. Schema and reader rules:
// docs/ARCHITECTURE.md § Run event log. Everything here is synchronous — the loop
// opens the log before its first await.

export const RUN_LOG_VERSION = 1;

export type RunEndReason =
  "no-more-tasks" | "cap" | "failed" | "aborted" | "error" | "refused";

export type RunStarted = {
  type: "run.started";
  /** The log's base name, shared with the `.md` history. */
  runId: string;
  pid: number;
  hostname: string;
  platform: string;
  /** `$WSL_DISTRO_NAME`: WSL and Windows share a hostname but not a pid space. */
  wslDistro?: string;
  /** Short bin name: `afk` / `ghafk`. */
  bin: string;
  agent: string;
  iterations: number;
  inputs: string;
  branch?: string;
  /** `@daonhan/ralph-core` version. */
  version: string;
};

export type StageStarted = {
  type: "stage.started";
  iteration: number;
  stageIndex: number;
  stage: string;
  logPath: string;
  /** The first attempt's `docker run --name`; the run is labelled `ralph.run=<runId>`. */
  container: string;
};

export type StageRetry = {
  type: "stage.retry";
  iteration: number;
  stage: string;
  /** The failed attempt (1-based); the next one starts after `backoffMs`. */
  attempt: number;
  error: string;
  backoffMs: number;
  /** The next attempt's container name. */
  container: string;
};

export type StageCompleted = { type: "stage.completed" } & StageEntry;

/** Written every {@link HEARTBEAT_MS} while the run is open, stage or not. */
export type Heartbeat = {
  type: "heartbeat";
  /** When the agent last wrote a record to stdout; null before its first one. */
  lastOutputAt: string | null;
};

export const HEARTBEAT_MS = 30_000;

export type RunEnded = {
  type: "run.ended";
  reason: RunEndReason;
  completedIterations: number;
  signal?: "SIGINT" | "SIGTERM";
  /** For `refused`: the runId of the live run that blocked this launch. */
  blockedBy?: string;
  /** The host check's sandbox-install findings, when any. */
  findings?: string[];
  error?: string;
};

export type RunEvent =
  | RunStarted
  | StageStarted
  | StageRetry
  | StageCompleted
  | Heartbeat
  | RunEnded;

/** One log line: an event plus the envelope the writer stamps on it. */
export type RunRecord = RunEvent & { v: number; seq: number; at: string };

/** The run as of its last event. Disposable: rebuild it with {@link reduceRunLog}. */
export type RunView = {
  started?: RunStarted & { at: string };
  /** The stage in flight: set by `stage.started`, cleared by `stage.completed`. */
  stage?: {
    iteration: number;
    index: number;
    name: string;
    startedAt: string;
    logPath: string;
    /** The current attempt's container: the next one's once a retry is logged. */
    container: string;
    retry?: { attempt: number; at: string; backoffMs: number };
  };
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  /** From the latest heartbeat: when the agent last wrote to stdout, if ever. */
  lastOutputAt?: string | null;
  entries: StageEntry[];
  /**
   * Completed stages per status. The end reason only reflects the last
   * iteration, so a mid-run `failed` or `error` shows up here.
   */
  statusCounts: Record<string, number>;
  ended?: RunEnded & { at: string };
};

export function emptyRunView(): RunView {
  return { entries: [], statusCounts: {} };
}

/** Fold one record into the view. Pure; unknown event types leave it unchanged. */
export function applyEvent(view: RunView, record: RunRecord): RunView {
  const next: RunView = { ...view, lastEventAt: record.at };
  switch (record.type) {
    case "run.started": {
      const { v: _v, seq: _seq, ...started } = record;
      next.started = started;
      break;
    }
    case "stage.started":
      next.stage = {
        iteration: record.iteration,
        index: record.stageIndex,
        name: record.stage,
        startedAt: record.at,
        logPath: record.logPath,
        container: record.container,
      };
      break;
    case "stage.retry":
      if (next.stage) {
        next.stage = {
          ...next.stage,
          container: record.container,
          retry: {
            attempt: record.attempt,
            at: record.at,
            backoffMs: record.backoffMs,
          },
        };
      }
      break;
    case "stage.completed": {
      const { v: _v, seq: _seq, at: _at, type: _type, ...entry } = record;
      next.entries = [...view.entries, entry];
      next.statusCounts = {
        ...view.statusCounts,
        [entry.status]: (view.statusCounts[entry.status] ?? 0) + 1,
      };
      next.stage = undefined;
      break;
    }
    case "heartbeat":
      next.lastHeartbeatAt = record.at;
      next.lastOutputAt = record.lastOutputAt;
      break;
    case "run.ended": {
      const { v: _v, seq: _seq, ...ended } = record;
      next.ended = ended;
      next.stage = undefined;
      break;
    }
  }
  return next;
}

/** Required fields per known event type; unknown types only need the envelope. */
const REQUIRED: Record<
  string,
  Record<string, "string" | "number" | "string-or-null">
> = {
  "run.started": {
    runId: "string",
    pid: "number",
    hostname: "string",
    platform: "string",
    bin: "string",
    agent: "string",
    iterations: "number",
    inputs: "string",
    version: "string",
  },
  "stage.started": {
    iteration: "number",
    stageIndex: "number",
    stage: "string",
    logPath: "string",
    container: "string",
  },
  "stage.retry": {
    iteration: "number",
    stage: "string",
    attempt: "number",
    error: "string",
    backoffMs: "number",
    container: "string",
  },
  "stage.completed": {
    iteration: "number",
    stage: "string",
    status: "string",
    durationMs: "number",
    head: "string",
    logPath: "string",
    body: "string",
  },
  heartbeat: { lastOutputAt: "string-or-null" },
  "run.ended": { reason: "string", completedIterations: "number" },
};

/**
 * Parse and validate one complete line as the record at `seq`, or `undefined`
 * when it is not one: bad JSON, another schema version, a `seq` gap, a missing
 * required field, `run.started` anywhere but first, or anything after
 * `run.ended`.
 */
function parseRecord(
  line: string,
  seq: number,
  view: RunView
): RunRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    r.v !== RUN_LOG_VERSION ||
    r.seq !== seq ||
    typeof r.at !== "string" ||
    typeof r.type !== "string" ||
    view.ended !== undefined ||
    (seq === 1) !== (r.type === "run.started")
  ) {
    return undefined;
  }
  const fields = REQUIRED[r.type] ?? {};
  for (const [name, kind] of Object.entries(fields)) {
    const value = r[name];
    const ok =
      kind === "string-or-null"
        ? value === null || typeof value === "string"
        : typeof value === kind;
    if (!ok) return undefined;
  }
  return r as RunRecord;
}

/**
 * Fold a log's text into its records and view. Folding stops at the first line
 * that is torn (no trailing newline) or invalid (see {@link parseRecord}), and
 * `truncated` reports that it did; everything before that line still counts.
 */
export function reduceRunLog(text: string): {
  events: RunRecord[];
  view: RunView;
  truncated: boolean;
} {
  const events: RunRecord[] = [];
  let view = emptyRunView();
  const lines = text.split("\n");
  // The piece after the last newline: empty for a complete log, torn otherwise.
  let truncated = lines.pop() !== "";
  for (const line of lines) {
    const record = parseRecord(line, events.length + 1, view);
    if (!record) {
      truncated = true;
      break;
    }
    events.push(record);
    view = applyEvent(view, record);
  }
  return { events, view, truncated };
}

export type OpenRunLogOptions = {
  workspaceDir: string;
  /** Short bin name: `afk` / `ghafk`. */
  bin: string;
  /** The `run.started` fields the caller knows; the log adds runId, bin, branch. */
  started: Omit<RunStarted, "type" | "runId" | "bin" | "branch">;
  now?: Date;
};

export interface RunLog {
  readonly filePath: string;
  readonly runId: string;
  /** The in-memory view, folded from every record appended so far. */
  readonly view: RunView;
  /**
   * Write one record, fold it into the view, then fsync it. Throws when the write
   * or the fsync fails; after a failed write every later append throws too. A
   * no-op once the log is closed. `run.ended` closes the log.
   */
  append(event: RunEvent): void;
  close(): void;
}

/** How many seconds past `now` to try before giving up on a free file name. */
const MAX_NAME_TRIES = 60;

/**
 * The runIds whose logs this process has open. A log carrying this process's
 * own pid is live only when it is one of these: otherwise the pid was a killed
 * run's, handed back to this launch.
 */
const openRunIds = new Set<string>();

/**
 * Open a run's event log and write its `run.started` record. Creates
 * `.ralph/history/` and its self-ignoring `.gitignore` (only when missing). The
 * file is created exclusively; when a run from the same UTC second already owns
 * the name, the next free second is taken instead of adding a suffix, so every
 * reader that picks the newest run by file name still sorts chronologically.
 */
export function openRunLog(opts: OpenRunLogOptions): RunLog {
  const { workspaceDir, bin, started, now = new Date() } = opts;

  const historyDir = join(workspaceDir, ".ralph", "history");
  mkdirSync(historyDir, { recursive: true });
  const gitignore = join(historyDir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", "utf8");

  const rawBranch = currentBranch(workspaceDir);
  const branch = rawBranch ? sanitizeBranch(rawBranch) : undefined;

  let fd = -1;
  let runId = "";
  let filePath = "";
  for (let k = 0; fd < 0; k++) {
    runId = historyBaseName(
      fileTimestamp(new Date(now.getTime() + k * 1000)),
      bin,
      branch
    );
    filePath = join(historyDir, `${runId}.jsonl`);
    try {
      fd = openSync(filePath, "wx", 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || k + 1 >= MAX_NAME_TRIES) throw err;
    }
  }

  let seq = 0;
  let view = emptyRunView();
  let closed = false;
  // Set when a write threw: part of the record may be on disk, and a reader
  // stops at that torn line, so nothing after it could ever be read.
  let broken = false;
  openRunIds.add(runId);

  const log: RunLog = {
    filePath,
    runId,
    get view() {
      return view;
    },
    append(event: RunEvent): void {
      if (closed) return;
      if (broken) {
        throw new Error(`run log ${filePath} is unusable after a failed write`);
      }
      const record = {
        v: RUN_LOG_VERSION,
        seq: seq + 1,
        at: new Date().toISOString(),
        ...event,
      } as RunRecord;
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`);
      } catch (err) {
        broken = true;
        throw err;
      }
      // The line is on disk: count it before the fsync, which may still throw,
      // so the next record never reuses its seq.
      seq = record.seq;
      view = applyEvent(view, record);
      try {
        fsyncSync(fd);
      } finally {
        if (event.type === "run.ended") log.close();
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      openRunIds.delete(runId);
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    },
  };

  try {
    log.append({ type: "run.started", runId, bin, branch, ...started });
  } catch (err) {
    log.close();
    throw err;
  }
  return log;
}

// --- Liveness: is another run of this workspace still going? ---

export type Liveness = "ended" | "live" | "dead";

/** Across hosts or platforms, a log untouched this long is taken for dead. */
export const STALE_AFTER_MS = 5 * 60_000;

/** What the reader knows about its own host, and how it probes a pid there. */
export type LivenessProbe = {
  now: number;
  hostname: string;
  platform: string;
  wslDistro?: string;
  /** The reader's own pid. */
  pid: number;
  /** Whether the reader itself has this run's log open. */
  ownsRun(runId: string): boolean;
  /** Whether a process with this pid exists. */
  isAlive(pid: number): boolean;
  /** Whether that process is node; true when the probe cannot tell. */
  isNode(pid: number): boolean;
};

/**
 * Judge a run from its view. `ended` once it logged `run.ended`; `dead` when it
 * never logged a readable `run.started`. On the host that started it the pid
 * decides — alive and still node means `live`, however old the last heartbeat,
 * because a hung run is still running; the reader's own pid means `live` only
 * for a log the reader has open. From another host or platform (WSL and
 * Windows share a hostname but not a pid space) only the file's age can:
 * `live` while it was written within {@link STALE_AFTER_MS}.
 */
export function runLiveness(
  view: RunView,
  mtimeMs: number,
  probe: LivenessProbe
): Liveness {
  if (view.ended) return "ended";
  const started = view.started;
  if (!started) return "dead";
  const sameHost =
    started.hostname === probe.hostname &&
    started.platform === probe.platform &&
    started.wslDistro === probe.wslDistro;
  if (sameHost) {
    if (started.pid === probe.pid) {
      return probe.ownsRun(started.runId) ? "live" : "dead";
    }
    return probe.isAlive(started.pid) && probe.isNode(started.pid)
      ? "live"
      : "dead";
  }
  return probe.now - mtimeMs < STALE_AFTER_MS ? "live" : "dead";
}

/** Whether a process with `pid` exists; EPERM (someone else's process) counts. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the process with `pid` is node, the guard against a dead run's pid
 * reused by something else. False only when the probe positively shows another
 * program or no process; any failure to probe, a timeout included, answers
 * true, erring toward refusing a second run.
 */
export function pidIsNode(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
          timeout: 10_000,
        }
      );
      // A match is one CSV row whose first field is the image name; no match
      // prints an INFO line instead.
      const row = out.split(/\r?\n/).find((l) => l.startsWith('"'));
      return (
        row !== undefined && row.split(",")[0].toLowerCase().includes("node")
      );
    }
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/comm`, "utf8").includes("node");
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return out.includes("node");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    // The process is gone: no /proc entry on Linux, or ps exiting 1 for no match.
    if (process.platform === "linux") return e.code !== "ENOENT";
    if (process.platform !== "win32") return e.status !== 1;
    return true;
  }
}

/** This host, probed for real. */
export function hostProbe(): LivenessProbe {
  return {
    now: Date.now(),
    hostname: hostname(),
    platform: process.platform,
    wslDistro: process.env.WSL_DISTRO_NAME,
    pid: process.pid,
    ownsRun: (runId) => openRunIds.has(runId),
    isAlive: pidAlive,
    isNode: pidIsNode,
  };
}

export type LiveRun = { runId: string; filePath: string; view: RunView };

/** The run logs in a history dir, oldest first (names sort chronologically). */
function runLogNames(historyDir: string): string[] {
  try {
    return readdirSync(historyDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Whether a log's first complete line is a record from a newer schema, which
 * this reader cannot fold. A torn first line proves nothing.
 */
function isNewerSchema(text: string): boolean {
  const end = text.indexOf("\n");
  if (end < 0) return false;
  try {
    const first: unknown = JSON.parse(text.slice(0, end));
    const v = (first as { v?: unknown } | null)?.v;
    return typeof v === "number" && v > RUN_LOG_VERSION;
  } catch {
    return false;
  }
}

/**
 * The first run, other than `selfRunId`, that is still live in `historyDir`.
 * Called after this run's own `run.started` is on disk, so two launches racing
 * each other both see the other and both refuse — never both proceed. Every log
 * is read, not only the newest: a torn or dead newer log must not hide a live
 * older one. A log from a newer schema has no view to judge, so it counts as
 * live while written within {@link STALE_AFTER_MS}. An unreadable log is
 * skipped.
 */
export function findLiveRun(
  historyDir: string,
  selfRunId: string,
  probe: LivenessProbe = hostProbe()
): LiveRun | undefined {
  for (const name of runLogNames(historyDir)) {
    const runId = name.slice(0, -".jsonl".length);
    if (runId === selfRunId) continue;
    const filePath = join(historyDir, name);
    try {
      const text = readFileSync(filePath, "utf8");
      const { view } = reduceRunLog(text);
      const mtimeMs = statSync(filePath).mtimeMs;
      const live =
        !view.started && isNewerSchema(text)
          ? probe.now - mtimeMs < STALE_AFTER_MS
          : runLiveness(view, mtimeMs, probe) === "live";
      if (live) return { runId, filePath, view };
    } catch {
      // Vanished or unreadable: nothing to judge.
    }
  }
  return undefined;
}

/** How many run logs a workspace keeps, the current run's included. */
export const RETAIN_RUN_LOGS = 20;

/** Whether a log ended in a refusal; an unreadable log did not. */
function isRefused(filePath: string): boolean {
  try {
    const { view } = reduceRunLog(readFileSync(filePath, "utf8"));
    return view.ended?.reason === "refused";
  } catch {
    return false;
  }
}

/**
 * Delete all but the newest `keep` run logs, counting only runs that were not
 * refused: a supervisor retrying exit 75 must not push the run it waited on out
 * of the directory. Of the refused launches only the newest is kept. The
 * caller's own log is never deleted, whatever its name. Everything else deleted
 * is older than the newest `keep` runs, so it has ended or died. Markdown
 * history is never touched. A log that cannot be deleted (say, open in a reader
 * on Windows) is left for the next run.
 */
export function pruneRunLogs(
  historyDir: string,
  selfRunId: string,
  keep = RETAIN_RUN_LOGS
): void {
  let keptRuns = 0;
  let keptRefused = false;
  for (const name of runLogNames(historyDir).reverse()) {
    const filePath = join(historyDir, name);
    if (isRefused(filePath)) {
      if (!keptRefused) {
        keptRefused = true;
        continue;
      }
    } else if (keptRuns < keep) {
      keptRuns++;
      continue;
    }
    if (name === `${selfRunId}.jsonl`) continue;
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Left for the next run.
    }
  }
}
