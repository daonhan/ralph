# PRD: Iteration History in the Target Repo

## Problem Statement

As a Ralph user, I run `ralph-afk "<plan-and-prd>" 20` or `ralph-ghafk 20` against a target repo and walk away. Each iteration starts the agent with a fresh context. The only memory it gets from earlier iterations is the last five commit messages, rendered into the `<commits>` block. Everything else the agent learned — what it tried, why it stopped, which feedback loop kept failing, which approach was a dead end — is gone the moment the container exits.

That loss shows up in four ways:

1. **The agent repeats itself.** Iteration 4 hits a blocker, writes a one-line note in a commit body, and iteration 5 either misses that note or re-attempts the same approach. Across runs (yesterday's blocker, today's run) nothing carries over at all.
2. **Failures leave no trace the agent can read.** When a stage fails after retries, is aborted by Ctrl+C, or completes with an API error (`429`, `is_error:true`), the loop prints to stderr and moves on. The next iteration has no idea the previous one died mid-edit, or that an uncommitted draft sits in the working tree.
3. **The human has no readable record.** After an overnight run the only artefacts are `git log` and a directory of NDJSON stream logs at ~130 KB per stage. Answering "what did Ralph do, what failed, what did it cost?" means grepping JSON.
4. **Ralph cannot be improved from its own runs.** Patterns like "reviewer always skips", "every third iteration retries on a flaky test", or "rate-limit rejections cluster at 02:00" are buried in stream logs nobody opens.

A `.ralph/` directory is already the per-project home for Ralph configuration in the target repo (`host.env`, `db.env`), so there is a natural, versioned-adjacent place for a durable record. Nothing writes to it today.

## Solution

Ralph keeps a harness-owned, human-readable history of every stage it runs, stored in the target repo under `.ralph/history/`, one Markdown file per run. The harness — not the agent — writes it, so every outcome is recorded whether the stage succeeded, returned the sentinel, errored, failed after retries, or was aborted by a signal.

Each entry records what the loop already knows (iteration, stage, status, duration, turns, cost, HEAD sha, retry attempts, dirty working tree on failure, link to the NDJSON log) plus the agent's final message verbatim as the narrative. The implementer playbooks tell the agent to end its turn with a short "Done / Blocked / Next" summary so that narrative is useful.

Before each implementer stage, the harness renders the last ten entries across all history files into a `<history>` block in the prompt, so the next iteration — and the next run — starts with a memory of what happened, what failed, and what to do next. The reviewer stage is unchanged.

From the user's perspective:

- Run Ralph as before. A new `.ralph/history/<timestamp>-<bin>-<branch>.md` file appears per run and grows one block per stage. `git status` stays clean; the directory ignores itself.
- Open the file to read what happened, in order, with cost and duration per stage. Aborted or failed stages say so and list the files left dirty.
- Rerun Ralph. The first iteration already knows about the last run's blockers and leftover draft.
- `ralph-afk --print-config` shows where history lives.

## User Stories

### Recording

1. As a Ralph user, I want every stage the loop runs to append one entry to a history file in my target repo, so that nothing that happened during an AFK run is lost when the container exits.
2. As a Ralph user, I want the history written by the harness rather than the agent, so that a stage that crashes, errors, or is killed still leaves an entry.
3. As a Ralph user, I want one history file per run, named by start timestamp, bin name, and git branch, so that I can find the run I care about by listing the directory.
4. As a Ralph user, I want the branch part of the filename sanitized and capped, so that branches like `feature/slice-49` produce a valid filename on Windows and Linux.
5. As a Ralph user, I want the filename to omit the branch when the workspace is not a git repo or HEAD is detached, so that history still works outside the happy path.
6. As a Ralph user, I want the history file to start with a header naming the bin, start time, branch, iteration budget, and (for `ralph-afk`) the inputs string, so that the file is self-describing.
7. As a Ralph user, I want each entry to start with a header line carrying iteration `i/N`, stage name, status, duration, turn count, and cost, so that I can skim a run in seconds.
8. As a Ralph user, I want each entry to link the NDJSON stream log for that stage, so that I can drill into the raw stream when the summary is not enough.
9. As a Ralph user, I want each entry to record the short HEAD sha after the stage, so that I can see whether the stage committed and jump to the commit.
10. As a Ralph user, I want the agent's final message included verbatim as the entry body, so that the narrative comes from the agent without any extra tool calls or prompt-compliance risk.
11. As a Ralph user, I want a run footer line stating how many iterations ran and why the loop ended (sentinel, iteration cap, stage failure), so that the file tells me whether the run finished its work.
12. As a Ralph user running Codex instead of Claude, I want the entry header to show what Codex reports (input/output tokens) and omit what it cannot (cost, turn count), so that history works for every agent adapter without inventing numbers.

### Status accuracy

13. As a Ralph user, I want the implementer entry status to distinguish `ok` from `no-more-tasks`, so that I can see at which iteration the sentinel fired.
14. As a Ralph user, I want the reviewer entry status to distinguish `review-ok`, `review-skip`, and `review-fix`, so that I can see how often the reviewer changed anything.
15. As a Ralph user, I want a stage whose result reports an error (`is_error`, an API error status such as `429`) recorded as `error` rather than `ok`, so that the history never calls a rate-limited or errored turn a success.
16. As a Ralph user, I want a stage that failed after all retries recorded as `failed` with one bullet per attempt and the final error message, so that the failure reason is in the same file as everything else.
17. As a Ralph user, I want a stage that succeeded after retries recorded as its normal status with the retry attempts listed, so that flakiness is visible even when the run recovered.
18. As a Ralph user, I want a stage killed by the post-result grace timer flagged in its entry, so that hung-container incidents are countable.
19. As a Ralph user, I want Ctrl+C or SIGTERM during a stage to write an `aborted` entry before the process exits, so that an interrupted run is recorded as interrupted rather than silently truncated.
20. As a Ralph user, I want a template render failure (a host shell tag that throws) recorded like any other stage failure, so that prompt-side problems are in the history too.

### Resume

21. As a Ralph user, I want `failed` and `aborted` entries to include a snapshot of the dirty working tree (count and first paths), so that the next iteration knows a draft exists and can carry it forward instead of discarding it.
22. As a Ralph user, I want the next run to see the previous run's last entries without any flag, so that rerunning after an abort simply resumes with memory.

### Injection into the prompt

23. As the implementer agent, I want a `<history>` block in my prompt containing the most recent stage entries, so that I can avoid repeating a failed approach and pick up a recorded blocker.
24. As the implementer agent, I want history gathered across all history files, newest run first, so that yesterday's outcome is visible today.
25. As the implementer agent, I want history limited to the last ten stage entries, so that the prompt stays small enough to leave room for the actual task.
26. As the implementer agent, I want each injected entry capped in length, keeping its beginning and its end, so that a long final message does not crowd out the summary at its tail.
27. As the implementer agent, I want the `<history>` block to read `No prior history.` on the first ever run, so that an empty history is explicit rather than a missing block.
28. As the implementer agent, I want my playbook to tell me to read the history before selecting a task and to end my turn with a short Done / Blocked / Next summary, so that the record I leave is useful to the next iteration.
29. As a Ralph user, I want the reviewer stage left unchanged, so that the reviewer keeps reviewing HEAD only and the review prompt does not grow.
30. As a Ralph maintainer, I want history text substituted into the template after every shell tag has been expanded, so that agent-produced text can never reach host shell expansion.

### Git hygiene

31. As a Ralph user, I want history stored under `.ralph/history/` and that directory to contain a self-ignoring `.gitignore`, so that `git status` stays clean and `git add .` never commits history, with no change to my repo's own `.gitignore`.
32. As a Ralph user, I want Ralph to never touch other files in `.ralph/`, so that my versioned `host.env` and `db.env` are safe.
33. As a Ralph user, I want history to be unversioned by default, so that reviewer diffs and commit history are free of history churn.

### Diagnostics and docs

34. As a Ralph user, I want `--print-config` to show the history directory, so that I know where to look before a run.
35. As a Ralph user, I want the README, architecture doc, and quickstart to describe `.ralph/history/`, the `{{ HISTORY }}` tag, and the playbook summary rule, so that the feature is discoverable.
36. As a Ralph maintainer, I want the change to land as a `feat:` on the core package so release-please cuts a minor release, so that users see it in the changelog.

## Implementation Decisions

### Storage

- Location: `<workspace>/.ralph/history/`. Created on first use together with a `.gitignore` whose only rule is `*`, written only if missing. No other file under `.ralph/` is read or written by the harness.
- One file per run: `<yyyy-MM-dd-HHmmss>-<bin>-<branch>.md`. `bin` is `afk` or `ghafk`. `branch` is the current git branch with every character outside `[A-Za-z0-9._-]` replaced by `-`, capped at 40 characters, and omitted (together with its separator) when the branch cannot be determined.
- No retention policy, no size limit, no disable switch. Files are small and the user deletes them.
- The run file is opened after the sandbox image is confirmed present and before the first stage. An image failure produces no history file.

### Entry format

Markdown, harness-owned. The format below is the contract the loader parses (it splits on the `## iter` marker):

```
# ralph-ghafk · 2026-09-08 14:30:12 · branch slice-49 · 5 iterations
inputs: ./docs/plans/x.md ./docs/prd/x.md          (ralph-afk only)

## iter 1/5 · implementer · ok · 2m19s · 8 turns · $0.60 · HEAD a1b2c3d
log: .ralph-tmp/logs/2026-09-08T14-30-12-000Z-iter1-implementer.ndjson

<agent final message, verbatim>

## iter 2/5 · implementer · failed · 0m03s · HEAD a1b2c3d
log: …
retries: 3
- attempt 1: docker run exited 125 …
- attempt 2: …
dirty: 3 files — src/a.ts, src/b.ts, test/a.test.ts

<final error message>

--- ended · 2/5 iterations · failed
```

- Header line fields after status are optional and printed only when known: duration (always), turns and cost (Claude), input/output tokens (Codex), `grace-timer` flag when the post-result grace timer killed the child, then `HEAD <sha>` (or `HEAD -` when git is unavailable).
- Status vocabulary: `ok`, `no-more-tasks`, `review-ok`, `review-skip`, `review-fix`, `error`, `failed`, `aborted`.
  - `no-more-tasks`: gate stage result contains the sentinel.
  - `review-ok` / `review-skip`: reviewer result contains `<review>OK</review>` / `<review>SKIP</review>`.
  - `review-fix`: reviewer result contains neither tag and HEAD moved during the stage.
  - `error`: the agent reported the result as errored (Claude `is_error`, or an API error status); takes precedence over `ok`.
  - `failed`: the stage threw after the retry budget was exhausted, including render failures.
  - `aborted`: SIGINT or SIGTERM arrived while a stage was running.
- `retries:` and its bullets appear whenever at least one attempt failed, on both recovered and failed entries.
- `dirty:` appears on `failed` and `aborted` entries only: count plus the first ten paths from a porcelain status of the workspace; omitted when git is unavailable or the tree is clean.
- Footer: `--- ended · <completed>/<N> iterations · <no-more-tasks | cap | failed>`. Written in the loop's cleanup path. The abort path exits the process directly, so the `aborted` entry is the terminal marker of that file.

### Metadata plumbing

- The agent stream decoder result gains an optional metadata object next to its completion text: cost in USD, turn count, input tokens, output tokens, error flag, API error status. Each adapter fills what its stream provides: Claude from the `result` record (`total_cost_usd`, `num_turns`, `usage`, `is_error`, `api_error_status`); Codex from the `turn.completed` usage block (tokens only).
- The stage runner returns an object `{ text, meta }` instead of a bare string. `meta` carries the decoder metadata plus a runner-owned flag for the grace timer. The loop driver's sentinel check reads `text`.
- Duration is measured by the loop driver around the stage call, so it includes retries.
- HEAD sha is read by the history module via `git rev-parse --short HEAD` in the workspace, tolerant of failure. It is read before and after each stage; the "before" value feeds `review-fix` detection.

### Loop driver changes

- Keeps a `current` slot (iteration, stage, start time) updated at each stage start; the signal handlers use it to append the `aborted` entry synchronously before exiting with the existing codes 130 / 143.
- Collects the per-attempt error messages from the retry callback into a list for the entry.
- On stage failure after retries, appends the `failed` entry before breaking out of the iteration, preserving current behaviour otherwise.
- Renders `HISTORY` from the history loader immediately before each implementer render, inside the retry closure alongside the existing render, so a failing render still sees fresh history.

### Rendering

- `RenderVars` gains `HISTORY`. The `{{ HISTORY }}` tag is substituted in the same final pass as `{{ INPUTS }}`, after all shell tags. Rationale: history bodies are agent-produced text and must be treated as untrusted input exactly like `INPUTS`.
- The loader reads history files newest-first by filename, collects entries until it has ten, and renders them oldest-first. Each entry body is capped: if longer than 1500 characters, keep the first 500, an ellipsis marker, and the last 1000. Header and metadata lines are never truncated. Empty history renders `No prior history.`
- `afk.md` and `ghafk.md` gain a `<history>` block between `<commits>` and the inputs / issues blocks. `review.md` is untouched.

### Playbooks

- `prompt.md` and `ghprompt.md` gain, near the top, an instruction to read `<history>` before task selection and not to retry an approach a prior entry reports as failed without a new reason.
- Both gain, in their progress-recording section, an instruction that the final message is recorded to `.ralph/history/` and shown to the next iteration, and must end with at most ten lines under **Done**, **Blocked**, **Next**.

### Diagnostics

- `--print-config` prints a `history dir` line pointing at `<workspace>/.ralph/history`.

## Testing Decisions

A good test exercises external behaviour at the highest existing seam and asserts on what the user would see: files on disk, their contents, the rendered prompt, the process exit path. Tests must not assert on internal call order or private helpers.

Seams, highest first:

1. **Loop driver with a mocked stage runner and a real temporary workspace** — the seam the existing loop tests already use (`runner` module mocked, `runLoop` invoked with a temp `workspaceDir`). This is the primary seam: run the loop with stubbed `{ text, meta }` results, then read `.ralph/history/*.md` and assert header, entries per status (`ok`, `no-more-tasks`, `review-ok`, `review-fix`, `error`, `failed` with retries), footer, dirty snapshot on failure, and the self-ignoring `.gitignore`. A second run in the same workspace must produce a rendered implementer prompt whose `<history>` block contains the first run's entries, capped and in order.
2. **History module against temporary directories** — filename construction and branch sanitization, entry rendering per status, the tail loader (cross-file ordering, ten-entry limit, per-entry cap, `No prior history.`), and `.gitignore` creation being idempotent. Prior art: the render tests that build temp template dirs.
3. **Agent decoders** — Claude `result` record and Codex `turn.completed` record yield the expected metadata alongside the completion; a Claude `is_error` result yields the error flag and status. Prior art: the existing decoder tests.
4. **Renderer** — `{{ HISTORY }}` is replaced, and a history value containing a shell-tag lookalike is emitted verbatim without execution. Prior art: the existing `{{ INPUTS }}` contract test.
5. **Template contract** — the shipped `afk.md` / `ghafk.md` contain the `<history>` block and the playbooks contain the Done / Blocked / Next rule. Prior art: the existing template contract test.

Signal handling (`aborted` entry on SIGINT) is verified at the loop seam by invoking the installed handler with `process.exit` stubbed, matching how the existing loop tests cover the exit codes.

Verification standard for the change: `pnpm -r typecheck` and `pnpm -r test` green from the repo root, plus one manual smoke run of `ralph-afk` against a scratch workspace to confirm the file appears and `git status` stays clean.

## Out of Scope

- A `--history` summary command or any aggregation (status counts, cost totals, failure top-list). Follow-up once entries exist.
- A retrospective skill or any automated "learn and improve Ralph" loop. Learning stays in skills and playbooks, outside the harness.
- Versioned history, agent-written history, or committing history files.
- Injecting history into the reviewer stage.
- Retention, pruning, size limits, or a disable switch.
- Cross-repo aggregation of history.
- Changes to the sandbox image.

## Further Notes

- The `.ralph/` directory convention (versioned per-project config such as `host.env`, `db.env`) comes from the `pg17` sandbox image work. History deliberately lives in a harness-owned subdirectory so the two never collide.
- Costs and turn counts are available from Claude only; Codex reports tokens. The header prints what exists rather than a placeholder, so per-adapter differences are visible and honest.
- The 1500-character injection cap (500 head + 1000 tail) assumes the playbook's "end with Done / Blocked / Next" rule places the most useful text at the end of the message. If future playbooks move the summary, the cap split should follow it.
- The `error` status closes a real gap: today a `429` result still resolves the stage and the loop treats it as a completed iteration. History would otherwise call it `ok`.
