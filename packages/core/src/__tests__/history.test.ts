import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  dirtySnapshot,
  fileTimestamp,
  formatDuration,
  headShort,
  historyFileName,
  loadHistoryTail,
  openHistory,
  sanitizeBranch,
  type StageEntry,
} from "../history.js";

const roots: string[] = [];

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-history-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("sanitizeBranch", () => {
  it("replaces characters outside [A-Za-z0-9._-] with '-'", () => {
    expect(sanitizeBranch("feature/slice 49")).toBe("feature-slice-49");
  });

  it("caps at 40 characters", () => {
    const long = "a".repeat(60);
    expect(sanitizeBranch(long)).toBe("a".repeat(40));
  });
});

describe("fileTimestamp", () => {
  it("formats a Date as yyyy-MM-dd-HHmmss in UTC", () => {
    expect(fileTimestamp(new Date(Date.UTC(2026, 8, 8, 12, 34, 56)))).toBe(
      "2026-09-08-123456"
    );
  });
});

describe("historyFileName", () => {
  it("includes the sanitized branch when known", () => {
    expect(historyFileName("2026-09-08-123456", "afk", "feature-x")).toBe(
      "2026-09-08-123456-afk-feature-x.md"
    );
  });

  it("omits the branch and its separator when unknown", () => {
    expect(historyFileName("2026-09-08-123456", "ghafk", undefined)).toBe(
      "2026-09-08-123456-ghafk.md"
    );
  });
});

describe("formatDuration", () => {
  it("renders minutes and zero-padded seconds", () => {
    expect(formatDuration(139_000)).toBe("2m19s");
    expect(formatDuration(65_000)).toBe("1m05s");
  });

  it("renders bare seconds under a minute", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("headShort", () => {
  it("returns '-' outside a git repository", () => {
    expect(headShort(makeWorkspace())).toBe("-");
  });
});

describe("dirtySnapshot", () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }
  function makeCleanRepo(): string {
    const root = makeWorkspace();
    git(root, "init");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
    writeFileSync(join(root, "tracked.txt"), "committed\n", "utf8");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "init");
    return root;
  }

  it("returns undefined outside a git repository", () => {
    expect(dirtySnapshot(makeWorkspace())).toBeUndefined();
  });

  it("returns undefined when the tree is clean", () => {
    expect(dirtySnapshot(makeCleanRepo())).toBeUndefined();
  });

  it("reports the count and paths when the tree is dirty", () => {
    const root = makeCleanRepo();
    writeFileSync(join(root, "wip.txt"), "draft\n", "utf8");
    expect(dirtySnapshot(root)).toBe("1 files — wip.txt");
  });

  it("caps the listed paths at ten but counts them all", () => {
    const root = makeCleanRepo();
    for (let k = 0; k < 12; k++) {
      writeFileSync(join(root, `f${k}.txt`), "x\n", "utf8");
    }
    const snap = dirtySnapshot(root)!;
    expect(snap.startsWith("12 files — ")).toBe(true);
    expect(snap.split(" — ")[1].split(", ")).toHaveLength(10);
  });
});

describe("openHistory", () => {
  const now = new Date(Date.UTC(2026, 8, 8, 12, 34, 56));

  /** A boilerplate entry; the run-totals tests vary only status and meta. */
  function entry(stage: string, status: string): StageEntry {
    return {
      iteration: 1,
      stage,
      status,
      durationMs: 5_000,
      head: "abc1234",
      logPath: ".ralph-tmp/logs/x.ndjson",
      body: "body",
    };
  }

  /** The run file's last line — the footer, once one has been appended. */
  function lastLine(filePath: string): string {
    return readFileSync(filePath, "utf8").trimEnd().split("\n").pop()!;
  }

  it("creates .ralph/history/.gitignore with '*' and names the file (no git)", () => {
    const workspaceDir = makeWorkspace();
    const writer = openHistory({
      workspaceDir,
      bin: "afk",
      iterations: 3,
      inputs: "my plan",
      now,
    });

    const historyDir = join(workspaceDir, ".ralph", "history");
    expect(readFileSync(join(historyDir, ".gitignore"), "utf8")).toBe("*\n");
    expect(basename(writer.filePath)).toBe("2026-09-08-123456-afk.md");

    const header = readFileSync(writer.filePath, "utf8");
    expect(header).toContain(
      "# ralph-afk · 2026-09-08 12:34:56Z · 3 iterations"
    );
    expect(header).toContain("inputs: my plan");
  });

  it("omits the inputs line for ghafk (empty inputs)", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "ghafk",
      iterations: 2,
      inputs: "",
      now,
    });
    expect(readFileSync(writer.filePath, "utf8")).not.toContain("inputs:");
  });

  it("renders entries and a footer in append order", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 3,
      inputs: "plan",
      now,
    });

    writer.appendEntry({
      iteration: 1,
      stage: "implementer",
      status: "ok",
      durationMs: 139_000,
      head: "abc1234",
      logPath: ".ralph-tmp/logs/run.ndjson",
      body: "did the thing",
    });
    writer.appendFooter(2, "no-more-tasks");

    const text = readFileSync(writer.filePath, "utf8");
    expect(text).toContain(
      "## iter 1/3 · implementer · ok · 2m19s · HEAD abc1234"
    );
    expect(text).toContain("log: .ralph-tmp/logs/run.ndjson");
    expect(text).toContain("did the thing");
    expect(text.trimEnd()).toMatch(
      /--- ended · 2\/3 iterations · no-more-tasks · /
    );
  });

  it("accumulates run totals into the footer and runSummary()", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 3,
      inputs: "plan",
      now,
    });

    writer.appendEntry({
      ...entry("implementer", "ok"),
      meta: { costUsd: 1.0, inputTokens: 2000, outputTokens: 1000 },
    });
    writer.appendEntry({
      ...entry("reviewer", "review-ok"),
      meta: { costUsd: 0.5, inputTokens: 1000, outputTokens: 500 },
    });
    writer.appendEntry(entry("reviewer", "skipped"));

    expect(writer.runSummary()).toMatchObject({
      stagesRun: 2,
      stagesSkipped: 1,
      costUsd: 1.5,
      inputTokens: 3000,
      outputTokens: 1500,
    });
    expect(writer.runSummary().durationMs).toBeGreaterThanOrEqual(0);

    writer.appendFooter(2, "no-more-tasks");
    expect(lastLine(writer.filePath)).toMatch(
      /^--- ended · 2\/3 iterations · no-more-tasks · 2 stages \(1 skipped\) · \$1\.50 · 3\.0k in \/ 1\.5k out · \d+s$/
    );
  });

  it("omits the cost from the totals when no entry carried one (Codex shape)", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 1,
      inputs: "plan",
      now,
    });
    writer.appendEntry({
      ...entry("implementer", "ok"),
      meta: { inputTokens: 2000, outputTokens: 1000 },
    });
    writer.appendFooter(1, "cap");

    const footer = lastLine(writer.filePath);
    expect(footer).toContain("k in /");
    expect(footer).not.toContain("$");
    expect(writer.runSummary().costUsd).toBeUndefined();
  });

  it("renders only stages and duration when no entry carried meta", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 1,
      inputs: "plan",
      now,
    });
    writer.appendEntry(entry("implementer", "ok"));
    writer.appendFooter(1, "cap");

    const footer = lastLine(writer.filePath);
    expect(footer).toMatch(/· 1 stages · \d+s$/);
    expect(footer).not.toContain("$");
    expect(footer).not.toContain("k in");
  });

  it("counts a failed entry as run and omits the skipped count entirely", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 1,
      inputs: "plan",
      now,
    });
    writer.appendEntry(entry("implementer", "failed"));
    writer.appendFooter(1, "failed");

    const footer = lastLine(writer.filePath);
    expect(footer).toContain("· 1 stages ·");
    expect(footer).not.toContain("skipped)");
    expect(footer).not.toContain("(");
  });

  it("suffixes the footer with the sandbox-install warning when findings exist", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 3,
      inputs: "plan",
      now,
    });
    writer.appendEntry(entry("implementer", "ok"));
    writer.appendFooter(1, "cap", ["x"]);

    expect(lastLine(writer.filePath)).toMatch(
      /^--- ended · 1\/3 iterations · cap · 1 stages · \d+s · warning: sandbox-install$/
    );
  });

  it("leaves the footer bare when the host check found nothing", () => {
    const bare = /^--- ended · 1\/3 iterations · cap · 1 stages · \d+s$/;
    const open = () =>
      openHistory({
        workspaceDir: makeWorkspace(),
        bin: "afk",
        iterations: 3,
        inputs: "plan",
        now,
      });

    const omitted = open();
    omitted.appendEntry(entry("implementer", "ok"));
    omitted.appendFooter(1, "cap");
    expect(lastLine(omitted.filePath)).toMatch(bare);

    const empty = open();
    empty.appendEntry(entry("implementer", "ok"));
    empty.appendFooter(1, "cap", []);
    expect(lastLine(empty.filePath)).toMatch(bare);
  });

  it("renders present meta fields in the header, omitting absent ones", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 1,
      inputs: "plan",
      now,
    });

    // Claude-shaped meta: turns + cost, no tokens.
    writer.appendEntry({
      iteration: 1,
      stage: "implementer",
      status: "ok",
      durationMs: 139_000,
      head: "abc1234",
      logPath: ".ralph-tmp/logs/impl.ndjson",
      body: "did the thing",
      meta: { turns: 8, costUsd: 0.6 },
    });
    // Codex-shaped meta: tokens only, plus a fired grace timer.
    writer.appendEntry({
      iteration: 1,
      stage: "reviewer",
      status: "review-ok",
      durationMs: 139_000,
      head: "abc1234",
      logPath: ".ralph-tmp/logs/rev.ndjson",
      body: "clean",
      meta: { inputTokens: 12300, outputTokens: 1100, graceTimerFired: true },
    });

    const text = readFileSync(writer.filePath, "utf8");
    expect(text).toContain(
      "## iter 1/1 · implementer · ok · 2m19s · 8 turns · $0.60 · HEAD abc1234"
    );
    expect(text).toContain(
      "## iter 1/1 · reviewer · review-ok · 2m19s · 12.3k in / 1.1k out · grace-timer · HEAD abc1234"
    );
  });

  it("renders retries, attempt bullets, and a dirty line in contract order", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 1,
      inputs: "plan",
      now,
    });

    writer.appendEntry({
      iteration: 1,
      stage: "implementer",
      status: "failed",
      durationMs: 5_000,
      head: "abc1234",
      logPath: ".ralph-tmp/logs/impl.ndjson",
      body: "final boom",
      retries: 2,
      attempts: ["first boom", "second boom"],
      dirty: "1 files — wip.txt",
    });

    const text = readFileSync(writer.filePath, "utf8");
    const body = text.slice(text.indexOf("## iter"));
    expect(body).toBe(
      "## iter 1/1 · implementer · failed · 5s · HEAD abc1234\n" +
        "log: .ralph-tmp/logs/impl.ndjson\n" +
        "retries: 2\n" +
        "- attempt 1: first boom\n" +
        "- attempt 2: second boom\n" +
        "dirty: 1 files — wip.txt\n\n" +
        "final boom\n\n"
    );
  });

  it("omits retries, attempt, and dirty lines when they are unset", () => {
    const writer = openHistory({
      workspaceDir: makeWorkspace(),
      bin: "afk",
      iterations: 1,
      inputs: "plan",
      now,
    });
    writer.appendEntry({
      iteration: 1,
      stage: "implementer",
      status: "ok",
      durationMs: 5_000,
      head: "abc1234",
      logPath: ".ralph-tmp/logs/impl.ndjson",
      body: "did the thing",
    });
    const text = readFileSync(writer.filePath, "utf8");
    expect(text).not.toContain("retries:");
    expect(text).not.toContain("- attempt");
    expect(text).not.toContain("dirty:");
  });

  it("does not rewrite an existing .gitignore on a second run", () => {
    const workspaceDir = makeWorkspace();
    openHistory({ workspaceDir, bin: "afk", iterations: 1, inputs: "p", now });

    const gitignore = join(workspaceDir, ".ralph", "history", ".gitignore");
    writeFileSync(gitignore, "custom\n", "utf8");

    openHistory({ workspaceDir, bin: "afk", iterations: 1, inputs: "p", now });
    expect(readFileSync(gitignore, "utf8")).toBe("custom\n");
  });
});

describe("loadHistoryTail", () => {
  /** Write a run file of `count` entries whose bodies are `<label> body <k>`. */
  function writeRun(
    workspaceDir: string,
    fileName: string,
    label: string,
    count: number
  ): void {
    const dir = join(workspaceDir, ".ralph", "history");
    mkdirSync(dir, { recursive: true });
    let text = `# ralph-afk · 2026-09-08 12:00:00Z · ${count} iterations\n\n`;
    for (let k = 1; k <= count; k++) {
      text +=
        `## iter ${k}/${count} · implementer · ok · 5s · HEAD abc${k}\n` +
        `log: .ralph-tmp/logs/${label}${k}.ndjson\n\n` +
        `${label} body ${k}\n\n`;
    }
    text += `--- ended · ${count}/${count} iterations · cap · ${count} stages · 5s\n`;
    writeFileSync(join(dir, fileName), text, "utf8");
  }

  it("renders 'No prior history.' when the history dir is missing or empty", () => {
    expect(loadHistoryTail(makeWorkspace())).toBe("No prior history.");
    const ws = makeWorkspace();
    mkdirSync(join(ws, ".ralph", "history"), { recursive: true });
    expect(loadHistoryTail(ws)).toBe("No prior history.");
  });

  it("returns the last ten entries across files, oldest-first", () => {
    const ws = makeWorkspace();
    writeRun(ws, "2026-09-08-120000-afk.md", "older", 6);
    writeRun(ws, "2026-09-08-130000-afk.md", "newer", 6);

    const out = loadHistoryTail(ws);
    // Last 10 chronologically: older 3..6 then all six newer, oldest first.
    expect(out).not.toContain("older body 2");
    const order = [
      "older body 3",
      "older body 4",
      "older body 5",
      "older body 6",
      "newer body 1",
      "newer body 6",
    ].map((s) => out.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Metadata lines survive.
    expect(out).toContain("## iter 3/6 · implementer · ok · 5s · HEAD abc3");
    expect(out).toContain("log: .ralph-tmp/logs/older3.ndjson");
  });

  it("caps a body over 1500 chars, keeping header and metadata lines intact", () => {
    const ws = makeWorkspace();
    const body = "X".repeat(2000);
    const dir = join(ws, ".ralph", "history");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-09-08-120000-afk.md"),
      `# ralph-afk · 2026-09-08 12:00:00Z · 1 iterations\n\n` +
        `## iter 1/1 · implementer · ok · 5s · HEAD abc1\n` +
        `log: .ralph-tmp/logs/x.ndjson\n\n${body}\n\n` +
        `--- ended · 1/1 iterations · cap\n`,
      "utf8"
    );

    const out = loadHistoryTail(ws);
    expect(out).toContain("## iter 1/1 · implementer · ok · 5s · HEAD abc1");
    expect(out).toContain("log: .ralph-tmp/logs/x.ndjson");
    expect(out).toContain("…");
    expect(out).toContain(body.slice(0, 500));
    expect(out).toContain(body.slice(-1000));
    expect(out).not.toContain(body); // the full 2000-char body is not present
  });
});
