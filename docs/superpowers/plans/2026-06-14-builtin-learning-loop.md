# Built-in Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Ralph a persistent, git-tracked `.ralph/LEARNINGS.md` memory file that is injected into every stage's prompt and appended to inline by the agent, so durable repo knowledge carries across iterations.

**Architecture:** Templates-only. Read-back reuses the existing `!?` try-shell render tag (the same mechanism as the git-log block). Capture reuses the existing playbook-instruction mechanism (the agent already has Read/Edit/Write + commit). No TypeScript/harness code changes — only `packages/core/templates/*.md`, one new vitest, and a docs note.

**Tech Stack:** TypeScript ESM monorepo (pnpm), vitest. The render tag of interest: `` !?`<cmd>|||<fallback>` `` — runs `<cmd>` via `/bin/bash` (cwd = workspace), substitutes the literal `<fallback>` on non-zero exit. Confirmed in `packages/core/src/render.ts:13` (`SHELL_TRY_TAG = /!\?\`([^\`]+)\`/g`) and `:21` (`TRY_SEP = "|||"`).

Spec: `docs/superpowers/specs/2026-06-14-builtin-learning-loop-design.md`.

---

## File Structure

- **Modify** `packages/core/templates/afk.md` — add a `<learnings>` read-back block.
- **Modify** `packages/core/templates/ghafk.md` — add a `<learnings>` read-back block.
- **Modify** `packages/core/templates/review.md` — add read-back block + a capture note (single-reviewer mode may append on its `fix(review):` commit).
- **Modify** `packages/core/templates/review-lens.md` — add read-back block; reinforce read-only (must NOT write the file).
- **Modify** `packages/core/templates/review-synth.md` — add read-back block + a capture note (may append on its `fix(review):` commit).
- **Modify** `packages/core/templates/prompt.md` — add a `# LEARNINGS` capture section.
- **Modify** `packages/core/templates/ghprompt.md` — add a `# LEARNINGS` capture section.
- **Create** `packages/core/src/__tests__/learnings.test.ts` — render test: block present when file exists, fallback when absent.
- **Modify** `CLAUDE.md` — note `.ralph/LEARNINGS.md` in the scratch-dir section.
- **Modify** `README.md` — note the learnings file under Architecture.

The exact read-back line, added once per template (note the `|||` separator is INSIDE the backticks):

```
!?`cat ./.ralph/LEARNINGS.md|||_No learnings recorded yet._`
```

---

## Task 1: Read-back injection (TDD) + render test

**Files:**

- Create: `packages/core/src/__tests__/learnings.test.ts`
- Modify: `packages/core/templates/afk.md`, `ghafk.md`, `review.md`, `review-lens.md`, `review-synth.md`

- [x] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/learnings.test.ts` with exactly this content. It renders the **real** shipped templates (`afk.md` = implementer, `review-synth.md` = reviewer; both are free of `@spill`, so no spill opts are needed):

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";

const TEMPLATES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates"
);
const FALLBACK = "No learnings recorded yet";

function makeWorkspace(learnings?: string): string {
  const ws = mkdtempSync(join(tmpdir(), "ralph-learn-"));
  if (learnings !== undefined) {
    mkdirSync(join(ws, ".ralph"), { recursive: true });
    writeFileSync(join(ws, ".ralph", "LEARNINGS.md"), learnings, "utf8");
  }
  return ws;
}

describe("learnings read-back block", () => {
  it("injects .ralph/LEARNINGS.md into the implementer (afk) prompt", () => {
    const ws = makeWorkspace("## Gotchas\n- pnpm not npm\n");
    try {
      const out = renderTemplate(
        join(TEMPLATES, "afk.md"),
        { INPUTS: "plan" },
        { cwd: ws }
      );
      expect(out).toContain("- pnpm not npm");
      expect(out).not.toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back when .ralph/LEARNINGS.md is absent (afk)", () => {
    const ws = makeWorkspace();
    try {
      const out = renderTemplate(
        join(TEMPLATES, "afk.md"),
        { INPUTS: "plan" },
        { cwd: ws }
      );
      expect(out).toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("injects learnings into the reviewer (review-synth) prompt", () => {
    const ws = makeWorkspace("## Decisions\n- chose X over Y\n");
    try {
      const out = renderTemplate(
        join(TEMPLATES, "review-synth.md"),
        {},
        { cwd: ws }
      );
      expect(out).toContain("- chose X over Y");
      expect(out).not.toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @daonhan/ralph-core test -- learnings`
Expected: FAIL — the "injects" assertions fail (`expected '...' to contain '- pnpm not npm'`) and the fallback assertion fails because no `<learnings>` block exists in the templates yet.

- [x] **Step 3: Add the read-back block to `afk.md`**

In `packages/core/templates/afk.md`, insert a `<learnings>` block between the `</commits>` and `<inputs>` blocks. Replace:

```
</commits>

<inputs>
```

with:

```
</commits>

<learnings>

!?`cat ./.ralph/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<inputs>
```

- [x] **Step 4: Add the read-back block to `ghafk.md`**

In `packages/core/templates/ghafk.md`, insert the same block between `</commits>` and `<issues-summary>`. Replace:

```
</commits>

<issues-summary>
```

with:

```
</commits>

<learnings>

!?`cat ./.ralph/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<issues-summary>
```

- [x] **Step 5: Add the read-back block to `review.md`**

In `packages/core/templates/review.md`, insert the block between `</recent-commits>` and `<latest-diff>`. Replace:

```
</recent-commits>

<latest-diff>
```

with:

```
</recent-commits>

<learnings>

!?`cat ./.ralph/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<latest-diff>
```

- [x] **Step 6: Add the read-back block to `review-lens.md`**

In `packages/core/templates/review-lens.md`, insert the block between `</head>` and `<latest-diff>`. Replace:

```
</head>

<latest-diff>
```

with:

```
</head>

<learnings>

!?`cat ./.ralph/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<latest-diff>
```

- [x] **Step 7: Add the read-back block to `review-synth.md`**

In `packages/core/templates/review-synth.md`, insert the block between `</head>` and `# REVIEW SYNTHESIS`. Replace:

```
</head>

# REVIEW SYNTHESIS
```

with:

```
</head>

<learnings>

!?`cat ./.ralph/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

# REVIEW SYNTHESIS
```

- [x] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @daonhan/ralph-core test -- learnings`
Expected: PASS (3 tests).

- [x] **Step 9: Commit**

```bash
git add packages/core/templates/afk.md packages/core/templates/ghafk.md packages/core/templates/review.md packages/core/templates/review-lens.md packages/core/templates/review-synth.md packages/core/src/__tests__/learnings.test.ts
git commit -m "feat(learnings): inject .ralph/LEARNINGS.md into stage prompts"
```

---

## Task 2: Capture instructions in the implementer playbooks

Prose instructions (no test — covered by the render suite staying green + the manual smoke in Task 4).

**Files:**

- Modify: `packages/core/templates/prompt.md`
- Modify: `packages/core/templates/ghprompt.md`

- [x] **Step 1: Add a `# LEARNINGS` section to `prompt.md`**

In `packages/core/templates/prompt.md`, insert a new section between `# RECORDING PROGRESS` (its full block) and `# FINAL RULES`. Replace:

```
If a task is not complete, record the blocker in the commit body so the next iteration can pick up where you left off.

# FINAL RULES
```

with:

```
If a task is not complete, record the blocker in the commit body so the next iteration can pick up where you left off.

# LEARNINGS

The repo's accumulated learnings are in the `<learnings>` block — durable, reusable knowledge from prior iterations (conventions, gotchas, decisions and their why, dead ends). Consult it during EXPLORATION and IMPLEMENTATION so you don't relearn what's known or repeat a dead end.

If, while doing the task, you discover a NEW durable, reusable learning — a repo convention, a non-obvious gotcha, a decision and its why, or a dead-end to avoid — append it tersely to the right section of `./.ralph/LEARNINGS.md`. Create the file if it does not exist, with these four sections:

```

# Ralph learnings

## Conventions

## Gotchas

## Decisions

## Dead ends

```

Dedupe against existing entries and prune anything no longer true. This file is committed WITH your task commit (it is git-tracked) — do NOT make a separate commit for it. The bar is durable AND reusable: do NOT record routine or one-off task details.

# FINAL RULES
```

- [x] **Step 2: Add the same `# LEARNINGS` section to `ghprompt.md`**

In `packages/core/templates/ghprompt.md`, insert the section between the `# THE ISSUE` block and `# FINAL RULES`. Replace:

```
If the task is not complete, leave a comment on the GitHub issue with what was done.

# FINAL RULES
```

with:

```
If the task is not complete, leave a comment on the GitHub issue with what was done.

# LEARNINGS

The repo's accumulated learnings are in the `<learnings>` block — durable, reusable knowledge from prior iterations (conventions, gotchas, decisions and their why, dead ends). Consult it during EXPLORATION and IMPLEMENTATION so you don't relearn what's known or repeat a dead end.

If, while doing the task, you discover a NEW durable, reusable learning — a repo convention, a non-obvious gotcha, a decision and its why, or a dead-end to avoid — append it tersely to the right section of `./.ralph/LEARNINGS.md`. Create the file if it does not exist, with these four sections:

```

# Ralph learnings

## Conventions

## Gotchas

## Decisions

## Dead ends

```

Dedupe against existing entries and prune anything no longer true. This file is committed WITH your task commit (it is git-tracked) — do NOT make a separate commit for it. The bar is durable AND reusable: do NOT record routine or one-off task details.

# FINAL RULES
```

- [x] **Step 3: Verify the render suite still passes**

Run: `pnpm --filter @daonhan/ralph-core test -- render learnings`
Expected: PASS (the playbooks are `@include`-d into `afk.md`/`ghafk.md`; rendering must still succeed).

- [x] **Step 4: Commit**

```bash
git add packages/core/templates/prompt.md packages/core/templates/ghprompt.md
git commit -m "feat(learnings): instruct implementers to record durable learnings"
```

---

## Task 3: Capture notes in the reviewer templates

The reviewer/synth stages commit, so they may append a review-derived learning to that commit. Lenses are read-only and must NOT write.

**Files:**

- Modify: `packages/core/templates/review.md`
- Modify: `packages/core/templates/review-synth.md`
- Modify: `packages/core/templates/review-lens.md`

- [ ] **Step 1: Allow capture in `review.md` (single-reviewer mode)**

In `packages/core/templates/review.md`, the `# ACTION` block ends with the `If clean:` line. Replace:

```
If clean: output `<review>OK</review>` and stop. Do NOT commit.
```

with:

```
If clean: output `<review>OK</review>` and stop. Do NOT commit.

If the review surfaced a durable, reusable learning (e.g. a recurring defect class worth remembering), append it tersely to the right section of `./.ralph/LEARNINGS.md` as part of your `fix(review):` commit — never as a separate commit, and only when you are already committing a fix.
```

- [ ] **Step 2: Allow capture in `review-synth.md`**

In `packages/core/templates/review-synth.md`, extend ACTION step 2. Replace:

```
     then make a SINGLE commit: `git commit -am "fix(review): <short reason>"` (subject ≤72 chars, no `Co-Authored-By`, no file lists).
```

with:

```
     then make a SINGLE commit: `git commit -am "fix(review): <short reason>"` (subject ≤72 chars, no `Co-Authored-By`, no file lists). If a finding reflects a durable, reusable learning (e.g. a recurring defect class), you may also append it tersely to `./.ralph/LEARNINGS.md` so it rides in this same commit.
```

- [ ] **Step 3: Reinforce read-only in `review-lens.md`**

In `packages/core/templates/review-lens.md`, extend the `# RULES` block. Replace:

```
- READ-ONLY. Do **not** edit files. Do **not** commit. Do **not** run feedback loops.
- Only the {{ LENS }} lens — ignore issues another lens owns.
```

with:

```
- READ-ONLY. Do **not** edit files (including `./.ralph/LEARNINGS.md`). Do **not** commit. Do **not** run feedback loops.
- Use the `<learnings>` block only to avoid flagging an already-accepted decision — never write to it.
- Only the {{ LENS }} lens — ignore issues another lens owns.
```

- [ ] **Step 4: Verify the render suite still passes**

Run: `pnpm --filter @daonhan/ralph-core test -- render learnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/templates/review.md packages/core/templates/review-synth.md packages/core/templates/review-lens.md
git commit -m "feat(learnings): let reviewer/synth record learnings; keep lenses read-only"
```

---

## Task 4: Docs + full verification

**Files:**

- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Note the learnings file in `CLAUDE.md`**

In `CLAUDE.md`, the `### Per-iteration scratch dir` section documents the gitignored `.ralph-tmp/`. Immediately after that paragraph (the one ending `… --detach adds logs/detached-<pid>.log).`), add a new paragraph:

```
Separately, `<workspaceDir>/.ralph/LEARNINGS.md` (note: `.ralph/`, **not** `.ralph-tmp/`) is a **git-tracked** memory file: the implementer playbooks (`prompt.md` / `ghprompt.md`) read it via the `<learnings>` block injected into every stage prompt and append durable, reusable learnings (conventions, gotchas, decisions, dead ends) to it as part of their work commit. Created lazily by the agent on the first learning; absent-file safe via the `!?` fallback.
```

- [ ] **Step 2: Note the learnings file in `README.md`**

In `README.md`, under the `## Architecture` section, add a short bullet/paragraph describing the learning loop. Locate the architecture description and append:

```
**Learning loop.** Ralph keeps a git-tracked `.ralph/LEARNINGS.md` in the target repo. Its contents are injected into every implementer/reviewer prompt, and the agent appends durable, reusable learnings (repo conventions, gotchas, decisions, dead ends) to it as it works — so knowledge accumulates across iterations instead of being relearned each run. The file is committed alongside the work; delete it to reset Ralph's memory.
```

- [ ] **Step 3: Run the full verification suite**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all green. (No TypeScript changed; the new vitest passes; root `node --test` over `scripts/*.test.mjs` unaffected.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(learnings): document the .ralph/LEARNINGS.md memory file"
```

---

## Task 5 (optional): Manual smoke test

Validates the closed loop end-to-end. Skip if CI/time-constrained; the render test already proves the read-back, and the playbook instructions are prose.

- [ ] **Step 1: Run two iterations against a scratch repo**

```bash
mkdir -p /tmp/ralph-smoke && cd /tmp/ralph-smoke && git init -q && git commit -q --allow-empty -m "init"
# from a shell where `ralph-afk` is installed (see CLAUDE.md smoke-test section)
RALPH_WORKSPACE=/tmp/ralph-smoke ralph-afk "Create a file hello.txt containing 'hi', then there are no more tasks. Note in learnings that this repo has no build step." 2
```

- [ ] **Step 2: Verify the file was created, committed, and fed back**

```bash
cat /tmp/ralph-smoke/.ralph/LEARNINGS.md          # exists, has a learning
git -C /tmp/ralph-smoke log --oneline             # LEARNINGS.md rode in a work commit
grep -l "no build step" /tmp/ralph-smoke/.ralph-tmp/.run-*.md 2>/dev/null || \
  grep -r "no build step" /tmp/ralph-smoke/.ralph-tmp/logs/   # appears in iter-2 prompt
```

Expected: `.ralph/LEARNINGS.md` exists with the recorded learning; it appears in a commit; its content appears in the second iteration's rendered prompt or NDJSON log.

---

## Self-Review

- **Spec coverage:** memory file (Task 1 block + Task 2 lazy-create schema), read-back into all 5 templates (Task 1), inline capture (Tasks 2–3), panel read-only invariant (Task 3 Step 3), edge cases (missing-file fallback tested in Task 1 Step 1; whitespace/durable-bar handled by playbook prose), testing (Task 1 + Task 4 Step 3 + Task 5), docs (Task 4). All spec sections map to a task.
- **Placeholder scan:** none — every edit shows exact old/new strings and the test shows full code.
- **Type consistency:** no types introduced; the read-back line, the fallback string (`No learnings recorded yet`), and the four section headings (`Conventions` / `Gotchas` / `Decisions` / `Dead ends`) are identical across every task that references them.
- **Note:** the spec's illustrative read-back used `| fallback` (outside backticks); the correct render syntax is `|||` inside the backticks, used throughout this plan (verified against `render.ts:13,21`).
