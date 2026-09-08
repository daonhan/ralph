# PRD: Loop-end run summary (stdout line + history footer totals)

## Problem Statement

A Ralph run ends in one of three ways: the implementer emits the sentinel, the iteration cap is reached, or the last iteration's stage fails after all retries. Only the first prints anything: a single line, `Ralph complete after N iterations`. The other two exits are silent — the terminal simply stops after the last stage's stream, so a user returning to an AFK run cannot tell from the terminal whether the loop finished, died, or is still waiting on a container. The slice-cycle tooling that drives this repository's own development already documents that silence as a gotcha ("an iteration-cap exit prints nothing, so silence is not failure").

Nothing tells the user what the run cost. Since 0.8.0 every stage entry in `.ralph/history/` carries its own duration, cost, turns and tokens (from the provider's `result` record), but no total exists anywhere: not on the terminal, not in the history footer, which reads only `--- ended · 2/3 iterations · cap`. To learn what a six-iteration run spent, the user opens the history file and adds up to twelve `$` figures by hand. Three earlier PRDs deferred this exact item ("surfacing usage tokens / cost / duration in a final summary line", "a loop-end cost summary") because no per-stage accumulator existed yet; it exists now.

## Solution

Every non-signal loop exit ends with one summary line on stdout, and the history footer carries the same totals.

The stdout line reads, for example:

```
● Ralph ended · cap · 3/3 iterations · 5 stages (1 skipped) · $4.12 · 118.3k in / 9.6k out · 42m10s
```

The leading token is the same bullet the sentinel line uses today; the reason token is exactly the footer's (`no-more-tasks`, `cap`, `failed`), so one vocabulary covers the terminal, the history file and the docs. A `failed` exit renders the bullet in red. Cost and tokens appear only when at least one stage reported them (Codex reports tokens but no cost; a stage whose provider emitted no `result` record reports neither). The skipped count appears only when at least one stage was skipped. Duration is wall time from the history file's opening to the footer.

The footer keeps its prefix verbatim and appends the same totals:

```
--- ended · 3/3 iterations · cap · 5 stages (1 skipped) · $4.12 · 118.3k in / 9.6k out · 42m10s
```

The Ctrl+C / SIGTERM path is unchanged: the signal handler writes the `aborted` entry and exits the process, so neither a footer nor a summary line follows, as today.

## User Stories

1. As a Ralph user returning to an AFK terminal, I want the loop to print one final line on every normal exit, so that I can tell at a glance that the run ended rather than hung.
2. As a Ralph user, I want that line to name the exit reason, so that I know whether the agent ran out of tasks, hit the iteration cap, or failed.
3. As a Ralph user paying per token, I want the line to carry the run's total cost, so that I know what the run spent without opening the history file.
4. As a Ralph user, I want the line to carry total input and output tokens, so that a run whose provider reports no dollar cost (Codex) still shows its size.
5. As a Ralph user, I want the line to carry the run's wall time, so that I can compare runs and size the next one's iteration count.
6. As a Ralph user, I want the line to say how many stages actually ran and how many were skipped, so that the reviewer-skip rule's savings are visible per run.
7. As a Ralph user, I want the `failed` exit visually distinct (red marker), so that a failed run is not mistaken for a completed one when skimming a scrollback.
8. As a Ralph user reading `.ralph/history/`, I want the footer to carry the same totals, so that the file is self-describing after the terminal is gone.
9. As a Ralph user comparing history files, I want the footer's existing prefix (`--- ended · N/M iterations · <reason>`) unchanged, so that anything that already reads or greps the footer keeps working.
10. As the next implementer iteration reading `{{ HISTORY }}`, I want the longer footer to be ignored exactly as the short one was, so that the injected history block is unaffected.
11. As a Codex user (`--agent codex`), I want the summary to omit the cost segment rather than print `$0.00`, so that the line never claims a figure the provider did not report.
12. As a Ralph user whose provider emitted no usage at all (an early failure, a hang recovered by the grace timer), I want the summary to omit the cost and token segments, so that the line only shows what was measured.
13. As a Ralph user, I want a stage that failed after retries counted as a stage that ran, so that its cost and time are in the totals.
14. As a Ralph user interrupting a run with Ctrl+C, I want the exit code, the `aborted` entry and the absence of a footer unchanged, so that signal handling is untouched.
15. As a Ralph user with `--notify`, I want the OS toast to behave exactly as before, so that this slice changes only the terminal line and the footer.
16. As a Ralph user with `NO_COLOR` or a non-TTY stdout, I want the plain-text form of the line (`*` marker, no ANSI), so that logs captured by `--detach` stay readable.
17. As a reader of the README and the architecture reference, I want the loop-exit description to show the summary line and the footer, so that the documented runtime matches the code.
18. As a Ralph maintainer, I want the totals computed in one place from the entries the history writer already receives, so that the stdout line and the footer can never disagree.
19. As a Ralph maintainer, I want the rendering of the totals segment shared between the footer and the stdout line, so that a format change is one edit.
20. As a Ralph maintainer, I want the totals covered by history-writer tests (cost present/absent, tokens present/absent, skipped count, failed stage counted) and the stdout line covered by loop tests for all three exit reasons, so that the contract is pinned at the seams the existing suites already use.
21. As a Ralph maintainer, I want the whole change to be a small change to the history writer, a few lines in the loop driver, one styling helper, tests and doc sentences, so that a single `git revert` restores today's behavior.
22. As a Ralph maintainer, I want no new flag or environment variable, so that the knob table does not grow for output that has no sensible opposite.

## Implementation Decisions

- **Where the totals live.** The history writer already receives every stage entry through its append method. It accumulates a run summary as entries arrive: stages run (every entry whose status is not `skipped`), stages skipped, cost summed over entries that carry a cost, input and output tokens summed over entries that carry both, and wall time measured from the writer's opening. The writer exposes the current summary through a new read-only method; the loop driver never sums anything itself.
- **One renderer for the totals segment.** A single function renders the summary into the ` · N stages[ (k skipped)] · $x · Ak in / Bk out · <m>m<ss>s` segment, with each optional part emitted only when present, using the same thousand-token and duration formatting the entry headers already use. The footer and the stdout line both call it.
- **Footer.** `--- ended · <completed>/<iterations> iterations · <reason>` followed by the totals segment. The prefix is byte-identical to today's footer; the history tail parser keys on that prefix and is untouched.
- **Stdout line.** Printed by the loop driver at the three places that write a footer (sentinel, cap, failed), immediately after the footer is appended: marker + `Ralph ended` + ` · <reason> · <completed>/<iterations> iterations` + the totals segment. The marker is the existing stdout bullet, green for `no-more-tasks` and `cap`, red for `failed`; the wording `Ralph ended` replaces `Ralph complete after N iterations`. The line goes to stdout like its predecessor (stage banners and skip notices stay on stderr).
- **Styling.** The stdout styling helpers gain a red variant alongside the existing green one, gated by the same stdout TTY / `NO_COLOR` rule; the plain form uses the existing `*` marker and no escape codes.
- **Reason vocabulary.** The three reason tokens are the footer's existing strings, unchanged; the stdout line reuses them verbatim.
- **Signal path.** Unchanged. The `aborted` entry remains the file's terminal marker; no footer and no summary line are written, and the exit codes stay 130 / 143.
- **Notifications.** The completion and error toasts keep their current arguments and text.
- **Documentation.** The README's loop-steps list, the architecture reference's loop pseudocode and sentinel paragraph, and the one-line `history.ts` description in `CLAUDE.md` / `AGENTS.md` (twins, edited together) are updated to show the summary line and the footer totals. The historical PRDs that deferred this item are left as they are.
- **No knob.** No CLI flag, no environment variable. Rollback is a revert of the feature commit.

## Testing Decisions

- **What makes a good test here.** The history writer's contract is the text it writes to the file and the summary it reports; the loop driver's contract is what reaches stdout and the file. Tests assert on those, never on accumulator internals. Provider metadata is supplied through the same stage-result stubs the loop suite already uses.
- **Modules under test.** The history writer (totals accumulation and footer rendering) and the loop driver (the stdout line per exit reason). The styling helper is covered indirectly through the plain-text form the tests observe (stdout is not a TTY under vitest).
- **Cases, history writer.**
  1. Three entries, two with cost and tokens and one `skipped` → footer carries `2 stages (1 skipped)`, the summed `$`, the summed tokens, and a duration.
  2. Entries without cost but with tokens (the Codex shape) → footer carries the token segment and no `$` segment.
  3. Entries with no metadata at all → footer carries only the stage count and the duration.
  4. A `failed` entry → counted in the stages that ran.
  5. The footer prefix still matches the existing `--- ended · N/M iterations · <reason>` expectation, and the history tail loader still drops it.
- **Cases, loop driver.**
  1. Sentinel on the gate → stdout carries `Ralph ended · no-more-tasks · 1/1 iterations` and the totals from the stubbed metadata.
  2. Iteration cap with a skipped reviewer → stdout carries `· cap ·` and `(1 skipped)`.
  3. Stage failure after retries → stdout carries `· failed ·`.
  4. Existing footer expectations (`--- ended · 1/1 iterations · failed` and friends) keep passing unchanged, which pins the prefix.
- **Prior art.** The history suite's writer tests (header / entry / footer regexes) and its tail-loader fixtures; the loop suite's mocked runner + temporary workspace pattern, its stdout capture for the sentinel line, and its two-stage skip tests.

## Out of Scope

- A `--history` summary command or any aggregation across runs or files.
- Carrying totals into the `--notify` toast.
- Per-iteration subtotals, a cost budget, or any early exit on spend.
- A summary on the Ctrl+C / SIGTERM path.
- Changing entry headers, statuses, the tail loader's cap, or the templates.
- Rewriting the historical PRDs/plans that deferred this item.

## Further Notes

- Evidence for the gap: the loop driver's only end-of-run output is the sentinel branch's `Ralph complete after N iterations`; the cap and failed branches write a footer and return silently. The footer renderer takes only the completed count, the iteration cap and the reason. Per-stage `costUsd` / `turns` / `inputTokens` / `outputTokens` reach the writer today through the entry's metadata, where the entry header renders them.
- Provider shapes: the Claude adapter sets cost, turns and tokens from the `result` record; the Codex adapter sets tokens only. The "render only what is present" rule is the same one the entry header already applies.
- Stress-test & provoke (from selection):
  - Killer assumption: [problem] a returning AFK user cannot see what the run cost or how it ended without opening the history file → probe: the loop driver's exit branches read — cap and failed exits emit nothing, the footer carries no totals.
  - Other assumptions: [feasibility] per-stage metadata sums trivially; [user] the slice-cycle tooling's own budget rules show spend visibility matters to AFK users; [solution] one line plus the footer closes it.
  - Strongest counter: per-stage costs already sit in the history file, so this is cosmetic — survives because nobody opens a Markdown file after every run and the cap exit is silent today.
  - Would be unnecessary if: `--notify` already carried totals — it does not (the completion toast takes only the count and the sentinel flag).
