# Budget/Pacing + Paced Reviewer Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the loop with cost/budget/pacing (A), then add an opt-in harness-orchestrated reviewer panel paced by it (B).

**Architecture:** `runStage` returns a typed `StageResult` (result + cost + error flags) captured from the `result` NDJSON event. `runLoop` accumulates cost, enforces `--budget`, and paces with `--cooldown` + adaptive backoff. A shared `executeStage` helper (render-inside-retry + runStage) is reused by both `loop.ts` and a new `panel.ts`, which runs K read-only lens reviewers + one synth `fix(review):` commit, all opt-in behind `--review-panel`.

**Tech Stack:** Node ≥20 ESM, TypeScript NodeNext (relative imports end `.js`), vitest + root `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-14-budget-pacing-reviewer-panel-design.md`

---

## File Structure

| File                                                        | Responsibility                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/core/src/pacing.ts`                               | **new** — `sleep(ms,signal)`, `isThrottle`, `nextCooldownFactor`. Pure + tiny.                 |
| `packages/core/src/runner.ts`                               | `StageResult` type + `resultFromEvent` parser; `streamClaude`/`runStage` return `StageResult`. |
| `packages/core/src/stage-exec.ts`                           | **new** — `executeStage` (render+retry+runStage), extracted from loop.                         |
| `packages/core/src/panel.ts`                                | **new** — `runPanel` (lenses → findings files → synth).                                        |
| `packages/core/src/loop.ts`                                 | cost accumulation, budget stop, cooldown/adaptive, panel dispatch.                             |
| `packages/core/src/render.ts`                               | generic `{{ KEY }}` substitution (was INPUTS-only).                                            |
| `packages/core/src/cli-help.ts`                             | `--budget`/`--cooldown`/`--review-panel` flags + print-config.                                 |
| `packages/core/src/run-bin.ts`                              | thread budget/cooldown/reviewLenses into `runLoop`.                                            |
| `packages/core/templates/review-lens.md`, `review-synth.md` | **new** panel templates.                                                                       |

---

# FEATURE A — budget + pacing

## Task 1: `pacing.ts` helpers (TDD)

**Files:** Create `packages/core/src/pacing.ts`, `packages/core/src/__tests__/pacing.test.ts`.

- [ ] **Step 1: Write failing tests**

```ts
// pacing.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep, isThrottle, nextCooldownFactor } from "../pacing.js";

describe("isThrottle", () => {
  it("matches throttle signals case-insensitively", () => {
    for (const s of ["429", "Overloaded", "rate_limit", "rate limit"]) {
      expect(isThrottle(s)).toBe(true);
    }
  });
  it("is false for null / non-throttle", () => {
    expect(isThrottle(null)).toBe(false);
    expect(isThrottle("internal_server_error")).toBe(false);
  });
});

describe("nextCooldownFactor", () => {
  it("resets to 1 when not throttled", () => {
    expect(nextCooldownFactor(8, false)).toBe(1);
  });
  it("doubles up to the cap when throttled", () => {
    expect(nextCooldownFactor(1, true)).toBe(2);
    expect(nextCooldownFactor(4, true)).toBe(8);
    expect(nextCooldownFactor(8, true)).toBe(8); // capped
  });
});

describe("sleep", () => {
  afterEach(() => vi.useRealTimers());
  it("resolves immediately for ms <= 0", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
  it("rejects with AbortError when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(1000, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("rejects when aborted mid-wait", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @daonhan/ralph-core test -- pacing` → module not found.

- [ ] **Step 3: Implement `pacing.ts`**

```ts
function abortError(): Error {
  const err = new Error("sleep aborted");
  err.name = "AbortError";
  return err;
}

/** Abortable delay. Resolves after `ms`; rejects with an AbortError if `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const THROTTLE_RE = /429|overload|rate.?limit/i;

/** True when a result's `api_error_status` looks like provider throttling. */
export function isThrottle(apiErrorStatus: string | null): boolean {
  return apiErrorStatus != null && THROTTLE_RE.test(apiErrorStatus);
}

/** Adaptive cooldown multiplier: reset to 1 when healthy, else double up to `cap`. */
export function nextCooldownFactor(
  prev: number,
  throttled: boolean,
  cap = 8
): number {
  return throttled ? Math.min(prev * 2, cap) : 1;
}
```

- [ ] **Step 4: Run → pass.** `pnpm --filter @daonhan/ralph-core test -- pacing`

- [ ] **Step 5: Commit** — `git add packages/core/src/pacing.ts packages/core/src/__tests__/pacing.test.ts && git commit -m "feat(pacing): abortable sleep + adaptive cooldown helpers"`

## Task 2: `StageResult` capture in runner (TDD the parser)

**Files:** Modify `packages/core/src/runner.ts`, `packages/core/src/index.ts`, `packages/core/src/__tests__/runner.test.ts`.

- [ ] **Step 1: Write the failing test** (append to `runner.test.ts`)

```ts
import { resultFromEvent } from "../runner.js";

describe("resultFromEvent", () => {
  it("extracts result/cost/error fields from a result event", () => {
    expect(
      resultFromEvent({
        type: "result",
        result: "done",
        total_cost_usd: 0.39,
        is_error: false,
        api_error_status: null,
      })
    ).toEqual({
      result: "done",
      costUsd: 0.39,
      isError: false,
      apiErrorStatus: null,
    });
  });
  it("defaults missing fields safely", () => {
    expect(resultFromEvent({})).toEqual({
      result: "",
      costUsd: 0,
      isError: false,
      apiErrorStatus: null,
    });
  });
  it("captures an error status string", () => {
    expect(
      resultFromEvent({ is_error: true, api_error_status: "429" })
    ).toMatchObject({
      isError: true,
      apiErrorStatus: "429",
    });
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @daonhan/ralph-core test -- runner`

- [ ] **Step 3: Implement.** In `runner.ts`:

Add the type + parser near `RunStageOptions`:

```ts
export type StageResult = {
  result: string;
  costUsd: number;
  isError: boolean;
  apiErrorStatus: string | null;
};

/** Pure extraction of the fields Ralph tracks from a stream-json `result` event. */
export function resultFromEvent(ev: unknown): StageResult {
  const e = (ev ?? {}) as Record<string, unknown>;
  return {
    result: typeof e.result === "string" ? e.result : "",
    costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : 0,
    isError: e.is_error === true,
    apiErrorStatus:
      typeof e.api_error_status === "string" ? e.api_error_status : null,
  };
}
```

Change `runStage`'s return type to `Promise<StageResult>` and `streamClaude` to `Promise<StageResult>`. In `streamClaude`: replace `let finalResult = "";` with
`let final: StageResult = { result: "", costUsd: 0, isError: false, apiErrorStatus: null };`
In the `parsed.type === "result"` branch, replace the `finalResult` assignment with `final = resultFromEvent(parsed);`. Replace every `resolveOnce(finalResult)` with `resolveOnce(final)` and change `resolveOnce`/`resolve` generic from `string` to `StageResult` (`const resolveOnce = (value: StageResult)`). The close handler's success path resolves `final`.

- [ ] **Step 4: Export.** In `index.ts` add `StageResult` to the runner export:
      `export { runStage, type StageResult } from "./runner.js";`

- [ ] **Step 5: Run → fail (loop.ts/loop.test still expect string).** Expected — fixed in Task 3. Run `pnpm --filter @daonhan/ralph-core test -- runner` to confirm the runner tests themselves pass; typecheck will flag loop.ts until Task 3.

- [ ] **Step 6: Commit (bundle with Task 3).** Hold.

## Task 3: Loop cost accumulation + budget + pacing (TDD)

**Files:** Modify `packages/core/src/loop.ts`, `packages/core/src/__tests__/loop.test.ts`.

- [ ] **Step 1: Update loop.test mocks + add budget/cost tests**

In `loop.test.ts`, add a `StageResult` helper and make all `mocks.runStage.mockResolvedValue(sentinel)` use it:

```ts
const ok = (
  result: string,
  costUsd = 0,
  apiErrorStatus: string | null = null
) => ({
  result,
  costUsd,
  isError: apiErrorStatus != null,
  apiErrorStatus,
});
```

Replace `mockResolvedValue(sentinel)` → `mockResolvedValue(ok(sentinel))`, `mockResolvedValueOnce(sentinel)` → `mockResolvedValueOnce(ok(sentinel))`, and the SIGINT/SIGTERM `reject(new Error("aborted"))` mocks are unchanged (rejection path). Add:

```ts
it("stops cleanly once cumulative cost reaches the budget", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);
  // Each implementer stage costs $0.60; reviewer $0; never emits the sentinel.
  mocks.runStage.mockImplementation((stage) =>
    Promise.resolve(
      ok(
        stage.name === "implementer" ? "keep going" : "ok",
        stage.name === "implementer" ? 0.6 : 0
      )
    )
  );
  const reviewer: Stage = { name: "reviewer", template: "stage.md" };
  await runLoop(
    loopOptions(dirs, {
      stages: [stage, reviewer] as [Stage, Stage],
      iterations: 5,
      budgetUsd: 1.0,
      maxRetries: 0,
    })
  );
  // iter1: impl(0.6)+rev(0) = 0.6 < 1.0 → iter2 impl pushes to 1.2; budget halts before iter2 reviewer or iter3.
  // implementer ran twice, reviewer ran once.
  const implCalls = mocks.runStage.mock.calls.filter(
    (c) => c[0].name === "implementer"
  ).length;
  expect(implCalls).toBe(2);
});

it("sleeps between iterations when a cooldown is set", async () => {
  vi.useFakeTimers();
  const dirs = makeDirs();
  roots.push(dirs.root);
  mocks.runStage.mockResolvedValue(ok("keep going")); // never sentinel
  const loop = runLoop(
    loopOptions(dirs, { iterations: 2, cooldownMs: 3000, maxRetries: 0 })
  );
  await vi.advanceTimersByTimeAsync(0);
  // after iter1 the loop should be parked in sleep(3000); iter2 stage not yet run beyond iter1's
  // (1 stage so far). Advance past the cooldown to let iter2 run.
  await vi.advanceTimersByTimeAsync(3000);
  await loop;
  expect(mocks.runStage).toHaveBeenCalledTimes(2);
});
```

(Adjust the cooldown test's exact assertions to the implementation; the intent is: a cooldown delays the next iteration and is abortable.)

- [ ] **Step 2: Run → fail.** `pnpm --filter @daonhan/ralph-core test -- loop`

- [ ] **Step 3: Implement loop changes**

Add to `LoopOptions`: `budgetUsd?: number; cooldownMs?: number;`. Import pacing: `import { sleep, isThrottle, nextCooldownFactor } from "./pacing.js";`. In `runLoop`, destructure `budgetUsd, cooldownMs = 0`. Before the iteration loop: `let runCostUsd = 0; let cooldownFactor = 1;`.

Inside the `for s` stage loop, the result is now a `StageResult`. After a successful `executeStage`/`runStage` call:

- **Budget gate (before each stage)** — at the top of the `for s` body, before running the stage:

```ts
if (budgetUsd != null && runCostUsd >= budgetUsd) {
  process.stdout.write(
    `${greenOut(SYM_OUT.bullet)} ${boldOut("budget reached")}${dimOut(` $${runCostUsd.toFixed(2)} ≥ $${budgetUsd.toFixed(2)} after ${i - 1} iterations`)}\n`
  );
  return;
}
```

- **Accumulate + report** — after the stage result `sr`:

```ts
runCostUsd += sr.costUsd;
process.stderr.write(
  `${dim(`· $${sr.costUsd.toFixed(2)} (run $${runCostUsd.toFixed(2)})`)}\n`
);
cooldownFactor = nextCooldownFactor(
  cooldownFactor,
  isThrottle(sr.apiErrorStatus)
);
```

- **Gate check** uses `sr.result.includes(SENTINEL)`.

After the `for s` loop, before the next iteration (skip after the last iteration), pace:

```ts
if (cooldownMs > 0 && i < iterations) {
  const wait = cooldownMs * cooldownFactor;
  if (cooldownFactor > 1)
    process.stderr.write(
      `${dim(`cooldown ×${cooldownFactor} → ${wait}ms (throttle backoff)`)}\n`
    );
  await sleep(wait, stageAbort.signal);
}
```

> NOTE: this task still calls `runStage` directly via the existing inner block; the `executeStage` extraction is Task 6. Keep the existing render-inside-retry structure, just have it return `StageResult` (it already does after Task 2) and feed `sr` into the accounting above.

- [ ] **Step 4: Run → pass.** `pnpm --filter @daonhan/ralph-core test -- loop` and `-- runner`.

- [ ] **Step 5: Commit (bundles Task 2).** `git add packages/core/src/runner.ts packages/core/src/index.ts packages/core/src/loop.ts packages/core/src/__tests__/{runner,loop}.test.ts && git commit -m "feat(loop): track stage cost, enforce --budget, pace with --cooldown + adaptive backoff"`

## Task 4: CLI flags `--budget` / `--cooldown` (TDD where parseable)

**Files:** Modify `packages/core/src/cli-help.ts`, `packages/core/src/run-bin.ts`.

- [ ] **Step 1: Extend `parseFlags`**

Add `budget?: number; cooldownMs?: number;` to `CliFlags`. Add parsing mirroring `--max-retries` (an `expecting…` flag + validation):

- `--budget <usd>`: parse `Number(a)`; error if `!Number.isFinite || <= 0` → `--budget must be a positive number, got: …`.
- `--cooldown <ms>`: parse int; error if `!/^\d+$/.test(a)` → `--cooldown must be a non-negative integer (ms), got: …`.

- [ ] **Step 2: Add to `--help` + `--print-config`**

In `printHelp`, add the two flags under Flags. In `printConfig`, add `PrintConfigOptions` fields `budget?: number; cooldownMs?: number;` and print:

```
  budget                ${budget != null ? `$${budget.toFixed(2)}` : "off"}
  cooldown              ${cooldownMs ? `${cooldownMs}ms` : "off"}
```

- [ ] **Step 3: Thread through `run-bin.ts`**

Pass `budgetUsd: flags.budget, cooldownMs: flags.cooldownMs` into `runLoop(...)`, and into the `printConfig(...)` opts.

- [ ] **Step 4: Verify.** `pnpm -r typecheck && pnpm -r test`, then `node apps/cli/bin/ralph-afk.js --print-config --budget 2.5 --cooldown 1500 x 1` shows `budget $2.50`, `cooldown 1500ms`.

- [ ] **Step 5: Commit** — `git commit -am "feat(cli): --budget and --cooldown flags + print-config"`

---

# FEATURE B — paced reviewer panel

## Task 5: Generic `{{ KEY }}` substitution in `render.ts` (TDD)

**Files:** Modify `packages/core/src/render.ts`; add/extend a render test (`packages/core/src/__tests__/render.test.ts` — create if absent).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate } from "../render.js";

describe("renderTemplate generic vars", () => {
  it("substitutes arbitrary {{ KEY }} vars and leaves unknown tags", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-render-"));
    const tpl = join(dir, "t.md");
    writeFileSync(
      tpl,
      "lens={{ LENS }} in={{ INPUTS }} keep={{ UNKNOWN }}",
      "utf8"
    );
    const out = renderTemplate(tpl, { LENS: "security", INPUTS: "plan" });
    expect(out).toBe("lens=security in=plan keep={{ UNKNOWN }}");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run → fail** (LENS unsupported).

- [ ] **Step 3: Implement.** Change `RenderVars` to `export type RenderVars = Record<string, string>;`. Replace the final `INPUTS_TAG` substitution with a generic pass:

```ts
const GENERIC_TAG = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;
// …last step, replacing `return afterShell.replace(INPUTS_TAG, vars.INPUTS);`
return afterShell.replace(GENERIC_TAG, (match, key: string) =>
  Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
);
```

Keep the SECURITY comment; note the substitution is still last + never re-shelled. Remove the now-unused `INPUTS_TAG` const.

- [ ] **Step 4: Run → pass.** Also run `node scripts/smoke-templates.mjs` (real templates still render).

- [ ] **Step 5: Commit** — `git commit -am "feat(render): generic {{ KEY }} substitution (was INPUTS-only)"`

## Task 6: Extract `executeStage` (behavior-preserving refactor)

**Files:** Create `packages/core/src/stage-exec.ts`; modify `packages/core/src/loop.ts`. Guarded by existing `loop.test.ts` (retry/failure/abort assertions must stay green).

- [ ] **Step 1: Create `stage-exec.ts`** with the loop's current inner machinery:

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { renderTemplate } from "./render.js";
import { DEFAULT_BACKOFF_MS, backoffFor, withRetries } from "./retry.js";
import { runStage, stageLogPath, type StageResult } from "./runner.js";
import { USE_COLOR, dim } from "./stream-render.js";
import type { Stage } from "./stages.js";

export type ExecuteStageOptions = {
  stage: Stage;
  vars: Record<string, string>;
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  signal?: AbortSignal;
  /** Disambiguates spill/log paths when multiple sub-stages share an iteration (panel lenses). */
  logLabel?: string;
};

/** Render a stage's template (inside the retry, so flaky shell tags retry) and run it. */
export async function executeStage(
  opts: ExecuteStageOptions
): Promise<StageResult> {
  const {
    stage,
    vars,
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    signal,
  } = opts;
  const label = opts.logLabel ?? stage.name;
  const spillRel = `spill-${process.pid}-${iteration}-${label}-${Date.now()}`;
  const spillHostDir = join(workspaceDir, ".ralph-tmp", spillRel);
  const spillRefPath = posix.join(".ralph-tmp", spillRel);
  const stageLog = stageLogPath(workspaceDir, iteration, label);
  mkdirSync(dirname(stageLog), { recursive: true });

  return withRetries(
    () => {
      const prompt = renderTemplate(
        join(packageDir, "templates", stage.template),
        vars,
        { cwd: workspaceDir, spillHostDir, spillRefPath }
      );
      return runStage(
        stage,
        prompt,
        workspaceDir,
        iteration,
        spillHostDir,
        stageLog,
        { signal }
      );
    },
    {
      max: maxRetries,
      backoffMs: DEFAULT_BACKOFF_MS,
      onAttempt: (attempt, err) => {
        const wait = backoffFor(DEFAULT_BACKOFF_MS, attempt);
        const marker = `[retry] attempt ${attempt} of ${maxRetries} after ${wait} ms`;
        process.stderr.write(
          `${USE_COLOR ? dim(marker) : marker} ${dim("(" + (err as Error).message + ")")}\n`
        );
        try {
          appendFileSync(stageLog, marker + "\n");
        } catch {
          // log file may be unwritable; never crash on the marker.
        }
      },
    }
  );
}
```

- [ ] **Step 2: Rewrite the loop's inner block to call it.** In `loop.ts`, replace the per-stage `spillRel`/`spillHostDir`/`spillRefPath`/`stageLog`/`withRetries(render→runStage)` block with:

```ts
let sr: StageResult;
try {
  sr = await executeStage({
    stage,
    vars: { INPUTS: inputs },
    workspaceDir,
    packageDir,
    iteration: i,
    maxRetries,
    signal: stageAbort.signal,
  });
} catch (err) {
  // terminal failure marker (write to the same log path executeStage used is not available here;
  // log a failure line to a fresh path is acceptable — keep prior behavior by writing to stageLogPath).
  const stageLog = stageLogPath(workspaceDir, i, stage.name);
  const failureMarker = `[failure] iteration ${i} stage ${stage.name} failed after ${maxRetries} retries: ${(err as Error).message}`;
  try {
    appendFileSync(stageLog, failureMarker + "\n");
  } catch {
    /* unwritable */
  }
  process.stderr.write(
    `${red(SYM.cross)} ${bold("iteration " + i + " stage " + stage.name + " failed")} after ${maxRetries} retries: ${(err as Error).message}\n`
  );
  break;
}
```

> The existing `loop.test.ts` asserts the `[failure]` marker lands in `iter<N>-<stage>.ndjson` (the mocked `stageLogPath` is deterministic, no timestamp), so writing the failure marker via `stageLogPath(workspaceDir, i, stage.name)` in the catch keeps that test green. The `[retry]` marker now comes from `executeStage` (same mocked path). Run the suite to confirm.

Import `executeStage` and `type StageResult`; drop now-unused imports (`renderTemplate`, `withRetries`, `backoffFor`, `DEFAULT_BACKOFF_MS`, `posix`) from loop.ts if no longer referenced.

- [ ] **Step 3: Run the FULL existing loop suite → must stay green** (retry, failure, abort, render-failure tests): `pnpm --filter @daonhan/ralph-core test -- loop`. If any retry/failure/abort assertion breaks, the extraction changed behavior — fix until identical.

- [ ] **Step 4: Commit** — `git commit -am "refactor: extract executeStage (render+retry+runStage) for reuse"`

## Task 7: Panel templates

**Files:** Create `packages/core/templates/review-lens.md`, `packages/core/templates/review-synth.md`.

- [ ] **Step 1: `review-lens.md`** (read-only, single lens; mirrors review.md's HEAD spill):

```markdown
<head>

!?`git rev-parse HEAD|||(no commits)`

</head>

<latest-diff>

!?`git show --stat HEAD|||No diff`

Full patch spilled to: @spill?:head.diff=`git show HEAD|||No diff body`

Read that file with `Read` (use `offset`/`limit` for large diffs) before reviewing.

</latest-diff>

# REVIEWER — {{ LENS }} lens

You review the most recent commit (HEAD) through ONE lens only: **{{ LENS }}**.

- `correctness` — bugs, regressions, broken logic, unhandled edge cases.
- `security` — input validation, secrets, injection, auth bypass.
- `tests` — coverage gaps for the changed code; missing/weak assertions.

If `<head>` shows `(no commits)`, output `<lens>SKIP</lens>` and stop.

# OUTPUT

List concrete findings for the **{{ LENS }}** lens only, each as `- <file>:<line> — <issue>`. Be terse. If nothing for this lens, output `none`.

# RULES

- READ-ONLY. Do **not** edit files. Do **not** commit. Do **not** run feedback loops.
- Only the {{ LENS }} lens — ignore issues another lens owns.
```

- [ ] **Step 2: `review-synth.md`** (the only writer/committer):

```markdown
<head>

!?`git rev-parse HEAD|||(no commits)`

</head>

# REVIEW SYNTHESIS

Three review lenses (correctness / security / tests) each examined HEAD. Their findings are in `{{ FINDINGS_DIR }}` — `Read` every `findings-*.md` file there.

# ACTION

1. Dedupe the findings and discard false positives / non-issues.
2. If real defects remain, fix them in the working tree (only the latest commit's code — no unrelated changes), run the feedback loops:
   - Frontend / Node: `pnpm run test`, `pnpm run typecheck`
   - Backend / Dotnet: `dotnet test`, `dotnet build`
     then make a SINGLE commit: `git commit -am "fix(review): <short reason>"` (subject ≤72 chars, no `Co-Authored-By`, no file lists).
3. If nothing real remains, output `<review>OK</review>` and do **not** commit.

# RULES

- Never amend the implementer's commit — always a new `fix(review):` commit.
- Single pass. Do not loop.
```

- [ ] **Step 3: Smoke render.** `node scripts/smoke-templates.mjs` should still pass (it checks the shipped afk/ghafk/review templates; new ones are inert there). Manually confirm the new templates render with a `LENS`/`FINDINGS_DIR` var via a quick node one-liner using `renderTemplate`, or rely on Task 8 tests.

- [ ] **Step 4: Commit** — `git add packages/core/templates/review-lens.md packages/core/templates/review-synth.md && git commit -m "feat(templates): review-lens + review-synth panel prompts"`

## Task 8: `panel.ts` — `runPanel` (TDD with mocked executeStage)

**Files:** Create `packages/core/src/panel.ts`, `packages/core/src/__tests__/panel.test.ts`.

- [ ] **Step 1: Failing test** — mock `stage-exec.js` + `pacing.js`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { runPanel } from "../panel.js";

const ok = (result: string, costUsd = 0) => ({
  result,
  costUsd,
  isError: false,
  apiErrorStatus: null,
});

describe("runPanel", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "ralph-panel-"));
    mocks.executeStage.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  it("runs each lens then synth, writes findings files, sums cost, returns synth result", async () => {
    mocks.executeStage.mockImplementation((opts) =>
      Promise.resolve(
        opts.stage.template === "review-synth.md"
          ? ok("<review>OK</review>", 0.5)
          : ok(`finding for ${opts.vars.LENS}`, 0.1)
      )
    );
    const costs: number[] = [];
    const out = await runPanel({
      lenses: ["correctness", "security", "tests"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 1000,
      onCost: (c) => costs.push(c),
    });
    // 3 lenses + 1 synth
    expect(mocks.executeStage).toHaveBeenCalledTimes(4);
    // order: lens templates use review-lens.md with LENS var, then synth
    const templates = mocks.executeStage.mock.calls.map(
      (c) => c[0].stage.template
    );
    expect(templates).toEqual([
      "review-lens.md",
      "review-lens.md",
      "review-lens.md",
      "review-synth.md",
    ]);
    // cooldown between sub-agents (after each lens) — 3 sleeps
    expect(mocks.sleep).toHaveBeenCalledTimes(3);
    // cost summed via onCost: 0.1*3 + 0.5
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.8);
    // synth result returned
    expect(out.result).toBe("<review>OK</review>");
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `panel.ts`**

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { executeStage } from "./stage-exec.js";
import { sleep } from "./pacing.js";
import type { StageResult } from "./runner.js";
import { dim } from "./stream-render.js";

const LENS_STAGE = {
  name: "review-lens",
  template: "review-lens.md",
  permissionMode: "bypassPermissions",
};
const SYNTH_STAGE = {
  name: "review-synth",
  template: "review-synth.md",
  permissionMode: "bypassPermissions",
};

export type RunPanelOptions = {
  lenses: string[];
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  cooldownMs: number;
  signal?: AbortSignal;
  onCost?: (usd: number) => void;
};

/** Harness-orchestrated reviewer panel: read-only lens reviews → one synth fix(review) commit. */
export async function runPanel(opts: RunPanelOptions): Promise<StageResult> {
  const {
    lenses,
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    cooldownMs,
    signal,
    onCost,
  } = opts;
  const panelRel = `panel-${process.pid}-${iteration}-${Date.now()}`;
  const panelHostDir = join(workspaceDir, ".ralph-tmp", panelRel);
  mkdirSync(panelHostDir, { recursive: true });
  try {
    for (let i = 0; i < lenses.length; i++) {
      const lens = lenses[i];
      process.stderr.write(
        `${dim(`panel lens: ${lens} (${i + 1}/${lenses.length})`)}\n`
      );
      const sr = await executeStage({
        stage: LENS_STAGE,
        vars: { LENS: lens },
        workspaceDir,
        packageDir,
        iteration,
        maxRetries,
        signal,
        logLabel: `lens-${lens}`,
      });
      onCost?.(sr.costUsd);
      writeFileSync(
        join(panelHostDir, `findings-${lens}.md`),
        sr.result,
        "utf8"
      );
      if (cooldownMs > 0) await sleep(cooldownMs, signal);
    }
    process.stderr.write(`${dim("panel synth")}\n`);
    const synth = await executeStage({
      stage: SYNTH_STAGE,
      vars: { FINDINGS_DIR: `./${posix.join(".ralph-tmp", panelRel)}/` },
      workspaceDir,
      packageDir,
      iteration,
      maxRetries,
      signal,
      logLabel: "synth",
    });
    onCost?.(synth.costUsd);
    return synth;
  } finally {
    rmSync(panelHostDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run → pass.** `pnpm --filter @daonhan/ralph-core test -- panel`

- [ ] **Step 5: Commit** — `git add packages/core/src/panel.ts packages/core/src/__tests__/panel.test.ts && git commit -m "feat(panel): harness-orchestrated reviewer panel (lenses → synth)"`

## Task 9: Wire the panel into the loop + CLI

**Files:** Modify `packages/core/src/loop.ts`, `packages/core/src/cli-help.ts`, `packages/core/src/run-bin.ts`, `packages/core/src/index.ts`.

- [ ] **Step 1: Loop dispatch.** Add `reviewLenses?: string[]` to `LoopOptions`. Import `runPanel`. In the stage walk, replace the single `executeStage(...)` call with a dispatch:

```ts
const usePanel =
  reviewLenses && reviewLenses.length > 0 && stage.name === "reviewer";
sr = usePanel
  ? await runPanel({
      lenses: reviewLenses!,
      workspaceDir,
      packageDir,
      iteration: i,
      maxRetries,
      cooldownMs,
      signal: stageAbort.signal,
      onCost: (c) => {
        runCostUsd += c;
      },
    })
  : await executeStage({
      stage,
      vars: { INPUTS: inputs },
      workspaceDir,
      packageDir,
      iteration: i,
      maxRetries,
      signal: stageAbort.signal,
    });
```

> Because `runPanel`'s `onCost` already adds each sub-agent's cost to `runCostUsd`, set the panel branch's own `sr.costUsd` contribution to 0 to avoid double-counting: after the dispatch, do `runCostUsd += usePanel ? 0 : sr.costUsd;` (i.e. only add `sr.costUsd` for the non-panel branch). Keep the rest of the accounting (report line, throttle factor) using `sr`.

- [ ] **Step 2: CLI flag.** In `cli-help.ts` `parseFlags`, add `reviewPanel: boolean` (set by `--review-panel`). In `printHelp`, document `--review-panel` and the `RALPH_REVIEW_LENSES` env var. In `printConfig`, add a `review` line:

```
  review                ${panelLenses.length ? `panel: ${panelLenses.join(", ")}` : "single reviewer"}
```

where the caller passes the resolved lenses.

- [ ] **Step 3: Resolve lenses in `run-bin.ts`.**

```ts
const DEFAULT_LENSES = ["correctness", "security", "tests"];
const envLenses = (process.env.RALPH_REVIEW_LENSES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const reviewLenses =
  envLenses.length > 0
    ? envLenses
    : flags.reviewPanel
      ? DEFAULT_LENSES
      : undefined;
```

Pass `reviewLenses` into `runLoop(...)` and the resolved list into `printConfig(...)`.

- [ ] **Step 4: Verify.** `pnpm -r typecheck && pnpm -r test && pnpm test`. Then:
      `node apps/cli/bin/ralph-afk.js --print-config --review-panel x 1` → `review  panel: correctness, security, tests`.
      `RALPH_REVIEW_LENSES=correctness node apps/cli/bin/ralph-afk.js --print-config x 1` → `review  panel: correctness`.

- [ ] **Step 5: Commit** — `git commit -am "feat: wire --review-panel / RALPH_REVIEW_LENSES into the loop"`

## Task 10: Full verification + live panel smoke

**Files:** none.

- [ ] **Step 1: Gate.** `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm test` — all green.

- [ ] **Step 2: Budget/cooldown smoke (no model call needed).** `node apps/cli/bin/ralph-afk.js --print-config --budget 5 --cooldown 2000 --review-panel x 1` shows all three resolved.

- [ ] **Step 3: Live panel smoke (real claude; requires auth — surface to the human).** In a throwaway repo with one trivial commit:

```bash
RALPH_WORKSPACE=/tmp/ralph-smoke node apps/cli/bin/ralph-afk.js --review-panel --cooldown 1000 "Read plan.md and create the file it describes" 1
```

Expect: implementer stage, then **three lens stages** (correctness/security/tests, read-only — no commits), ~1s cooldowns between them, then one synth stage that emits `<review>OK</review>` or a single `fix(review):` commit. A running cost line prints per stage. Inspect `.ralph-tmp/logs/*lens-*.ndjson` + confirm the `panel-*` dir was created and cleaned.

- [ ] **Step 4: Commit any fallout** — `git commit -am "test: verify budget/pacing + reviewer panel end to end" || echo "nothing to commit"`

---

## Self-Review (completed)

- **Spec coverage:** A — StageResult+parser (T2), accumulation/budget/cooldown/adaptive (T3), flags (T4), sleep+factor helpers (T1). B — render generic vars (T5), executeStage (T6), templates (T7), runPanel (T8), wiring (T9). Verification (T10). ✓
- **Placeholders:** none — full code for every pure/new unit; precise edit instructions for wiring. ✓
- **Type consistency:** `StageResult` shape identical across runner/loop/panel/stage-exec; `executeStage(ExecuteStageOptions)`, `runPanel(RunPanelOptions)`, `resultFromEvent`, `sleep`/`isThrottle`/`nextCooldownFactor`, `CliFlags.{budget,cooldownMs,reviewPanel}` consistent across tasks. ✓
- **Double-counting guard** (T9) called out explicitly: panel cost flows via `onCost`, so the dispatch must not also add `sr.costUsd`. ✓
- **Refactor safety** (T6): `executeStage` extraction guarded by the existing detailed loop tests; failure marker path preserved. ✓
