import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  fileTimestamp,
  formatDuration,
  headShort,
  historyFileName,
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
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
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

  it("does not rewrite an existing .gitignore on a second run", () => {
    const workspaceDir = makeWorkspace();
    openHistory({ workspaceDir, bin: "afk", iterations: 1, inputs: "p", now });

    const gitignore = join(workspaceDir, ".ralph", "history", ".gitignore");
    writeFileSync(gitignore, "custom\n", "utf8");

    openHistory({ workspaceDir, bin: "afk", iterations: 1, inputs: "p", now });
    expect(readFileSync(gitignore, "utf8")).toBe("custom\n");
  });
});
