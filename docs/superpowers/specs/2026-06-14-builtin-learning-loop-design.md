# Design: built-in learning loop

Date: 2026-06-14
Status: Approved (brainstorm), pending spec review → implementation plan
Inspired by: [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) (agent-curated memory fed back across sessions).

## Summary

Give Ralph a persistent, accumulating memory so learnings carry across iterations
instead of evaporating with each `claude` invocation. Today only git history and the
last-5-commits block injected into each prompt carry context forward; there is no place
for the agent to record durable, reusable knowledge about the target repo.

Hermes bundles several mechanisms (agent-curated memory + reflection nudges + autonomous
skill creation + FTS5-searchable session history + user modeling). We deliberately port
**only the smallest piece that fits Ralph's minimalism**: a single committed memory file
read at the start of every stage and appended to inline as the agent works.

Decisions locked in brainstorm:

- **Scope:** lightweight memory file (not a skills system, reflection stage, or full Hermes port).
- **Persistence:** `<workspace>/.ralph/LEARNINGS.md`, **git-tracked** in the target repo (rides in the work commit; shows up in diffs/PRs).
- **Capture:** **inline** in the existing stages — no new stage, **zero extra `claude` calls** per iteration.
- **Feedback (read-back):** render-time injection, reusing the existing `!?` try-shell tag (same mechanism as the git-log block).
- Reviewer/lenses **read** learnings (so they don't re-flag accepted decisions); path is hardcoded `.ralph/LEARNINGS.md` (no env knob yet).

No TypeScript / harness code changes. This is a templates-only feature (plus a render test).
`templates/` already ships in the npm tarball, so it reaches consumers automatically.

## The memory file

`<workspace>/.ralph/LEARNINGS.md` — a new dir, distinct from the existing gitignored
`.ralph-tmp/`. **Committed** to the target repo. Created lazily by the agent on the first
durable learning (the harness never seeds it).

Lightly sectioned so entries stay scannable and dedupable:

```markdown
# Ralph learnings

Durable, reusable knowledge about this repo, accumulated across Ralph iterations.
Keep entries terse. Dedupe. Drop anything that's no longer true.

## Conventions

- repo uses pnpm, not npm

## Gotchas

- vitest needs `--run` in non-watch contexts

## Decisions

- chose X over Y because <one-line why>

## Dead ends

- tried Z; it fails because <reason> — don't retry
```

## Data flow (closed loop)

```
render  → injects current .ralph/LEARNINGS.md into the prompt (or fallback if absent)
agent   → consults learnings, does the task, appends any NEW durable learning
commit  → LEARNINGS.md change rides in the same work commit
render  → next iteration picks up the updated file
```

## Component 1 — Feedback (read-back), render-time injection

Add one line to each template that renders a prompt, injecting the file via the existing
try-shell tag with a missing-file fallback:

```
!?`cat ./.ralph/LEARNINGS.md` | _No learnings recorded yet._
```

Templates that get the block:

- `afk.md` (implementer) — near the existing recent-commits block.
- `ghafk.md` (ghafk implementer) — same.
- `review.md` (single reviewer) — so it won't re-flag accepted decisions.
- `review-lens.md` (panel lens, read-only) — same, for false-positive suppression.
- `review-synth.md` (panel synth) — so the committing stage sees them too.

Placed under a clear heading, e.g.:

```markdown
## Learnings (accumulated knowledge about this repo)

!?`cat ./.ralph/LEARNINGS.md` | _No learnings recorded yet._
```

## Component 2 — Capture (write), inline playbook instructions

Add a step to the agent playbooks. The bar is **durable + reusable** to avoid logging
task-specific noise:

- `prompt.md` (implementer playbook): after completing the task, if you discovered a
  durable, reusable learning — a repo convention, a non-obvious gotcha, a decision **and
  its why**, or a dead-end to avoid — append it (terse) to the right section of
  `./.ralph/LEARNINGS.md`, creating the file if absent. Dedupe against existing entries;
  prune anything now false. Commit it **with** the code change (do not make a separate
  commit). Do **not** log routine/one-off task details.
- `ghprompt.md` (ghafk implementer playbook): same addition.

Reviewer capture:

- **Single-reviewer mode** (`review.md`): the reviewer already commits `fix(review):`; it
  may append a review-derived learning to that commit (e.g. a recurring defect class).
- **Panel mode:** lenses (`review-lens.md`) are **read-only** and must **not** write —
  capture happens only in the **synth** stage (`review-synth.md`), which commits.

## Edge cases

- **Missing / empty file** → `!?` fallback text renders; nothing crashes.
- **Whitespace-only file** → treated as "no learnings" by the agent (instruction).
- **Panel read-only invariant** → lenses never write `LEARNINGS.md`; only synth/reviewer do.
  This preserves the existing "lenses are read-only" enforcement.
- **Token growth** → bounded by the dedupe/prune instruction and the "durable only" bar;
  the file is small by design. No automated consolidation (out of scope).
- **First run on a fresh repo** → no file yet; fallback renders; agent creates it on first
  durable learning. No bootstrap step required.

## Testing / success criteria

- **vitest (render):** render `afk.md` (and one reviewer template) with a seeded
  `.ralph/LEARNINGS.md` → its contents appear in the rendered prompt; render with **no**
  file → the fallback string appears. Mirrors existing render-tag tests in
  `packages/core/src/__tests__/`.
- **Manual smoke:** run `ralph-afk` for 2 iterations on a scratch repo →
  `.ralph/LEARNINGS.md` is created and committed, and its content appears in iteration 2's
  rendered prompt (visible in `.ralph-tmp/.run-*.md` or `.ralph-tmp/logs/*.ndjson`).
- **Regression:** `pnpm -r typecheck` + `pnpm -r test` + root `pnpm test` stay green
  (no TS touched).

## Out of scope (vs. full Hermes — each a possible later increment)

- Skills system (agentskills.io procedural-memory files).
- Dedicated reflection / "learner" stage and periodic consolidation nudges.
- FTS5-searchable session history + cross-run summarization.
- Honcho-style user modeling.
- Env-configurable memory path / opt-out flag.

## Files touched

- `packages/core/templates/afk.md` — add learnings read-back block.
- `packages/core/templates/ghafk.md` — add learnings read-back block.
- `packages/core/templates/review.md` — add read-back; allow append in single-reviewer mode.
- `packages/core/templates/review-lens.md` — add read-back (read-only, no write).
- `packages/core/templates/review-synth.md` — add read-back; allow append on commit.
- `packages/core/templates/prompt.md` — add capture step.
- `packages/core/templates/ghprompt.md` — add capture step.
- `packages/core/src/__tests__/` — render test for the learnings block + fallback.
- Docs: note `.ralph/LEARNINGS.md` in `README.md` and `CLAUDE.md` ("What persists between iterations").

```

```
