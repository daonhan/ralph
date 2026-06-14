# Design: Budget/pacing + paced sub-agent reviewer panel (Part 2)

Date: 2026-06-14
Status: Approved (brainstorm), pending spec review → implementation plan
Depends on: Part 1 (host-first native-sandbox runner) — merged on `simplify/drop-docker-native-sandbox`.

## Summary

Two layered features, plus a deferred third:

- **A — Budget + adaptive pacing** (built first): instrument the loop with the cost/usage data Ralph already streams in the `result` event. Add `--budget`, `--cooldown`, and adaptive rate-limit backoff. Small; touches `streamClaude` / `runStage` / `loop`.
- **B — Paced sub-agent reviewer panel** (opt-in): replace the single reviewer stage with K harness-orchestrated lens reviewers + a synth step, paced by A's cooldowns. New `panel.ts` + two templates + a generic template var.
- **C — Watch/daemon mode**: designed in Part 1's spec, deferred to its own cycle after A+B land.

Decisions locked in brainstorm: **harness-orchestrated** panel (the harness owns every cooldown + the running budget); **opt-in** (default = today's single reviewer, zero behavior change); lenses **correctness / security / tests**; **lenses are read-only, synth makes the single `fix(review):` commit**.

## Grounding: the `result` event

A real stage `result` event (captured from a Part-1 smoke run) carries everything A needs:

```jsonc
{
  "type": "result", "subtype": "success",
  "is_error": false, "api_error_status": null,
  "total_cost_usd": 0.39, "num_turns": 5,
  "usage": { "input_tokens": 7739, "output_tokens": 569, "cache_read_input_tokens": 103036, … },
  "result": "…<promise>NO MORE TASKS</promise>"
}
```

So budget/cost tracking is pure instrumentation of data already flowing past `streamClaude`.

## Feature A — budget + pacing

### Capture cost (runner)

`streamClaude` currently keeps only `finalResult` (the `result` string). Extend it to also read, from the same result event: `total_cost_usd` → `costUsd` (default `0`), `is_error` → `isError` (default `false`), `api_error_status` → `apiErrorStatus` (default `null`). `runStage` returns a typed:

```ts
export type StageResult = {
  result: string;
  costUsd: number;
  isError: boolean;
  apiErrorStatus: string | null;
};
```

(The grace-timer resolution path returns the same shape with whatever was captured.)

### Ripple

`loop.ts`: gate check becomes `stageResult.result.includes(SENTINEL)`. `loop.test.ts`: `runStage` mocks return a `StageResult` (helper `ok(str)` → `{result:str,costUsd:0,isError:false,apiErrorStatus:null}`). `index.ts`: export `StageResult`.

### Accumulate + report

`runLoop` keeps `runCostUsd`. After each stage, add `costUsd` and print a running line:
`· $0.39 (iter $0.39 · run $1.18)` (plain `$x.xx (iter … · run …)` when `NO_COLOR`).

### Controls

- **`--budget <usd>`** (float): before starting each stage, if `runCostUsd >= budget`, stop cleanly — print `budget $X reached after N iterations`, run the `finally` (release/notify), return. Committed work is preserved; never interrupts a stage mid-flight.
- **`--cooldown <ms>`** (int ≥ 0): abortable sleep between iterations (and, in B, between panel sub-agents). A new `sleep(ms, signal)` util rejects with the standard abort error on SIGINT/SIGTERM.
- **Adaptive backoff**: track `cooldownFactor` (starts 1). After a stage whose result is `isError` with a throttle signal — `apiErrorStatus` matching `/429|overload|rate.?limit/i` (case-insensitive) — multiply the next effective cooldown by 2 up to a cap (`× 8`), and log it. A non-throttled stage resets the factor to 1. Effective sleep = `cooldownMs * cooldownFactor`. With `--cooldown 0` and no throttle, pacing is a no-op (default behavior unchanged).

### New flags (`cli-help.ts`)

`--budget <usd>` (parse as float > 0), `--cooldown <ms>` (parse as int ≥ 0). Surface both in `--print-config`. `parseFlags` gains `budget?: number`, `cooldownMs?: number` with validation errors mirroring `--max-retries`.

## Feature B — paced reviewer panel (opt-in)

### `panel.ts` — `runPanel`

Replaces the reviewer stage when enabled. Signature:

```ts
runPanel(opts: {
  lenses: string[];
  workspaceDir: string; packageDir: string; iteration: number;
  maxRetries: number; cooldownMs: number; signal?: AbortSignal;
  onCost?: (usd: number) => void;   // feed each sub-agent's cost into A's accumulator
}): Promise<StageResult>
```

Flow:

1. Create panel dir `<workspaceDir>/.ralph-tmp/panel-<pid>-<iter>-<ts>/` (cleaned in `finally`).
2. For each `lens` in `lenses`: render `review-lens.md` with `{ LENS: lens }` → run it (read-only review of HEAD) via the shared `executeStage` helper → write the result string to `<panelDir>/findings-<lens>.md` → `onCost(costUsd)` → **`sleep(cooldownMs, signal)`** before the next lens.
3. Render `review-synth.md` with `{ FINDINGS_DIR: "./.ralph-tmp/panel-…/" }` → run it (fix + single commit) → `onCost`. Return the synth's `StageResult`.

Lenses are independent read-only reviews; only synth writes/commits → clean `fix(review):` attribution. Panel cost rolls into A's run total; budget/cooldown are A's.

### Shared `executeStage` helper

Extract the loop's per-stage "render-inside-retry + runStage" block (spill paths, stage log, `withRetries(renderTemplate → runStage)`) into one reusable function so `loop.ts` and `panel.ts` don't duplicate it:

```ts
executeStage(opts: {
  stage: Stage; vars: Record<string, string>;
  workspaceDir: string; packageDir: string; iteration: number;
  maxRetries: number; signal?: AbortSignal; logLabel?: string;
}): Promise<StageResult>
```

`loop.ts`'s inner stage body becomes a call to this; `panel.ts` calls it per lens and for synth.

### Templates

- **`review-lens.md`** — read-only single-lens review. Reuses `review.md`'s HEAD spill (`@spill?:head.diff=…`), but instructs: "Review HEAD focusing **only** on `{{ LENS }}` (one of: correctness / security / test-coverage). Output findings as a terse list. Do **not** edit or commit." No `<review>` sentinel, no fix.
- **`review-synth.md`** — "You are given the findings from N review lenses in `{{ FINDINGS_DIR }}` (`Read` each `findings-*.md`). Dedupe, discard false positives, fix the real defects in the working tree, run the feedback loops, and make a single `git commit -am "fix(review): …"`. If nothing real, output `<review>OK</review>` and do not commit." Reuses `review.md`'s feedback-loop + commit rules.

### Template renderer (`render.ts`)

Generalize substitution from INPUTS-only to a generic `{{ KEY }}` map. `RenderVars` becomes `Record<string, string>`; the final pass replaces every `{{ KEY }}` whose `KEY` is present in `vars` (unknown tags left untouched). Same invariant: substituted **last**, never re-shelled — `LENS`/`FINDINGS_DIR` are harness-controlled constants, so no new injection surface. Existing `{ INPUTS }` callers keep working.

### Wiring (`run-bin.ts` / `cli-help.ts` / `stages.ts`)

`--review-panel` flag or `RALPH_REVIEW_LENSES=correctness,security,tests` (flag presence → default lenses; env overrides the list). When set, `runLoop` receives `reviewLenses: string[]`; in the stage walk, when the current stage is the reviewer (`stage === STAGES.reviewer` / `stage.name === "reviewer"`) and `reviewLenses` is non-empty, call `runPanel(...)` instead of `executeStage(reviewer)`. Default (unset) → unchanged single reviewer. Add `review` + `panelLenses` lines to `--print-config`.

## New surface (summary)

| Flag / env            | Effect                                                                            |
| --------------------- | --------------------------------------------------------------------------------- |
| `--budget <usd>`      | Stop loop once cumulative cost ≥ usd.                                             |
| `--cooldown <ms>`     | Abortable sleep between iterations + panel sub-agents; base for adaptive backoff. |
| `--review-panel`      | Opt into the reviewer panel (default lenses).                                     |
| `RALPH_REVIEW_LENSES` | Comma-separated lens list (implies panel on).                                     |

## Sequencing

1. **A** — `StageResult` capture, accumulation/report, `--budget`/`--cooldown`, adaptive backoff, `sleep` util. (runner + loop + cli-help + tests)
2. **B** — `executeStage` extraction, `render.ts` generic vars, `panel.ts`, the two templates, panel wiring. (new module + templates + wiring + tests)
3. **C** — watch mode, separate cycle.

## Testing

- `runner.test.ts`: `streamClaude` cost/error capture is integration-y; unit-test the pure parse of cost/isError/apiErrorStatus from a result-event object (extract a `parseResultEvent` helper if it keeps tests honest). `StageResult` default shape.
- New `pacing.test.ts`: `sleep` resolves/rejects-on-abort; adaptive `cooldownFactor` progression (throttle → ×2 up to cap; non-throttle → reset); throttle-signal regex.
- `loop.test.ts`: budget stop (cumulative ≥ budget halts before next stage); running-cost accounting; mocks return `StageResult`.
- New `panel.test.ts`: `runPanel` runs N lenses then synth in order, writes `findings-<lens>.md`, sleeps between sub-agents (fake timers), sums cost via `onCost`, returns synth result; lens failure surfaces per `executeStage` retry/terminal semantics.
- `render.test.ts` (or smoke): generic `{{ KEY }}` substitution; unknown tags untouched; `{ INPUTS }` unchanged.
- Gate: `pnpm -r typecheck` + `pnpm -r test` + root `pnpm test`.

## Success criteria

- Default run (no new flags) is byte-for-byte today's behavior plus a per-stage cost line.
- `--budget 1.00` halts a multi-iteration run once cumulative cost crosses $1.00, preserving commits.
- `--cooldown 2000` visibly paces iterations; a simulated 429 result grows the next cooldown.
- `--review-panel` runs correctness→security→tests (read-only) then one synth `fix(review):` commit, all costs in the run total, cooldowns between sub-agents.
- `typecheck` + all test suites green.

## Open questions (resolve in plan/impl)

1. `api_error_status` exact strings under real throttling — the regex `/429|overload|rate.?limit/i` is a best-effort net; confirm against any captured throttle event and widen if needed. Adaptive backoff degrades safely (just no extra delay) if it never matches.
2. Whether `executeStage` should live in `loop.ts` or a new `stage-exec.ts` — decide by size during extraction; prefer a new small module if `loop.ts` would exceed ~250 lines.
