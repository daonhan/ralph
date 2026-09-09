# PRD: The sentinel gate fires only on a standalone emission

> Tracks GitHub issue #135. The loop today ends on any _mention_ of `<promise>NO MORE TASKS</promise>` in the gate stage's final message; this slice makes it end only on an emission that stands on a line of its own, and teaches the agent playbooks to emit it that way.

## Problem Statement

The loop driver decides "no more work" with a bare substring test over the gate stage's whole completion text. An implementer that merely **mentions** the sentinel ends the run exactly as one that emits it does.

This is not a corner case: on this repository, every `ralph-ghafk` run that has ended with `no-more-tasks` so far (three runs on 2026-09-08, behind PRs #116, #125 and #132) ended on the same sentence in the implementer's **Next** section — "Opening/merging the PR is HITL, so the next iteration should emit `<promise>NO MORE TASKS</promise>`." The agent was describing what the _next_ iteration should do; Ralph read it as the signal, wrote `--- ended · 3/4 iterations · no-more-tasks` and exited 0. Not one of those runs contained a standalone emission.

Each time the queue really was empty, so the early stop was harmless. Two ways it is not:

1. **A truncated run reads as finished.** The same closing sentence with AFK issues still open ends the loop early, exits 0, writes `no-more-tasks` in the history footer and no `[failure]` marker. A supervisor that trusts the sentinel accepts a short run as a complete one.
2. **The last commit skips the reviewer.** The sentinel branch returns before the reviewer stage, so the work committed in the same iteration — a real commit, in all three runs — never gets a reviewer pass. That is by design when the agent did no work; it is an unintended gap when the "sentinel" was a sentence about the future.

The phrasing that triggers it is natural — an agent explaining its own stop condition — and the playbooks name the sentinel verbatim, so the exact string is in context every iteration. The playbooks also invite the confusion: they say "if all tasks are complete, output the sentinel" and, later, "end your turn under **Done / Blocked / Next**", so an agent that has just closed the last issue reasonably writes the sentinel into **Next**.

## Solution

The gate fires only when the sentinel stands on a line of its own in the gate stage's final message — the line may carry surrounding whitespace, and may wrap the literal in a pair of backticks (the form the playbook itself uses), and nothing else. A sentinel embedded in a sentence is a mention and does not end the run.

When the gate's text contains the literal but no standalone line, the loop prints one stderr warning in the existing `[warning]` style — naming the iteration, saying the sentinel was mentioned but not emitted, and that the loop continues — so a user watching the terminal sees why a run that "said NO MORE TASKS" kept going.

The playbooks (`prompt.md` for `ralph-afk`, `ghprompt.md` for `ralph-ghafk`) tell the agent the rule that makes the gate sound: emit the sentinel **only on an iteration where there was no task to work on**, as the last line of the final message, on its own; never quote it in prose, and never in a message that reports completed work — the next iteration ends the run. That keeps the reviewer pass for the last commit and removes the sentence that triggered every false stop so far.

The user-facing documentation that describes the gate (README, architecture reference, contributor guide, `CONTEXT.md`, `CLAUDE.md`/`AGENTS.md`) says "on a line of its own" wherever it says "emits" or "contains" today.

## User Stories

1. As a Ralph user running `ralph-ghafk` with issues still open, I want an implementer that _talks about_ the sentinel not to end my run, so that a truncated run cannot present itself as a finished one.
2. As a Ralph user, I want the commit made by the last working iteration to get its reviewer pass, so that the sentinel only skips the reviewer on an iteration that produced nothing to review.
3. As a Ralph user watching the terminal, I want a `[warning]` line when the gate mentioned the sentinel without emitting it, so that I understand why the run continued past a message that named it.
4. As a Ralph user, I want a genuine emission — the sentinel alone on a line, with or without surrounding whitespace or wrapping backticks — to end the run exactly as today (history entry `no-more-tasks`, footer, summary line, notify), so that nothing about the normal stop changes.
5. As a Ralph user reading `.ralph/history/`, I want the gate stage's recorded status to agree with the loop's decision (`no-more-tasks` only for a standalone emission, `ok` for a mention), so that the history is not contradicted by the footer.
6. As the AFK agent reading the playbook, I want one unambiguous rule for when and how to write the sentinel, so that I neither end the run by accident nor waste an iteration by wrapping a real emission in prose.
7. As a Ralph maintainer, I want the standalone test in one exported predicate used by both the gate decision and the history status, so that the two can never disagree and the predicate has direct unit tests.
8. As a reader of the README, architecture reference or contributor guide, I want the gate described as it now behaves, so that the documented runtime matches the code.
9. As a Ralph maintainer, I want no new flag or environment variable, so that the knob table does not grow for a check that has no sensible opposite.

## Implementation Decisions

- **One predicate.** The loop driver exports a small pure function that answers whether a completion text contains the sentinel on a line of its own: a multiline anchored match of the literal, allowing leading/trailing whitespace on that line and an optional single backtick on each side of the literal. Both the gate decision and the gate's history status (`deriveStatus`) call it; the bare substring test is removed from both.
- **Mention warning.** Right where the gate decision is made, when the text contains the literal but the predicate is false, the driver writes one stderr line in the `[warning]` marker style already used for the sandbox-install check: `[warning] iteration <i>: the gate mentioned <promise>NO MORE TASKS</promise> without emitting it on a line of its own; the loop continues`. Nothing is written to the history file for it; the entry's status is the ordinary `ok`. The reviewer decision that follows (HEAD moved or not) is unchanged.
- **Playbook rule.** In both playbooks the one-line "if all tasks are complete, output the sentinel" instruction becomes a short rule stating: emit it only when there was no task to pick up this iteration; then do no other work, and end the final message with the sentinel on its own line; never mention it in prose or in a message that reports completed work, because a mention does not end the run and the next iteration will emit it. The **Done / Blocked / Next** final-message section is otherwise unchanged.
- **Documentation.** Every sentence that says the loop stops when the completion "contains" or the implementer "emits" the sentinel now says it must stand on a line of its own: README (three sentences), the architecture reference's gate paragraph, the contributor guide's two invariant bullets, `CONTEXT.md`'s overview line, and the `loop.ts` bullet plus the "first stage is the gate" convention in `CLAUDE.md` and `AGENTS.md` (identical edits, the twins stay in sync). The README troubleshooting section gains no entry: the stderr warning is self-explanatory and names the fix.
- **No knob.** No flag, no environment variable. Rollback is a revert of the slice's commits; the previous substring behaviour returns with them.

## Testing Decisions

- **What makes a good test here.** The predicate's contract is which texts it accepts; the loop's contract is what reaches the history file, the footer, stderr and the stage count. Tests feed completion texts through the existing mocked runner and assert on those outputs. No test asserts on the regex itself.
- **Modules under test.** The loop driver's suite (`loop.test.ts`): the exported predicate directly, `deriveStatus`, and `runLoop` end to end with the mocked runner and temporary workspace pattern the suite already uses.
- **Cases, predicate.** Bare literal → true. Literal with leading/trailing spaces and newlines around the line → true. Literal wrapped in single backticks on its own line → true. The literal as the last line under a **Next** heading → true. The exact sentence from the 2026-09-08 runs ("…so the next iteration should emit `<promise>NO MORE TASKS</promise>`.") → false. The literal followed by more words on the same line → false. Text without the literal → false.
- **Cases, `deriveStatus`.** Gate with the evidence sentence → `ok`; gate with a standalone line → `no-more-tasks` (the existing case keeps passing).
- **Cases, loop driver.** Two-stage chain, two iterations, the gate returns the evidence sentence every time → the run reaches the cap (footer `--- ended · 2/2 iterations · cap`), every gate entry is `ok`, the stderr writes contain the `[warning] iteration 1: the gate mentioned …` line, and the reviewer decision is untouched (HEAD unchanged in the mock → `skipped` entries as today). Two-stage chain, gate returns a **Done / Blocked / Next** message whose last line is the sentinel → ends after the one stage with `no-more-tasks` exactly as the existing sentinel tests expect, and stderr carries no `[warning]`. All existing tests that feed the bare literal keep passing unchanged.
- **Prior art.** The loop suite's `ok(text)` mock, its temporary-workspace history assertions (`/--- ended · 1\/1 iterations · no-more-tasks/`), and its `process.stderr.write` spy joined into one string.

## Out of Scope

- Cross-checking the queue (an implementer sentinel while `gh issue list` still returns open agent-ready issues). That needs a provider- and bin-specific query the loop does not own today; the standalone rule already removes every false stop observed.
- The `|||[]` spill-fallback problem (an empty queue _manufactured_ by a failed `gh` call) — a separate defect in the templates.
- Changing the sentinel literal, or accepting other spellings (`NO MORE TASKS` without the tags, lower case).
- A history-file marker for the mention; stderr is enough for a run the user is watching, and the entry status stays `ok` on purpose.
- Anything about the reviewer's `<review>OK</review>` / `<review>SKIP</review>` tags, which have the same substring shape but no observed false hit and never gate.

## Further Notes

- Evidence (this workspace, `.ralph/history/`, 2026-09-08): runs `124201`, `133649` and `151612` each ended `no-more-tasks` on the sentence "…so the next iteration should emit `<promise>NO MORE TASKS</promise>`." inside the **Next** section of a message whose **Done** section reports a shipped commit. Zero standalone emissions across all recorded runs. The completion text the gate reads is the provider's final message only (Claude: the `result` record's string; Codex: the last `agent_message` before `turn.completed`), so "a line of its own" is well defined.
- Cost of the rule: a run whose last working iteration used to end on the mention now spends one more iteration, in which the agent finds no task and emits the sentinel. The BUILD handoff already budgets that iteration (`iterations = open issues + 1`), and it is the iteration that gives the last commit its reviewer pass.
- Stress-test & provoke:
  - Killer assumption: [problem] agents mention the sentinel in prose → probe: three of three recorded `no-more-tasks` exits were mentions, none standalone.
  - Other assumptions: [solution] a standalone line is a shape agents reliably produce when told — the playbook change is load-bearing, which is why it ships in the same slice; [feasibility] one regex and one stderr line, no new module.
  - Strongest counter: a legitimate emission written inline ("Done. <promise>NO MORE TASKS</promise>") now costs an extra iteration — survives because the failure is fail-open (the loop continues, the warning names the cause) and the playbook rule removes the shape.
  - Would be unnecessary if: the providers exposed a structured "done" signal distinct from message text — they do not.
