# Plan: The sentinel gate fires only on a standalone emission

> Source PRD: [docs/prd/sentinel-standalone-line.md](../prd/sentinel-standalone-line.md) · tracks #135

## Architectural decisions

Durable decisions that apply across all phases:

- **One exported predicate.** `packages/core/src/loop.ts` exports `hasSentinel(text: string): boolean`, a multiline anchored match of the literal on a line of its own — leading/trailing whitespace on that line allowed, an optional single backtick directly on each side of the literal allowed, nothing else on the line: `/^\s*`?<promise>NO MORE TASKS<\/promise>`?\s*$/m`. It is the only place the sentinel is tested; `deriveStatus` and the gate decision in `runLoop` both call it, and no `includes(SENTINEL)` remains.
- **Mention warning** (stderr, plain text, the `[warning]` marker style of the sandbox-install block), written at the gate decision when the text contains the literal but `hasSentinel` is false, exactly one line:

  ```
  [warning] iteration <i>: the gate mentioned <promise>NO MORE TASKS</promise> without emitting it on a line of its own; the loop continues
  ```

  Nothing is written to the history file for it; the entry status is `ok` and the reviewer decision (HEAD moved or not) is untouched.

- **Playbook rule.** The one-line "if all tasks are complete, output …" instruction in `prompt.md` and `ghprompt.md` is replaced by a rule with the same meaning in both files: emit the sentinel only on an iteration with no task to pick up; do no other work then; end the final message with the sentinel on a line of its own; never mention it in prose or in a message that reports completed work (a mention does not end the run; the next iteration emits it). The **FINAL MESSAGE** section is unchanged.
- **Docs wording.** Every description of the gate that says "contains" / "emits" now says the sentinel must stand on a line of its own. Sites: README (`ralph-afk` overview line, the "Sentinel check" step, the "Natural stop" bullet), `docs/ARCHITECTURE.md` (the gate paragraph), `CONTRIBUTING.md` (both invariant bullets), `CONTEXT.md` (overview line), `CLAUDE.md` and `AGENTS.md` (the `loop.ts` architecture bullet and the "First stage is always the gate" convention; identical edits).
- **No knob.** No flag, no environment variable. Rollback = revert the slice's commits.
- **Verification**: per phase, the targeted suite by file path plus the core typecheck; the whole-repo gate (`pnpm -r typecheck && pnpm -r test && pnpm test`) is the review session's job, not a per-phase criterion.

---

## Phase 1: The gate and the history status fire only on a standalone sentinel line

**User stories**: 1, 2, 3, 4, 5, 7, 9

### What to build

In `loop.ts`, add the exported `hasSentinel` predicate beside the `SENTINEL` constant, switch `deriveStatus` and the `hitSentinel` decision in `runLoop` to it, and write the one-line stderr warning at the gate decision when `result.text` contains the literal but `hasSentinel(result.text)` is false. No other behaviour changes: the sentinel branch (history entry, footer, summary line, notify, early return) and the HEAD-based reviewer skip are untouched.

Pin it in `packages/core/src/__tests__/loop.test.ts`: direct cases on `hasSentinel`, one `deriveStatus` case, and two `runLoop` cases using the suite's mocked runner (`ok(text)`), temporary workspace and `process.stderr.write` spy.

### Acceptance criteria

- [ ] `hasSentinel` returns `true` for: the bare literal; `"\n  <promise>NO MORE TASKS</promise>  \n"`; ``"`<promise>NO MORE TASKS</promise>`"`` on its own line; a **Done / Blocked / Next** message whose last line is the literal.
- [ ] `hasSentinel` returns `false` for: `"Opening/merging the PR is HITL, so the next iteration should emit `<promise>NO MORE TASKS</promise>`."` (the sentence from the 2026-09-08 runs); `"<promise>NO MORE TASKS</promise> — nothing left"` (trailing words on the line); `"still working"`.
- [ ] `deriveStatus({ isGate: true, text: <the evidence sentence>, meta: {}, headBefore: "-", headAfter: "-" })` → `"ok"`; the existing `no-more-tasks` case for the bare literal keeps passing.
- [ ] `runLoop`, two-stage chain `[implementer, reviewer]`, 2 iterations, `runStage` resolving `ok(<the evidence sentence>)` for every call → the history footer matches `/--- ended · 2\/2 iterations · cap/`, both `implementer` entries carry `· ok ·`, the reviewer entries are `skipped` (HEAD unchanged, as today), and the joined stderr writes contain `[warning] iteration 1: the gate mentioned <promise>NO MORE TASKS</promise> without emitting it on a line of its own; the loop continues` and the same line for iteration 2.
- [ ] `runLoop`, two-stage chain, 2 iterations, `runStage` resolving a message `"**Done**\n\n- nothing to pick up\n\n**Blocked**\n\n- Nothing.\n\n**Next**\n\n- none\n\n<promise>NO MORE TASKS</promise>"` → the footer matches `/--- ended · 1\/2 iterations · no-more-tasks/`, `runStage` was called once, and the joined stderr contains no `[warning] iteration`.
- [ ] Every existing loop test keeps passing unchanged (they feed the bare literal, which `hasSentinel` accepts).
- [ ] `grep -o "includes(SENTINEL)" packages/core/src/loop.ts | wc -l` reads 0 (today 2); `grep -o "hasSentinel" packages/core/src/loop.ts | wc -l` reads ≥ 3 (today 0: the export plus the two call sites); `grep -o "export function hasSentinel" packages/core/src/loop.ts | wc -l` reads 1; `grep -o "without emitting it on a line of its own" packages/core/src/loop.ts | wc -l` reads 1 (today 0).
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/loop.test.ts` green (today 43 tests; this phase adds at least four) and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Phase 2: The playbooks and the docs state the standalone rule

**User stories**: 6, 8

### What to build

- `packages/core/templates/prompt.md` (line "Work through the plan/PRD tasks. If all of them are complete, output …") and `packages/core/templates/ghprompt.md` (line "If all AFK tasks are complete, output …"): replace each with the playbook rule from the architectural decisions, in that file's own voice. Both must say, in this order: emit the sentinel only on an iteration with no task to pick up; do no other work on that iteration; end the final message with `<promise>NO MORE TASKS</promise>` on a line of its own; never mention it in prose, and never in a message that reports completed work — a mention does not end the run, the next iteration will emit it. Keep it to at most four sentences. The **FINAL MESSAGE** section and everything else in both files is untouched.
- Docs, one sentence each, so that the gate is described as firing on the sentinel **on a line of its own** (use that phrase verbatim so the check below reads it):
  - `README.md`: the `ralph-afk` overview line ("iterates until the agent emits …"), the "Sentinel check" numbered step under "How `ralph-afk` works", and the "Natural stop" bullet.
  - `docs/ARCHITECTURE.md`: the "The first stage of a chain is always the gate" paragraph — "checks the captured `result` for the exact literal sentinel" becomes a check for the literal on a line of its own, naming `hasSentinel` as the predicate beside the existing `SENTINEL` mention, and adds one sentence: a mention inside prose does not gate and prints a `[warning]` line.
  - `CONTRIBUTING.md`: both "first stage is the gate" bullets.
  - `CONTEXT.md`: the overview sentence "when its final message contains …".
  - `CLAUDE.md` and `AGENTS.md`: the `loop.ts` bullet under Architecture and the "First stage is always the gate" bullet under Conventions — identical edits in both files.
- No README troubleshooting entry, no env-var table change.

### Acceptance criteria

- [ ] `grep -o "on a line of its own" packages/core/templates/prompt.md | wc -l` reads 1 and the same for `ghprompt.md` (today 0 each); `grep -o "never mention it" packages/core/templates/prompt.md packages/core/templates/ghprompt.md | wc -l` reads 2 (today 0).
- [ ] `grep -o "If all AFK tasks are complete, output" packages/core/templates/ghprompt.md | wc -l` reads 0 (today 1); `grep -o "If all of them are complete, output" packages/core/templates/prompt.md | wc -l` reads 0 (today 1).
- [ ] `grep -o "on a line of its own" README.md | wc -l` reads 3; `docs/ARCHITECTURE.md` reads ≥ 1 and `grep -o "hasSentinel" docs/ARCHITECTURE.md | wc -l` reads ≥ 1; `CONTRIBUTING.md` reads 2; `CONTEXT.md` reads 1; `CLAUDE.md` reads 2; `AGENTS.md` reads 2 (all today 0).
- [ ] `diff <(sed -n '/^## Architecture/,/^## Files for orientation/p' CLAUDE.md) <(sed -n '/^## Architecture/,/^## Files for orientation/p' AGENTS.md)` is empty (the twins stay in sync).
- [ ] `grep -o "FINAL MESSAGE" packages/core/templates/prompt.md packages/core/templates/ghprompt.md | wc -l` still reads 2, and `grep -o "Done\*\*, \*\*Blocked\*\*, and \*\*Next\*\*" packages/core/templates/prompt.md packages/core/templates/ghprompt.md | wc -l` still reads 2.
- [ ] `git diff --stat` for the eight files shows only the edited sentences — no whole-file line-ending rewrite. The index holds them as LF while the Windows host checks them out as CRLF (`core.autocrlf=true`, no `.gitattributes`) and the sandbox's git does not normalize on commit, so BUILD LF-normalizes each file and proves it index-identical (`git hash-object <file>` equals `git rev-parse HEAD:<file>`) before editing.
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/render.test.ts` green (the templates still render) and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Slice mapping

| Phase | Issue | Blocked by |
| ----- | ----- | ---------- |
| 1     | #138  | none       |
| 2     | #139  | #138       |

## Review session gate

`pnpm -r typecheck && pnpm -r test && pnpm test`, then the ACs of both phases re-run against the branch tip. One PR for the whole slice; it closes #135.
