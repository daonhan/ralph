import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changedPaths, needsChecks } from "./check-changes.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("only ordinary documentation skips verification", () => {
  assert.equal(
    needsChecks(["README.md", "docs/ARCHITECTURE.md", "docs/ralph-stack.svg"]),
    false
  );
  for (const path of [
    "packages/core/templates/prompt.md",
    "packages/core/templates/skills/ralph-tdd/tests.md",
    "docs/SKILL.md",
    "docs/skills/task/reference.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".codex/AGENT.md",
    ".claude/agents/plan-adversary.md",
    ".agents/skills/task/SKILL.md",
    "packages/core/src/loop.ts",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
    "docs/verify.mjs",
  ]) {
    assert.equal(needsChecks([path]), true, path);
    assert.equal(needsChecks(["README.md", path]), true, `mixed: ${path}`);
  }
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-change-check-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const snapshot = () => {
    git("add", "-A");
    const tree = git("write-tree");
    return execFileSync("git", ["commit-tree", tree, "-m", "fixture"], {
      cwd,
      env,
      encoding: "utf8",
    }).trim();
  };
  return { cwd, git, snapshot };
}

test("a code deletion and a rename into docs still require checks", (t) => {
  const { cwd, snapshot } = fixture(t);
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "docs"));
  writeFileSync(
    join(cwd, "src", "task.mjs"),
    "export const contract = true;\n"
  );
  const before = snapshot();
  rmSync(join(cwd, "src", "task.mjs"));
  writeFileSync(
    join(cwd, "docs", "task.md"),
    "export const contract = true;\n"
  );
  const after = snapshot();
  assert.equal(needsChecks(changedPaths(before, after, cwd)), true);
  rmSync(join(cwd, "docs", "task.md"));
  assert.equal(needsChecks(changedPaths(before, snapshot(), cwd)), true);
});

test("pre-push skips a documentation range and stops after the first failed check", (t) => {
  const { cwd, snapshot } = fixture(t);
  writeFileSync(join(cwd, "README.md"), "before\n");
  const before = snapshot();
  writeFileSync(join(cwd, "README.md"), "after\n");
  const docs = snapshot();
  const run = (head, extraEnv = {}) =>
    spawnSync(process.execPath, [join(root, "scripts/pre-push.mjs")], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        PRE_COMMIT_FROM_REF: before,
        PRE_COMMIT_TO_REF: head,
        RALPH_PUSH_REFS: "",
        ...extraEnv,
      },
    });
  const skipped = run(docs);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /\[skipped\].*documentation-only/);

  writeFileSync(join(cwd, "task.mjs"), "export const task = true;\n");
  const code = snapshot();
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const log = join(cwd, "commands.log");
  writeFileSync(
    join(bin, "pnpm.cmd"),
    '@echo off\r\necho %*>>"%RALPH_TEST_LOG%"\r\nexit /b 7\r\n'
  );
  writeFileSync(
    join(bin, "pnpm"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RALPH_TEST_LOG"\nexit 7\n',
    { mode: 0o755 }
  );
  const failed = run(code, {
    PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    RALPH_TEST_LOG: log,
  });
  assert.equal(failed.status, 7, failed.stderr);
  assert.match(failed.stdout, /\[passed\].*whitespace/);
  assert.match(failed.stdout, /\[failed\].*typecheck/);
  assert.match(failed.stdout, /\[skipped\].*build/);
  assert.equal(readFileSync(log, "utf8").trim(), "-r typecheck");

  writeFileSync(log, "");
  const mixedRefs = run(docs, {
    PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    RALPH_TEST_LOG: log,
    RALPH_PUSH_REFS: `refs/heads/docs ${docs} refs/heads/docs ${before}\nrefs/heads/code ${code} refs/heads/code ${before}\n`,
  });
  assert.equal(mixedRefs.status, 7, mixedRefs.stdout);
  assert.equal(readFileSync(log, "utf8").trim(), "-r typecheck");
});

test("the installed hook launcher preserves all ref records for prek and the checker", (t) => {
  const { cwd } = fixture(t);
  const log = join(cwd, "forwarded.json");
  // This executable probe observes transport only; prek's range selection is
  // independently exercised by the multi-ref CLI regression above.
  writeFileSync(
    join(cwd, "hook-impl"),
    `const fs = require("node:fs"); fs.writeFileSync(process.env.RALPH_TEST_LOG, JSON.stringify({ stdin: fs.readFileSync(0, "utf8"), refs: process.env.RALPH_PUSH_REFS, args: process.argv.slice(2) }));`
  );
  const records =
    "refs/heads/docs a refs/heads/docs b\nrefs/heads/code c refs/heads/code d\n";
  const result = spawnSync(
    process.execPath,
    [
      join(root, "scripts/prek-pre-push.mjs"),
      process.execPath,
      ".git/hooks",
      "origin",
      "example.invalid",
    ],
    {
      cwd,
      input: records,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, RALPH_TEST_LOG: log },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const forwarded = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(forwarded.stdin, records);
  assert.equal(forwarded.refs, records);
  assert.deepEqual(forwarded.args.slice(-3), [
    "--",
    "origin",
    "example.invalid",
  ]);
});
