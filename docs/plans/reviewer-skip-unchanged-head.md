# Plan: Skip the reviewer stage when the implementer left HEAD unchanged

> Source PRD: [docs/prd/reviewer-skip-unchanged-head.md](../prd/reviewer-skip-unchanged-head.md)

## Architectural decisions

Durable decisions that apply across all phases:

- **Decision point**: the loop driver, right after the gate stage's history entry is written and the sentinel check did not return. Inputs: the short HEAD read before the gate stage and the one read after it (the same pair that already derives `review-fix`). Nothing in the renderer, runner or provider adapters changes.
- **Rule**: HEAD unchanged across the gate stage (string equality, the `-` placeholder of a non-git workspace included) → every later stage of that iteration is skipped: no render, no container, no provider call. HEAD moved → later stages run exactly as today.
- **Status vocabulary**: a new harness-owned status `skipped`, written directly by the loop (like `failed` / `aborted`), distinct from the agent-voiced `review-skip`. `deriveStatus` is not involved.
- **Skipped entry shape**: status `skipped`, duration 0, `HEAD <unchanged sha>`, `log: -` (no NDJSON file exists for a skipped stage), a one-sentence body naming the reason, and a `dirty:` line when uncommitted paths exist. No `retries`, `attempts` or meta segments.
- **Terminal output**: the normal stage banner, then one dim line on stderr: `skipped · HEAD unchanged (<sha>)`.
- **Loop control unchanged**: iteration counting, cap, footer reasons, sentinel exit, stage-failure break, signal handling and notifications are untouched. The sentinel path and the failure path leave the iteration before the decision point, so neither produces a `skipped` entry.
- **No knob**: no flag, no environment variable. Rollback = revert the feature commits.
- **Verification**: per phase, the targeted suite by file path plus the core typecheck; the whole-repo gate (`pnpm -r typecheck && pnpm -r test && pnpm test`) is the review session's job, not a per-phase criterion.

---

## Phase 1: The loop skips the reviewer when the gate left HEAD unchanged

**User stories**: 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 19, 20, 21, 22

### What to build

After the gate stage completes without the sentinel, compare its HEAD-before and HEAD-after readings. Unchanged → for each remaining stage in the iteration print the stage banner plus the dim `skipped · HEAD unchanged (<sha>)` line, append a `skipped` history entry (duration 0, `log: -`, body sentence, unchanged sha), and move on; the iteration still counts as completed. Moved → run the remaining stages as today.

Pin it in the loop suite with a real temporary git repository and an implementer stub that either commits or does not. The existing repo-initialising helper in that suite is the home for a "commit in the workspace" helper the committing stub calls; write it once, use it in every committing case.

The two existing two-stage tests ("does not inject history into the reviewer prompt" and "records the reviewer verdict and stage meta in the history entry") run in a non-git fixture and expect two runner calls: give each a git workspace and a committing implementer stub, keeping their assertions.

Update the loop-driver comment on the stages option ("Subsequent stages always run after a non-sentinel gate result") to state the new rule; the user-facing docs carrying the same sentence are Phase 3's.

### Acceptance criteria

- [ ] Two-stage chain, git workspace, implementer stub commits nothing → the mocked runner is called once; the history file contains `## iter 1/1 · reviewer · skipped · 0s`, `· HEAD <sha>` with the sha the implementer entry shows, and `log: -`; stderr (the mocked stream renderer's output) contains `skipped · HEAD unchanged (<sha>)`.
- [ ] Two-stage chain, git workspace, implementer stub commits → the runner is called twice and the reviewer entry status is derived from its verdict (`review-ok` for `<review>OK</review>`), unchanged from today.
- [ ] Two-stage chain, non-git workspace → the runner is called once and the reviewer entry is `skipped` with `HEAD -`.
- [ ] Gate emits the sentinel → one runner call, no `skipped` entry, footer `no-more-tasks` (existing behavior re-pinned).
- [ ] Gate stage fails after retries → the `failed` entry is the iteration's last entry; no `skipped` entry follows (existing test "logs terminal stage failure and continues" keeps passing).
- [ ] The two existing two-stage tests pass with a committing stub and their original assertions.
- [ ] `grep -o '"skipped"' packages/core/src/loop.ts | wc -l` reads ≥ 1 (today 0); `grep -o "Subsequent stages always run" packages/core/src/loop.ts | wc -l` reads 0 (today 1).
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/loop.test.ts` green (today 28 tests; this phase adds at least four) and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Phase 2: The skipped entry carries the dirty-tree snapshot and reaches the next implementer

**User stories**: 6, 7

### What to build

When the reviewer is skipped and the workspace has uncommitted paths, the `skipped` entry gets a `dirty:` line from the existing dirty-snapshot reader (the same one `failed` and `aborted` entries use). Because the gate stage's prompt is rendered from the history tail, the next iteration's implementer sees the `skipped` entry and its `dirty:` line inside `<history>` without any renderer change.

### Acceptance criteria

- [ ] Two-stage chain, git workspace, implementer stub commits nothing but leaves an untracked file → the `skipped` entry contains `dirty: 1 files — <name>`; a clean workspace produces no `dirty:` line on the entry.
- [ ] Two iterations, first implementer stub commits nothing, second commits → the runner is called three times; the second implementer prompt's `<history>` block contains `reviewer · skipped` from iteration 1 and its `dirty:` line; iteration 2's reviewer entry is a verdict status.
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/loop.test.ts` green and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Phase 3: Reviewer playbook and docs state the rule

**User stories**: 16, 17, 18

### What to build

Reduce the reviewer playbook's SKIP rule to the `(no commits)` case, deleting the clause "or HEAD is unchanged from the previous iteration" that the reviewer could never evaluate; keep the `<review>SKIP</review>` tag, the `<head>` prelude and everything else verbatim.

Replace the sentence "Subsequent stages always run after a non-sentinel gate result." in the README's stage-chain paragraph and the identical sentence in the loop-driver entry of both agent guides (`CLAUDE.md` and `AGENTS.md` mirror each other; edit both) with one stating the rule: later stages run only when the gate stage moved HEAD; otherwise the loop records a `skipped` history entry and starts no container. Add the same one sentence to the README's numbered "Reviewer stage" step and to the architecture reference's reviewer paragraph.

### Acceptance criteria

- [ ] `grep -o "HEAD is unchanged from the previous iteration" packages/core/templates/review.md | wc -l` reads 0 (today 1); `grep -o "<review>SKIP</review>" packages/core/templates/review.md | wc -l` still reads 1; `grep -o "(no commits)" packages/core/templates/review.md | wc -l` still reads 2.
- [ ] `grep -o "Subsequent stages always run after a non-sentinel gate" CLAUDE.md AGENTS.md README.md | wc -l` reads 0 (today 3).
- [ ] `grep -o "moved HEAD" README.md docs/ARCHITECTURE.md CLAUDE.md AGENTS.md | wc -l` reads ≥ 5 (today 0): README stage-chain paragraph, README reviewer step, ARCHITECTURE reviewer paragraph, CLAUDE.md and AGENTS.md loop entries.
- [ ] `diff <(sed -n '/^2\. \*\*`loop.ts`/p' CLAUDE.md) <(sed -n '/^2\. \*\*`loop.ts`/p' AGENTS.md)` is empty (the twins stay identical on that line).
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/template-contract.test.ts` green (the reviewer template keeps `AGENTS.md`, `CLAUDE.md`, no `<history>`); `pnpm test` at the root green (`scripts/smoke-templates` and friends render the shipped templates).

---

## Slice mapping

One pull request; one issue per phase, in dependency order: Phase 1 → Phase 2 → Phase 3 (Phase 3 is independent of Phase 2 but documents Phase 1's behavior, so it lands last).

| Phase | Issue                  |
| ----- | ---------------------- |
| 1     | #113                   |
| 2     | #114 (blocked by #113) |
| 3     | #115 (blocked by #113) |
