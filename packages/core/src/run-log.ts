import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
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
  "no-more-tasks" | "cap" | "failed" | "aborted" | "error";

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
};

export type StageRetry = {
  type: "stage.retry";
  iteration: number;
  stage: string;
  /** The failed attempt (1-based); the next one starts after `backoffMs`. */
  attempt: number;
  error: string;
  backoffMs: number;
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
    retry?: { attempt: number; at: string; backoffMs: number };
  };
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  /** From the latest heartbeat: when the agent last wrote to stdout, if ever. */
  lastOutputAt?: string | null;
  entries: StageEntry[];
  ended?: RunEnded & { at: string };
};

export function emptyRunView(): RunView {
  return { entries: [] };
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
      };
      break;
    case "stage.retry":
      if (next.stage) {
        next.stage = {
          ...next.stage,
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
  },
  "stage.retry": {
    iteration: "number",
    stage: "string",
    attempt: "number",
    error: "string",
    backoffMs: "number",
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
   * Write one record, fsync it, then fold it into the view. Throws when the write
   * fails; a no-op once the log is closed. `run.ended` closes the log.
   */
  append(event: RunEvent): void;
  close(): void;
}

/** How many seconds past `now` to try before giving up on a free file name. */
const MAX_NAME_TRIES = 60;

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

  const log: RunLog = {
    filePath,
    runId,
    get view() {
      return view;
    },
    append(event: RunEvent): void {
      if (closed) return;
      const record = {
        v: RUN_LOG_VERSION,
        seq: seq + 1,
        at: new Date().toISOString(),
        ...event,
      } as RunRecord;
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
      seq = record.seq;
      view = applyEvent(view, record);
      if (event.type === "run.ended") log.close();
    },
    close(): void {
      if (closed) return;
      closed = true;
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
