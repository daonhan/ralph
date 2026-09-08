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
  fileTimestamp,
  formatDuration,
  headShort,
  historyFileName,
  loadHistoryTail,
  openHistory,
  sanitizeBranch,
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

describe("openHistory", () => {
  const now = new Date(Date.UTC(2026, 8, 8, 12, 34, 56));

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
      /--- ended · 2\/3 iterations · no-more-tasks$/
    );
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
    text += `--- ended · ${count}/${count} iterations · cap\n`;
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
