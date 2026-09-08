import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Harness-owned, per-run Markdown history under <workspace>/.ralph/history/.
// The loop driver — never the agent — writes here: a header when the run opens,
// one entry per completed stage, a footer on normal loop exit. Later slices add
// the tail loader (injected into the implementer prompt) and richer statuses;
// this module keeps its surface pure `fs` plus tolerant `git` reads so it never
// touches docker or the network.

const BRANCH_MAX = 40;

/**
 * Sanitize a git branch for use in a filename / header: every character outside
 * `[A-Za-z0-9._-]` becomes `-`, then the result is capped at 40 characters.
 */
export function sanitizeBranch(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, BRANCH_MAX);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Compact UTC stamp for the filename: `yyyy-MM-dd-HHmmss`. */
export function fileTimestamp(now: Date): string {
  return (
    `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}` +
    `-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`
  );
}

/** Readable UTC stamp for the run header. */
function displayTimestamp(now: Date): string {
  return (
    `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())} ` +
    `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}Z`
  );
}

/**
 * Format a stage duration as `<m>m<ss>s` (or `<s>s` under a minute), rounded to
 * whole seconds.
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${pad2(s)}s` : `${s}s`;
}

/**
 * The run file name: `<yyyy-MM-dd-HHmmss>-<bin>[-<branch>].md`. The branch (already
 * sanitized) is omitted with its separator when unknown (no git / detached HEAD).
 */
export function historyFileName(
  ts: string,
  bin: string,
  branch: string | undefined
): string {
  return branch ? `${ts}-${bin}-${branch}.md` : `${ts}-${bin}.md`;
}

/**
 * Current git branch for `cwd`, or `undefined` outside a repo or on a detached
 * HEAD. `git symbolic-ref` fails on both, which we swallow.
 */
export function currentBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Short HEAD sha for `cwd`, or `-` outside a repo / with no commits. */
export function headShort(cwd: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out || "-";
  } catch {
    return "-";
  }
}

/** One completed-stage entry. `iterations` (the `/N`) is fixed by the run. */
export type StageEntry = {
  iteration: number;
  stage: string;
  status: string;
  durationMs: number;
  /** Short HEAD sha, or `-`. */
  head: string;
  /** Container-relative NDJSON path, e.g. `.ralph-tmp/logs/<file>.ndjson`. */
  logPath: string;
  /** Agent's final message, verbatim. */
  body: string;
};

function renderHeader(
  bin: string,
  start: string,
  branch: string | undefined,
  iterations: number,
  inputs: string
): string {
  const branchPart = branch ? ` · branch ${branch}` : "";
  const lines = [
    `# ralph-${bin} · ${start}${branchPart} · ${iterations} iterations`,
  ];
  if (inputs) lines.push(`inputs: ${inputs}`);
  return lines.join("\n") + "\n\n";
}

function renderEntry(iterations: number, e: StageEntry): string {
  const head = `## iter ${e.iteration}/${iterations} · ${e.stage} · ${e.status} · ${formatDuration(
    e.durationMs
  )} · HEAD ${e.head}`;
  return `${head}\nlog: ${e.logPath}\n\n${e.body}\n\n`;
}

function renderFooter(
  completed: number,
  iterations: number,
  reason: string
): string {
  return `--- ended · ${completed}/${iterations} iterations · ${reason}\n`;
}

export type OpenHistoryOptions = {
  workspaceDir: string;
  /** Short bin name: `afk` / `ghafk`. */
  bin: string;
  iterations: number;
  /** Rendered into an `inputs:` line when non-empty (afk); omitted for ghafk. */
  inputs: string;
  now?: Date;
};

export interface HistoryWriter {
  readonly filePath: string;
  appendEntry(entry: StageEntry): void;
  appendFooter(completed: number, reason: string): void;
}

/**
 * Open a run's history file: create `.ralph/history/` and its self-ignoring
 * `.gitignore` (`*`, written only when missing), then write the run header.
 * Returns a writer whose `appendEntry` / `appendFooter` bind the run's iteration
 * count so callers pass only per-entry data.
 */
export function openHistory(opts: OpenHistoryOptions): HistoryWriter {
  const { workspaceDir, bin, iterations, inputs, now = new Date() } = opts;

  const historyDir = join(workspaceDir, ".ralph", "history");
  mkdirSync(historyDir, { recursive: true });
  const gitignore = join(historyDir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", "utf8");

  const rawBranch = currentBranch(workspaceDir);
  const branch = rawBranch ? sanitizeBranch(rawBranch) : undefined;
  const filePath = join(
    historyDir,
    historyFileName(fileTimestamp(now), bin, branch)
  );

  writeFileSync(
    filePath,
    renderHeader(bin, displayTimestamp(now), branch, iterations, inputs),
    "utf8"
  );

  return {
    filePath,
    appendEntry(entry: StageEntry): void {
      appendFileSync(filePath, renderEntry(iterations, entry), "utf8");
    },
    appendFooter(completed: number, reason: string): void {
      appendFileSync(filePath, renderFooter(completed, iterations, reason), "utf8");
    },
  };
}
