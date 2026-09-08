# Plan: Loop-end run summary (stdout line + history footer totals)

> Source PRD: [docs/prd/run-summary.md](../prd/run-summary.md)

## Architectural decisions

Durable decisions that apply across all phases:

- **Totals live in the history writer.** The writer already receives every stage entry; it accumulates the run summary from them and exposes it through one read-only method. The loop driver never sums anything.
- **Run summary shape**: stages run (every entry whose status is not `skipped`; `failed` counts as run), stages skipped, cost (sum over entries carrying `costUsd`, absent when none does), input and output tokens (sums over entries carrying both, absent when none does), and wall time measured from the writer's opening.
- **One renderer for the totals segment**, exported from the history module and used by both the footer and the stdout line: ` · <run> stages` + ` (<k> skipped)` only when k > 0 + ` · $<cost>` only when present + ` · <in>k in / <out>k out` only when present + ` · <duration>`. Cost uses two decimals; tokens use the entry header's thousands formatting (`3.0k`); duration uses the entry header's `formatDuration` (`42m10s`, `7s`). Nouns are always plural, matching the existing `1/1 iterations`.
- **Footer**: today's prefix byte-for-byte — `--- ended · <completed>/<iterations> iterations · <reason>` — followed by the totals segment. The tail parser keys on the `--- ended ` prefix and is untouched.
- **Stdout line**: `<marker> Ralph ended · <reason> · <completed>/<iterations> iterations` + the totals segment, printed by the loop driver right after each footer write (sentinel, cap, failed). Reason tokens are the footer's own (`no-more-tasks`, `cap`, `failed`). Marker = the existing stdout bullet, green for `no-more-tasks` / `cap`, red for `failed`; plain form (`*`, no ANSI) when stdout is not a TTY or `NO_COLOR` is set, through the existing stdout styling gate. The line replaces `Ralph complete after N iterations` on stdout; the `--notify` toast keeps its `Ralph complete` title and arguments.
- **Signal path unchanged**: the `aborted` entry stays terminal; no footer, no summary line, exit codes 130 / 143 as today.
- **No knob**: no flag, no environment variable. Rollback = revert the feature commits.
- **Verification**: per phase, the targeted suite by file path plus the core typecheck; the whole-repo gate (`pnpm -r typecheck && pnpm -r test && pnpm test`) is the review session's job, not a per-phase criterion.

---

## Phase 1: The history writer accumulates run totals and the footer carries them

**User stories**: 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 18, 19, 20, 21, 22

### What to build

Give the history writer a run-summary accumulator fed by its own append method, a read-only `runSummary()` method returning the current totals, and an exported `renderRunTotals(summary)` that renders the totals segment described above. `appendFooter` keeps its signature and appends the totals segment after today's prefix. Wall time starts when the writer opens.

Pin it in the history suite with writer tests that append entries carrying various metadata shapes and read the file back, and one tail-loader case whose fixture footer carries the totals segment.

### Acceptance criteria

- [ ] Writer opened with 3 iterations; append `implementer · ok` with `costUsd 1.0, inputTokens 2000, outputTokens 1000`, `reviewer · review-ok` with `costUsd 0.5, inputTokens 1000, outputTokens 500`, then `reviewer · skipped` (no meta); `appendFooter(2, "no-more-tasks")` → the file's last line matches `/^--- ended · 2\/3 iterations · no-more-tasks · 2 stages \(1 skipped\) · \$1\.50 · 3\.0k in \/ 1\.5k out · \d+s$/`, and `runSummary()` reports `{ stagesRun: 2, stagesSkipped: 1, costUsd: 1.5, inputTokens: 3000, outputTokens: 1500 }` plus a non-negative duration.
- [ ] Entries carrying tokens but no cost (the Codex shape) → the footer contains `k in /` and no `$`; `runSummary().costUsd` is `undefined`.
- [ ] Entries carrying no meta at all → the footer matches `/· 1 stages · \d+s$/` and contains neither `$` nor `k in`.
- [ ] A `failed` entry counts as run: one `failed` entry alone → the footer contains `· 1 stages ·`; no `skipped)` text.
- [ ] No skipped entries → the footer contains no `(` at all (the skipped count is omitted, not rendered as `(0 skipped)`).
- [ ] The existing footer expectation `/--- ended · 2\/3 iterations · no-more-tasks$/` in the history suite is loosened to a prefix match (`/--- ended · 2\/3 iterations · no-more-tasks · /`) and keeps passing; the tail-loader fixture helper writes a footer carrying a totals segment (e.g. `--- ended · N/N iterations · cap · N stages · 5s`) and every tail-loader test keeps passing unchanged.
- [ ] `grep -o "runSummary" packages/core/src/history.ts | wc -l` reads ≥ 2 (today 0); `grep -o "renderRunTotals" packages/core/src/history.ts | wc -l` reads ≥ 2 (today 0); `grep -o "startsWith(\"--- ended \")" packages/core/src/history.ts | wc -l` still reads 1 (the parser is untouched).
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/history.test.ts` green (today 22 tests; this phase adds at least four) and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Phase 2: The loop prints the summary line on every non-signal exit

**User stories**: 1, 2, 7, 14, 15, 16

### What to build

At each of the loop driver's footer writes (sentinel, cap, failed), print one stdout line after the footer: marker + `Ralph ended · <reason> · <completed>/<iterations> iterations` + `renderRunTotals(history.runSummary())`. Delete the `Ralph complete after N iterations` line. Add a red stdout styling helper beside the green one in the stream renderer, gated by the same stdout rule; the `failed` reason uses it for the marker, the other two keep green. Nothing changes on the signal path or in the notify calls.

Pin it in the loop suite: stdout is already mocked there (`process.stdout.write` spy), so each case joins the spy's calls and asserts the plain-form line (stdout is not a TTY under vitest, so the marker is `*`).

### Acceptance criteria

- [ ] Gate emits the sentinel on iteration 1 of 1, stub result meta `costUsd 0.25` → stdout contains `* Ralph ended · no-more-tasks · 1/1 iterations · 1 stages · $0.25 · ` and the file's footer starts with `--- ended · 1/1 iterations · no-more-tasks · 1 stages · $0.25`.
- [ ] Two-stage chain, git workspace, implementer stub commits nothing, 1 iteration → stdout contains `* Ralph ended · cap · 1/1 iterations · 1 stages (1 skipped) · `.
- [ ] Gate stage fails after retries, 1 iteration → stdout contains `* Ralph ended · failed · 1/1 iterations · 1 stages · `.
- [ ] Stub results carrying no meta → the stdout line contains neither `$` nor `k in`.
- [ ] SIGINT during a stage (existing abort test) → stdout contains no `Ralph ended` and the file has no `--- ended` line, as today.
- [ ] `grep -o "Ralph complete" packages/core/src/loop.ts | wc -l` reads 0 (today 1); `grep -o "Ralph ended" packages/core/src/loop.ts | wc -l` reads ≥ 1 (today 0); `grep -o "redOut" packages/core/src/stream-render.ts | wc -l` reads ≥ 1 (today 0); `grep -o "Ralph complete" packages/core/src/notify.ts | wc -l` still reads 1 (the toast title is untouched).
- [ ] Every existing footer expectation in the loop suite (`/--- ended · 1\/1 iterations · failed/`, `· no-more-tasks/`, `· cap/`) keeps passing unchanged — they are prefix matches already.
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/loop.test.ts src/__tests__/stream-render.test.ts` green (today 36 + 4 tests; this phase adds at least three to the loop suite) and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Phase 3: Docs show the summary line and the footer totals

**User stories**: 17

### What to build

Update the user-facing runtime docs to the new exit output, in one sentence or example each:

- README loop steps: step 3 (sentinel check) no longer says `print Ralph complete after <N> iterations.`; instead a new final step after the reviewer step states that every exit (sentinel, cap, failed) prints the `Ralph ended · <reason> · …` summary line with stages, cost, tokens and wall time, and that the history footer carries the same totals — quote one example line and one example footer.
- Architecture reference: the loop pseudocode's `print "Ralph complete"` becomes `print run summary`; the sentinel paragraph's `prints \`Ralph complete\``becomes the`Ralph ended · no-more-tasks` line; the history paragraph's "a footer on exit" becomes "a footer with run totals on exit".
- `CLAUDE.md` and `AGENTS.md` (twins, edit both identically): the `history.ts` entry's "footer on exit (`no-more-tasks` / `cap`)" becomes "footer with run totals on exit (`no-more-tasks` / `cap` / `failed`)".

The historical PRDs/plans that deferred this item stay as they are.

### Acceptance criteria

- [ ] `grep -o "Ralph complete" README.md docs/ARCHITECTURE.md | wc -l` reads 0 (today 3); `grep -o "Ralph ended" README.md docs/ARCHITECTURE.md | wc -l` reads ≥ 2 (today 0); `grep -o -- "--- ended" README.md | wc -l` reads ≥ 1 (today 0).
- [ ] `grep -o "footer with run totals" docs/ARCHITECTURE.md CLAUDE.md AGENTS.md | wc -l` reads 3 (today 0); `grep -o 'footer on exit (`no-more-tasks`/`cap`)' CLAUDE.md AGENTS.md | wc -l` reads 0 (today 2).
- [ ] `diff <(grep -n '^7\. \*\*`history.ts`' CLAUDE.md | cut -d: -f2-) <(grep -n '^7\. \*\*`history.ts`' AGENTS.md | cut -d: -f2-)` is empty (the twins stay identical on that entry).
- [ ] Verification: `pnpm exec prettier --check README.md docs/ARCHITECTURE.md CLAUDE.md AGENTS.md` green and `pnpm test` at the root green (`scripts/*.test.mjs`; docs-only phase, nothing else moves).

---

## Slice mapping

One pull request; one issue per phase, in dependency order: Phase 1 → Phase 2 → Phase 3 (Phase 3 documents Phases 1–2, so it lands last).

| Phase | Issue                  |
| ----- | ---------------------- |
| 1     | #121                   |
| 2     | #122 (blocked by #121) |
| 3     | #123 (blocked by #122) |
