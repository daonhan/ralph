import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { StageMeta } from "./agents/index.js";

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

/**
 * A one-line dirty-tree snapshot for a `failed` / `aborted` / `skipped` entry:
 * the number of uncommitted paths in `cwd` plus the first ten, from
 * `git status --porcelain`. Returns `undefined` when the tree is clean or git is
 * unavailable, so the caller omits the `dirty:` line. Lives here so the abort
 * slice can reuse it.
 */
export function dirtySnapshot(cwd: string): string | undefined {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
  } catch {
    return undefined;
  }
  // Porcelain v1 lines are `XY <path>`; the path begins at column 3.
  const paths = out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3));
  if (paths.length === 0) return undefined;
  return `${paths.length} files — ${paths.slice(0, 10).join(", ")}`;
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
  /** Agent's final message (or the final error, for a `failed` entry), verbatim. */
  body: string;
  /** Provider/runner metadata; only present fields reach the header. */
  meta?: StageMeta;
  /** Count of failed attempts before this outcome; omitted when zero. */
  retries?: number;
  /** One error message per failed attempt, rendered as `- attempt <k>: …`. */
  attempts?: string[];
  /** Dirty-tree snapshot ({@link dirtySnapshot}); omitted when clean / no git. */
  dirty?: string;
};

/** Tokens rendered as thousands with one decimal: 12300 → "12.3", 1100 → "1.1". */
function formatThousands(n: number): string {
  return (n / 1000).toFixed(1);
}

/**
 * Optional header segments between the duration and `HEAD`, each prefixed with
 * ` · ` and emitted only when its field is present:
 * `<n> turns`, `$<cost>`, `<in>k in / <out>k out`, `grace-timer`.
 */
function renderMetaSegments(meta: StageMeta | undefined): string {
  if (!meta) return "";
  const segments: string[] = [];
  if (meta.turns !== undefined) segments.push(`${meta.turns} turns`);
  if (meta.costUsd !== undefined) segments.push(`$${meta.costUsd.toFixed(2)}`);
  if (meta.inputTokens !== undefined && meta.outputTokens !== undefined) {
    segments.push(
      `${formatThousands(meta.inputTokens)}k in / ${formatThousands(
        meta.outputTokens
      )}k out`
    );
  }
  if (meta.graceTimerFired) segments.push("grace-timer");
  return segments.map((s) => ` · ${s}`).join("");
}

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
  )}${renderMetaSegments(e.meta)} · HEAD ${e.head}`;
  const lines = [head, `log: ${e.logPath}`];
  if (e.retries !== undefined) lines.push(`retries: ${e.retries}`);
  if (e.attempts) {
    e.attempts.forEach((msg, k) => lines.push(`- attempt ${k + 1}: ${msg}`));
  }
  if (e.dirty !== undefined) lines.push(`dirty: ${e.dirty}`);
  return `${lines.join("\n")}\n\n${e.body}\n\n`;
}

/** Run-level totals, accumulated by the writer as entries arrive. */
export type RunSummary = {
  /** Entries whose status is not `skipped`; a `failed` entry counts as run. */
  stagesRun: number;
  stagesSkipped: number;
  /** Summed over entries carrying a cost; absent when none did. */
  costUsd?: number;
  /** Summed over entries carrying both token counts; absent when none did. */
  inputTokens?: number;
  outputTokens?: number;
  /** Wall time since the writer opened. */
  durationMs: number;
};

/**
 * The totals segment shared by the footer and the loop's stdout summary line,
 * each part prefixed with ` · `: `<run> stages`, `(<k> skipped)` only when some
 * stage was skipped, `$<cost>` and `<in>k in / <out>k out` only when present,
 * then the run's duration.
 */
export function renderRunTotals(s: RunSummary): string {
  const skipped = s.stagesSkipped > 0 ? ` (${s.stagesSkipped} skipped)` : "";
  const segments = [`${s.stagesRun} stages${skipped}`];
  if (s.costUsd !== undefined) segments.push(`$${s.costUsd.toFixed(2)}`);
  if (s.inputTokens !== undefined && s.outputTokens !== undefined) {
    segments.push(
      `${formatThousands(s.inputTokens)}k in / ${formatThousands(
        s.outputTokens
      )}k out`
    );
  }
  segments.push(formatDuration(s.durationMs));
  return segments.map((x) => ` · ${x}`).join("");
}

function renderFooter(
  completed: number,
  iterations: number,
  reason: string,
  summary: RunSummary
): string {
  return `--- ended · ${completed}/${iterations} iterations · ${reason}${renderRunTotals(
    summary
  )}\n`;
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
  /** The run's totals so far; the duration is measured when called. */
  runSummary(): RunSummary;
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

  // Run totals, accumulated from the entries this writer appends. Wall time
  // runs from here — `now` only stamps the file name and header.
  const openedAt = Date.now();
  let stagesRun = 0;
  let stagesSkipped = 0;
  let costUsd: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const summary = (): RunSummary => ({
    stagesRun,
    stagesSkipped,
    costUsd,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - openedAt,
  });

  return {
    filePath,
    appendEntry(entry: StageEntry): void {
      if (entry.status === "skipped") stagesSkipped++;
      else stagesRun++;
      const meta = entry.meta;
      if (meta?.costUsd !== undefined) costUsd = (costUsd ?? 0) + meta.costUsd;
      if (meta?.inputTokens !== undefined && meta.outputTokens !== undefined) {
        inputTokens = (inputTokens ?? 0) + meta.inputTokens;
        outputTokens = (outputTokens ?? 0) + meta.outputTokens;
      }
      appendFileSync(filePath, renderEntry(iterations, entry), "utf8");
    },
    appendFooter(completed: number, reason: string): void {
      appendFileSync(
        filePath,
        renderFooter(completed, iterations, reason, summary()),
        "utf8"
      );
    },
    runSummary: summary,
  };
}

// --- Tail loader: the last stage entries, rendered for the implementer prompt ---

/** How many entries the implementer prompt carries. */
const TAIL_MAX = 10;
/** Body cap: entries longer than this keep their head and tail, dropping the middle. */
const BODY_CAP = 1500;
const BODY_HEAD = 500;
const BODY_TAIL = 1000;
const NO_HISTORY = "No prior history.";

/**
 * Split a history file into its stage entries (each starting at a `## iter`
 * line). Header lines before the first entry and the trailing footer are
 * dropped; each entry keeps its metadata lines and body, trailing blanks
 * trimmed.
 */
function parseEntries(fileText: string): string[] {
  const entries: string[] = [];
  let current: string[] | null = null;
  for (const line of fileText.split("\n")) {
    if (line.startsWith("## iter ")) {
      if (current) entries.push(current.join("\n").trimEnd());
      current = [line];
    } else if (line.startsWith("--- ended ")) {
      // Footer marks the end of the run's entries; ignore anything after it.
      if (current) entries.push(current.join("\n").trimEnd());
      current = null;
      break;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) entries.push(current.join("\n").trimEnd());
  return entries;
}

/** Cap the body to first {@link BODY_HEAD} + `…` + last {@link BODY_TAIL} chars. */
function capBody(body: string): string {
  if (body.length <= BODY_CAP) return body;
  return `${body.slice(0, BODY_HEAD)}\n…\n${body.slice(-BODY_TAIL)}`;
}

/** Re-render one parsed entry, capping only its body (metadata lines untouched). */
function renderTailEntry(entry: string): string {
  const sep = entry.indexOf("\n\n");
  if (sep < 0) return entry;
  return `${entry.slice(0, sep)}\n\n${capBody(entry.slice(sep + 2))}`;
}

/**
 * Render the last {@link TAIL_MAX} stage entries across every history file into
 * the `{{ HISTORY }}` block for the implementer prompt. Files are read
 * newest-first by filename until ten entries are collected, then rendered
 * oldest-first with each body capped. Returns `No prior history.` when the
 * directory is empty or absent.
 */
export function loadHistoryTail(workspaceDir: string): string {
  const dir = join(workspaceDir, ".ralph", "history");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();
  } catch {
    return NO_HISTORY;
  }

  const collected: string[] = []; // newest-first
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const entries = parseEntries(text);
    for (
      let k = entries.length - 1;
      k >= 0 && collected.length < TAIL_MAX;
      k--
    ) {
      collected.push(entries[k]);
    }
    if (collected.length >= TAIL_MAX) break;
  }

  if (collected.length === 0) return NO_HISTORY;
  collected.reverse(); // oldest-first for reading
  return collected.map(renderTailEntry).join("\n\n");
}
