# PRD: Skip the reviewer stage when the implementer left HEAD unchanged

## Problem Statement

Every Ralph iteration runs two sandbox stages back to back: the implementer (the gate) and the reviewer. The loop driver starts the reviewer unconditionally whenever the implementer's completion text lacks the `<promise>NO MORE TASKS</promise>` sentinel. The reviewer's playbook tells it to review "the most recent commit (HEAD) produced by the implementer" and to answer `<review>SKIP</review>` when "HEAD is unchanged from the previous iteration" — but the reviewer prompt carries only the current HEAD sha, the last three commits and the HEAD patch. It receives nothing about the previous iteration, so it cannot honor that rule. Only the loop driver knows whether HEAD moved during the implementer stage (it already reads HEAD before and after every stage to derive the `review-fix` status).

The consequence is a paid, slow, pointless stage on every iteration where the implementer commits nothing: it ran out of ideas, hit a blocker without committing, spent its turn on a test suite that never finished, or left a draft uncommitted. Measured on this repository's own recent runs (`.ralph-tmp/logs/`), one reviewer stage costs between $0.33 and $1.57 and takes 75 to 330 seconds; each of those no-commit iterations re-reviews a commit the previous iteration's reviewer already judged. Worse, a reviewer that decides to "fix" something on such an iteration commits with `git commit -am`, which sweeps the implementer's uncommitted draft into a `fix(review):` commit under the reviewer's name.

The history file (`.ralph/history/`) also cannot tell a reader that the reviewer had nothing to review: today a no-commit iteration shows a `review-ok` or `review-skip` entry that looks like a real review.

## Solution

The loop driver decides, not the reviewer. After the gate stage completes without the sentinel, the driver compares the workspace HEAD it read before the stage with the HEAD it reads after. If HEAD did not move, every later stage of that iteration is skipped: no prompt is rendered, no container is started, no provider call is made. The driver prints a one-line notice under the stage banner and records a history entry with the status `skipped`, the unchanged HEAD sha, and the dirty-tree snapshot (so the next implementer iteration sees, through `{{ HISTORY }}`, both that nothing was committed and which files were left behind). The iteration then completes normally and the loop advances to the next one; the iteration cap and footer are unchanged.

If HEAD moved, nothing changes: the reviewer runs exactly as today and its statuses (`review-ok`, `review-skip`, `review-fix`) keep their meaning.

The reviewer playbook drops the "unchanged from the previous iteration" clause it could never evaluate and keeps the `(no commits)` case it can. The status vocabulary gains `skipped`; the user-facing docs describe the new rule in one sentence where they describe the reviewer stage.

## User Stories

1. As a Ralph user running an AFK loop, I want the reviewer stage not to start when the implementer committed nothing, so that a no-op iteration does not spend a container start and a paid agent turn on nothing.
2. As a Ralph user paying per token, I want a no-commit iteration to cost only the implementer stage, so that the reviewer's share of the budget goes to iterations that produced a commit.
3. As a Ralph user watching the terminal, I want a clear one-line notice that the reviewer was skipped and why, so that a shorter iteration does not look like a crash or a hang.
4. As a Ralph user reading `.ralph/history/`, I want a skipped reviewer recorded as its own `skipped` entry rather than a fake review verdict, so that the file tells me how many iterations produced nothing.
5. As a Ralph user reading `.ralph/history/`, I want the skipped entry to carry the unchanged HEAD sha, so that I can see which commit the loop was parked on.
6. As a Ralph user reading `.ralph/history/`, I want the skipped entry to carry the dirty-tree snapshot when the implementer left uncommitted files, so that I can see a draft was abandoned rather than nothing attempted.
7. As the next implementer iteration, I want the injected `{{ HISTORY }}` block to show the `skipped` entry and its dirty snapshot, so that I know the previous iteration left work uncommitted before I choose a task.
8. As a Ralph user, I want the reviewer to keep running whenever the implementer moved HEAD, so that every real commit is still reviewed.
9. As a Ralph user, I want the reviewer to keep running when the implementer's commit is a `fix(review):` commit or any other commit kind, so that the rule is purely "did HEAD move", with no commit-message heuristics.
10. As a Ralph user, I want the iteration cap, the sentinel exit and the history footer to behave exactly as before, so that a skipped reviewer never changes how many iterations run or how the loop ends.
11. As a Ralph user on the sentinel path, I want no `skipped` entry when the implementer emits `<promise>NO MORE TASKS</promise>`, so that the history keeps ending with the `no-more-tasks` entry and its footer, as today.
12. As a Ralph user whose implementer stage failed after all retries, I want the iteration to end as it does today (the `failed` entry, no reviewer), so that the new rule does not add a second entry after a failure.
13. As a Ralph user running against a workspace that is not a git repository, I want the reviewer skipped too, so that the loop does not start a container whose only possible output is `<review>SKIP</review>` over `(no commits)`.
14. As a Ralph user who interrupts the loop with Ctrl+C during the implementer stage, I want the `aborted` entry and exit code unchanged, so that signal handling is untouched by this feature.
15. As a Codex user (`--agent codex`), I want the same skip behavior, so that the rule lives in the provider-neutral loop and not in a provider adapter.
16. As a Ralph user, I want the reviewer playbook to stop asking the reviewer to compare HEAD against a previous iteration it cannot see, so that the prompt only contains rules the agent can actually follow.
17. As a Ralph user, I want the reviewer playbook to keep answering `<review>SKIP</review>` when `<head>` shows `(no commits)`, so that the agent-side rule that still makes sense is preserved.
18. As a reader of the README and the architecture reference, I want the reviewer-stage description to state the skip rule in one sentence, so that the documented runtime matches the code.
19. As a Ralph maintainer, I want the skip decision covered by loop tests that use a real temporary git repository and a stage stub that either commits or does not, so that the rule is pinned at the seam the existing loop tests already use.
20. As a Ralph maintainer, I want the existing two-stage loop tests to keep passing under the new rule by making their implementer stub commit, so that the tests describe a reviewer that runs after a real commit rather than an accident of a non-git fixture.
21. As a Ralph maintainer, I want the whole change to be one small commit on the loop driver, one playbook line, tests and two doc sentences, so that `git revert` of that commit restores the old always-run behavior.
22. As a Ralph maintainer, I want no new flag or environment variable for this behavior, so that the knob table does not grow for a rule with no sensible opposite.

## Implementation Decisions

- **Where the decision lives.** In the loop driver, immediately after the gate stage's history entry is written and the sentinel check has not returned. The driver already captures HEAD before each stage and reads it after; the gate's before/after pair is the only input to the decision. No provider adapter, renderer or runner module changes.
- **What is skipped.** Every stage after the gate in that iteration. Today the chains have exactly one such stage (the reviewer); the rule is written against "the stages after the gate" so a longer chain behaves consistently.
- **Comparison.** String equality of the short HEAD read before and after the gate stage, as the `review-fix` derivation already does. A workspace without git yields the `-` placeholder on both sides and is treated as unchanged (skip). No `git status` or commit-message inspection participates in the decision.
- **What the driver does instead of running the stage.** Prints the normal stage banner followed by a dim one-line notice naming the reason and the sha (the notice goes to stderr, next to the banners), then appends a history entry with: status `skipped`; duration zero; `head` = the unchanged sha; `log` = the `-` placeholder (no NDJSON file is created for a skipped stage); body = one sentence saying the reviewer was skipped because HEAD did not move during the implementer stage; `dirty` = the dirty-tree snapshot when any uncommitted paths exist. No retries, no attempt bullets, no meta segments.
- **Loop control.** The iteration is still counted as completed; the cap, footer reasons (`cap` / `failed` / `no-more-tasks`) and completion notification are untouched. The sentinel path and the stage-failure path return or break before this decision is reached, so neither produces a `skipped` entry.
- **Status vocabulary.** `skipped` is a new, harness-owned status, distinct from the agent-voiced `review-skip`. The `deriveStatus` helper is not involved: the loop writes the entry directly, the way it writes `failed` and `aborted` entries.
- **Reviewer playbook.** The SKIP rule is reduced to the `(no commits)` case; the "HEAD is unchanged from the previous iteration" clause is deleted. Nothing else in the playbook changes; the sentinel and the review tags stay verbatim.
- **Documentation.** The README's reviewer-stage step and the architecture reference's reviewer paragraph each gain one sentence: the reviewer runs only when the implementer moved HEAD, otherwise the loop records a `skipped` history entry and starts no container. The historical PRD/plan under `docs/prd/` and `docs/plans/` for iteration history are left as they are (their README declares them historical).
- **No knob.** No CLI flag, no environment variable. Rollback is a revert of the single feature commit.

## Testing Decisions

- **What makes a good test here.** The loop driver's contract is observable through three seams the existing suite already uses: how many times the (mocked) stage runner is invoked and with which stage, what `.ralph/history/*.md` contains, and what is written to stderr. Tests assert on those, never on internal variables. HEAD movement is produced by a real temporary git repository in which the implementer stub either creates a commit or does not.
- **Modules under test.** The loop driver only. The history writer already renders any status string and needs no new test; the template change is covered by the existing template-contract test that renders the shipped templates (it keeps passing as long as the tags survive).
- **Cases.**
  1. Two-stage chain, git workspace, implementer stub commits nothing → the runner is invoked once; history holds an implementer entry and a `reviewer · skipped` entry carrying the unchanged sha; stderr carries the skip notice.
  2. Same, with an untracked file left behind → the `skipped` entry carries a `dirty:` line naming it.
  3. Two-stage chain, git workspace, implementer stub commits → the runner is invoked twice and the reviewer entry is derived from its verdict exactly as today.
  4. Two-stage chain, non-git workspace → the reviewer is skipped (both HEAD readings are the placeholder).
  5. Sentinel on the gate → one runner call, no `skipped` entry, `no-more-tasks` footer (existing behavior, re-pinned).
  6. Two iterations where the first commits nothing and the second commits → runner invoked three times; the history shows `skipped` in iteration 1 and a reviewer verdict in iteration 2; the second implementer prompt's `<history>` block contains the `skipped` entry.
- **Existing tests that change.** The two existing two-stage tests ("does not inject history into the reviewer prompt" and "records the reviewer verdict and stage meta") run in a non-git fixture and expect two runner calls; they gain a git workspace and a committing implementer stub. The shared "make this workspace a git repo" helper already exists in that suite and is the home for the committing stub, so it is written once.
- **Prior art.** The loop suite's mocked runner + real temporary workspace pattern; the `makeDirtyRepo` helper; the reviewer-verdict and history-injection tests in the same file.

## Out of Scope

- Any flag or environment variable to force the reviewer to run on unchanged HEAD.
- Injecting the previous iteration's HEAD (or `{{ HISTORY }}`) into the reviewer prompt.
- Detecting or committing an implementer's uncommitted draft; the `dirty:` snapshot only reports it.
- Changing the implementer playbooks, the sentinel, the review tags, or the `deriveStatus` rules for stages that do run.
- Cost accounting or a loop-end cost summary.
- Rewriting the historical iteration-history PRD/plan's status list.

## Further Notes

- Evidence for the cost of a reviewer stage comes from the nine reviewer NDJSON logs under this repository's `.ralph-tmp/logs/` (June and September 2026 runs): `total_cost_usd` 0.33 to 1.57, `duration_ms` 75,585 to 328,302.
- The mechanism (host-side `git rev-parse --short HEAD` before and after a container stage, seeing commits made inside the bind mount) is already what derives `review-fix`; nothing new is assumed about Docker or git.
- Stress-test & provoke (from selection):
  - Killer assumption: [problem] no-commit implementer iterations happen → probe: the loop runs stage 2 unconditionally; three prior cycles' records show iterations that ended with an uncommitted draft, each followed by a reviewer run over an already-reviewed HEAD.
  - Other assumptions: [feasibility] the host HEAD read sees container commits (already relied on for `review-fix`); [solution] the reviewer reviews HEAD only, so skipping loses nothing; [user] per-iteration cost and time matter to AFK users.
  - Strongest counter: the reviewer could notice an uncommitted draft and commit it as `fix(review):` — survives because the playbook scopes the reviewer to HEAD, and absorbing the implementer's draft into a review commit is a misattribution, not a feature.
  - Would be unnecessary if: the reviewer prompt could see the prior HEAD — it cannot; only the loop knows it.
