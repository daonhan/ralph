# Plan: Iteration History in the Target Repo

> Source PRD: [`docs/prd/iteration-history.md`](../prd/iteration-history.md) — harness-owned, per-run Markdown history under `<workspace>/.ralph/history/`, injected into the implementer prompt as `{{ HISTORY }}`.
>
> **Target release**: `@daonhan/ralph-core` **0.8.0** (minor bump from 0.7.3, driven by release-please from `feat(core): …` commits). Templates and playbooks ship inside the core tarball, so no separate template release. CLI (`@daonhan/ralph`) is not bumped: the bins are untouched, `--print-config` lives in core. Sandbox image unaffected.

## Architectural decisions

Durable decisions that apply across every phase:

- **Storage**: `<workspace>/.ralph/history/`, created on first use with a self-ignoring `.gitignore` (`*`), written only when missing. The harness never reads or writes any other path under `.ralph/`. No retention, no size cap, no disable switch.
- **One file per run**: `<yyyy-MM-dd-HHmmss>-<bin>-<branch>.md`. `bin` ∈ {`afk`, `ghafk`}. `branch` = current git branch, characters outside `[A-Za-z0-9._-]` → `-`, capped at 40 chars, omitted with its separator when unknown (no git, detached HEAD). File opened after `ensureImage` succeeds, before the first stage.
- **Writer**: the loop driver, never the agent. Every stage outcome writes exactly one entry: `ok`, `no-more-tasks`, `review-ok`, `review-skip`, `review-fix`, `error`, `failed`, `aborted`. Footer line on normal loop exit; the `aborted` entry is the terminal marker on signal exit.
- **Entry contract** (the loader splits on `## iter`):

  ```
  # ralph-<bin> · <start> · branch <name> · <N> iterations
  inputs: <inputs>                       (afk only)

  ## iter <i>/<N> · <stage> · <status> · <duration> [· <n> turns] [· $<cost>] [· <in>k in / <out>k out] [· grace-timer] · HEAD <sha|->
  log: <container-relative ndjson path>
  [retries: <n>]
  [- attempt <k>: <error>]
  [dirty: <count> files — <first ten paths>]

  <agent final message verbatim | final error message>

  --- ended · <completed>/<N> iterations · <no-more-tasks | cap | failed>
  ```

- **Stage runner contract**: `runStage` resolves `{ text, meta }`. `meta` = decoder metadata (`costUsd?`, `turns?`, `inputTokens?`, `outputTokens?`, `isError?`, `apiErrorStatus?`) plus runner-owned `graceTimerFired?`. The loop's sentinel check reads `text`. Duration is measured by the loop around the whole retried call.
- **Status derivation**: gate stage → `no-more-tasks` when `text` contains the sentinel, else `ok`; reviewer → `review-ok` / `review-skip` from the `<review>` tags, `review-fix` when neither tag and HEAD moved, else `ok`; `meta.isError` or `meta.apiErrorStatus` → `error` (wins over `ok`); throw after retries → `failed`; signal mid-stage → `aborted`.
- **Injection**: `RenderVars.HISTORY`; `{{ HISTORY }}` substituted in the final pass with `{{ INPUTS }}`, after all shell tags — agent-produced text is untrusted and must never reach host shell expansion. Loader: newest file first, collect ten entries, print oldest first, body cap 1500 chars (first 500 + `…` + last 1000), header and metadata lines never cut, empty → `No prior history.` Implementer templates only; `review.md` untouched.
- **New module**: one history module (open run / append stage / append footer / load tail / dirty snapshot / HEAD sha). Pure `fs` plus tolerant `git` calls via `execFileSync`. No docker, no network.
- **Verification standard**: `pnpm -r typecheck` + `pnpm -r test` green from the repo root after every phase, plus one manual smoke run at the end. Loop-seam tests use the existing pattern (mocked `runner` module, real temp workspace).

---

## Phase 1: A history file appears for a happy-path run

**User stories**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 31, 32, 33, 34, 36

### What to build

The thinnest end-to-end path: run the loop, get a readable file. `runStage` returns `{ text, meta }` with `meta` empty for now. After `ensureImage`, the loop opens `<workspace>/.ralph/history/<ts>-<bin>-<branch>.md` (creating the dir and its `.gitignore`), writes the header, appends one entry per completed stage (status `ok` or `no-more-tasks` on the gate, `ok` on the reviewer) with duration, HEAD sha, ndjson log link, and the agent's final text, then writes the footer on loop exit. `--print-config` shows the history dir. Bin name reaches the loop from the bin entry.

### Acceptance criteria

- [ ] `runStage` resolves `{ text, meta }`; loop sentinel check and all existing loop tests updated and green.
- [ ] Running the loop (mocked stages, temp workspace) creates `.ralph/history/` with a `.gitignore` containing `*`; a second run does not rewrite it; nothing else under `.ralph/` is touched.
- [ ] Filename matches `<yyyy-MM-dd-HHmmss>-<bin>-<branch>.md`; branch `feature/slice 49` becomes `feature-slice-49`; a 60-char branch is cut to 40; a non-git workspace yields `<ts>-<bin>.md`.
- [ ] Header line carries bin, start time, branch, iteration count; `inputs:` line present for `afk`, absent for `ghafk`.
- [ ] One `## iter i/N · <stage> · <status>` block per completed stage, in order, with `<duration>`, `HEAD <sha>` (`HEAD -` outside git), `log:` pointing at the `.ralph-tmp/logs/…ndjson` path, and the stage text verbatim as body.
- [ ] Sentinel on the gate produces `no-more-tasks` and the footer reads `--- ended · i/N iterations · no-more-tasks`; running to the cap reads `… · cap`.
- [ ] Image failure before the loop produces no history file.
- [ ] `--print-config` output includes a `history dir` line with `<workspace>/.ralph/history`; cli-help tests updated.
- [ ] `pnpm -r typecheck` and `pnpm -r test` green.

---

## Phase 2: The next iteration reads the history

**User stories**: 22, 23, 24, 25, 26, 27, 28, 29, 30

### What to build

Close the memory loop. The history module gains a tail loader; the loop renders `HISTORY` immediately before each implementer render (inside the retry closure, next to the existing render call). `RenderVars` gains `HISTORY`, substituted in the final pass. `afk.md` and `ghafk.md` gain a `<history>` block between `<commits>` and the inputs / issues blocks. `prompt.md` and `ghprompt.md` tell the agent to read `<history>` before task selection, never retry a reported-failed approach without a new reason, and end the turn with at most ten lines under **Done**, **Blocked**, **Next**. `review.md` unchanged.

### Acceptance criteria

- [ ] Loader returns the last ten stage entries across all files (newest file first, then oldest-first output); with two files of six entries each, output is the last four of the older run then all six of the newer.
- [ ] A body over 1500 chars is rendered as first 500 + ellipsis marker + last 1000; header and `log:` / `retries:` / `dirty:` lines are never truncated.
- [ ] Empty or missing history dir renders exactly `No prior history.`
- [ ] Renderer test: `{{ HISTORY }}` is replaced; a HISTORY value containing `` !`echo pwned` `` and `@spill:x=…` is emitted verbatim, nothing executed.
- [ ] Loop-seam test: a second `runLoop` in the same temp workspace passes a rendered implementer prompt to the mocked stage whose `<history>` block contains the first run's entries.
- [ ] Reviewer prompt passed to the mocked stage contains no `<history>` block.
- [ ] Template contract test: `afk.md` / `ghafk.md` contain `<history>` … `{{ HISTORY }}` … `</history>`; `prompt.md` / `ghprompt.md` contain the history-reading rule and the Done / Blocked / Next rule; `review.md` unchanged.
- [ ] `pnpm -r typecheck` and `pnpm -r test` green.

---

## Phase 3: Statuses and numbers are honest

**User stories**: 12, 14, 15, 18

### What to build

Fill `meta`. The decoder result gains optional metadata: Claude fills cost, turns, input/output tokens, `isError`, `apiErrorStatus` from the `result` record; Codex fills input/output tokens from `turn.completed`. The stream runner sets `graceTimerFired` when the post-result grace timer kills the child. The loop derives `review-ok` / `review-skip` / `review-fix` (HEAD before vs after the stage) and `error` (wins over `ok`). The entry header prints only the fields present.

### Acceptance criteria

- [ ] Decoder tests: a Claude `result` record with `total_cost_usd`, `num_turns`, `usage`, `is_error:true`, `api_error_status:429` yields matching `meta`; a Codex `turn.completed` with `usage` yields tokens only.
- [ ] Header for a Claude stage reads `… · 2m19s · 8 turns · $0.60 · HEAD …`; for a Codex stage `… · 2m19s · 12.3k in / 1.1k out · HEAD …`; no placeholders for missing fields.
- [ ] A stage whose `meta.isError` is true (or `apiErrorStatus` set) is recorded as `error`, even when its text would otherwise read `ok`; the loop's iteration flow is unchanged.
- [ ] Reviewer text `<review>OK</review>` → `review-ok`; `<review>SKIP</review>` → `review-skip`; no tag and HEAD moved → `review-fix`; no tag and HEAD unchanged → `ok`.
- [ ] Stream-runner test: grace-timer fire resolves with `meta.graceTimerFired === true`; natural close leaves it unset; entry header shows `grace-timer` only when set.
- [ ] `pnpm -r typecheck` and `pnpm -r test` green.

---

## Phase 4: Failures and retries leave a trace

**User stories**: 16, 17, 20, 21

### What to build

The loop collects each retry attempt's error from the retry callback. A stage that recovers writes its normal status entry with `retries: n` and one `- attempt k: …` bullet per failed attempt. A stage that throws after the retry budget writes a `failed` entry with the bullets, a `dirty:` snapshot (count + first ten paths from a porcelain status; omitted when clean or outside git), and the final error as body, then breaks the iteration exactly as today. Render failures (a host shell tag throwing inside the retry closure) follow the same path. Footer reads `… · failed`.

### Acceptance criteria

- [ ] Stage that fails twice then succeeds: entry status `ok`, `retries: 2`, two attempt bullets with the error messages, body is the successful text.
- [ ] Stage that fails all attempts: entry status `failed`, `retries: <max>`, bullets, body is the final error; loop breaks the iteration and the footer reads `--- ended · i/N iterations · failed`.
- [ ] Render throwing inside the retry closure is recorded like a stage failure.
- [ ] `dirty:` line on a `failed` entry lists count and up to ten paths when the temp workspace has uncommitted changes; absent when the tree is clean; absent outside git.
- [ ] Existing retry / failure-marker behaviour in the ndjson log and on stderr unchanged.
- [ ] `pnpm -r typecheck` and `pnpm -r test` green.

---

## Phase 5: Ctrl+C is recorded

**User stories**: 19, 21

### What to build

The loop keeps a `current` slot (iteration, stage, start time, ndjson log path) updated at each stage start and cleared after the entry is written. The SIGINT / SIGTERM handlers, before the existing wake-lock release, notification, and `process.exit(130 / 143)`, synchronously append an `aborted` entry for `current` with duration so far, HEAD, log link, and the `dirty:` snapshot. No footer on this path.

### Acceptance criteria

- [ ] Loop-seam test invoking the installed SIGINT handler mid-stage (with `process.exit` stubbed, as the existing exit-code tests do): history file ends with an `aborted` entry for the running iteration and stage, carrying `dirty:` when the tree is dirty; no footer line.
- [ ] SIGTERM path identical, exit code 143 preserved; SIGINT still exits 130; wake-lock release and notify behaviour unchanged.
- [ ] Signal arriving between stages (slot empty) writes no entry and exits as before.
- [ ] A rerun after an abort renders the `aborted` entry (with its `dirty:` line) into the next implementer prompt — verified at the loop seam.
- [ ] `pnpm -r typecheck` and `pnpm -r test` green.

---

## Phase 6: Docs, smoke, release

**User stories**: 35, 36

### What to build

Surgical doc updates and one real run. README: scratch-layout paragraph gains `.ralph/history/`, template-tag list gains `{{ HISTORY }}`, playbook paragraph mentions the Done / Blocked / Next rule and the history-reading rule, `--print-config` sample shows `history dir`. `docs/ARCHITECTURE.md`: per-iteration layout and `RenderVars`. Root `CLAUDE.md`: tag table row and scratch-dir note. `QUICKSTART.md`: logs line mentions history. Smoke-test `ralph-afk` against a scratch workspace.

### Acceptance criteria

- [ ] README, ARCHITECTURE, CLAUDE.md, QUICKSTART updated as listed; no unrelated rewrites.
- [ ] Manual smoke: `ralph-afk "<plan>" 1` in a scratch git workspace produces `.ralph/history/<ts>-afk-<branch>.md` with header, two entries, footer; `git status --porcelain` shows nothing under `.ralph/history/`; the second run's rendered prompt file under `.ralph-tmp/` (inspect before cleanup or via the ndjson log) contains the first run's entries.
- [ ] Commits use `feat(core): …` / `docs: …` so release-please proposes core 0.8.0 with the feature in the changelog.
- [ ] `pnpm -r typecheck` and `pnpm -r test` green.
