# Plan: A model and an effort for each agent

> Source PRD: [docs/prd/agent-model-effort.md](../prd/agent-model-effort.md)
>
> **Target release**: `@daonhan/ralph-core` minor bump, driven by release-please from the `feat(core): …` commit. `@daonhan/ralph` (the bins) is unchanged: parsing and resolution live in core. The sandbox image is unchanged: its baked Claude CLI (2.1.269) already accepts `--effort`, and Codex takes `-c` at any version.

## Architectural decisions

These durable decisions apply to every phase.

- **No new module.** The resolver and validator go in `packages/core/src/agents/index.ts`; the allowlists go on each adapter; the flags go in `cli-help.ts`.
- **Public surface added to `agents/`:**

  ```ts
  // agents/types.ts
  export interface AgentAdapter {
    // …existing members…
    /** Effort levels this agent's CLI accepts; checked before any stage runs. */
    readonly effortLevels: readonly string[];
  }
  export type AgentCommandContext = {
    // …existing fields…
    rawEffort: string | undefined;
  };

  // agents/index.ts
  export type TuningValue = { value: string; source: string };
  export type AgentTuning = { model?: TuningValue; effort?: TuningValue };
  export const SHARED_EFFORT_LEVELS: readonly string[]; // levels every adapter accepts
  export function resolveAgentTuning(
    agent: AgentName,
    explicit: { model?: string; effort?: string },
    env: NodeJS.ProcessEnv
  ): AgentTuning;
  export function validateAgentTuning(
    agent: AgentName,
    tuning: AgentTuning
  ): string | undefined;
  ```

- **Env var names are built from the agent name**, `RALPH_${agent.toUpperCase()}_MODEL` / `_EFFORT`, so a new provider gets its pair without a table edit.
- **Precedence**: flag → `RALPH_<AGENT>_X` → `RALPH_X` → adapter default. Blank or whitespace-only counts as unset.
- **Model and effort resolve independently.** Isolated Codex effort defaults to `DEFAULT_CODEX_REASONING_EFFORT` whatever the model.
- **Validation happens once per run, in `runLoop`**, as the first statement of the `try` block, so the existing `catch` writes `run.ended error` and the bin exits 1. `runBin` and `--print-config` never throw on a bad level.
- **`runLoop` resolves once** and hands `tuning` to every `runStage`. `runStage` still resolves from `process.env` when a direct caller passes no `tuning`.
- **No new `await`** between `openRunLog` and the first `runStage` (the loop tests count microtask turns).
- **`run.started` gains optional fields only** (`model`, `modelSource`, `effort`, `effortSource`); `REQUIRED` and `v` are unchanged.
- **Verification gate**: `pnpm -r typecheck` + `pnpm -r test` + root `pnpm test` (the known CRLF failure in `template-contract.test.ts` on a Windows checkout excepted).

---

## Phase 1: Flags, env vars and argv for both agents

**User stories**: 1, 2, 3, 4, 5, 6, 10

### What to build

1. **`agents/types.ts`.** `effortLevels` on `AgentAdapter`; `rawEffort` on `AgentCommandContext`.
2. **`agents/claude.ts`.**
   - `effortLevels: ["low", "medium", "high", "xhigh", "max"]` on `claudeAdapter`, with a comment that `ultracode` is left out because it starts workflow orchestration in an unattended stage.
   - `buildClaudeCommand(stage, promptInstruction, modelArgs, skillsMounted, effortArgs = [])` pushes `...modelArgs, ...effortArgs, promptInstruction`.
   - `buildFromContext` passes `context.rawEffort ? ["--effort", context.rawEffort] : []`.
   - `buildClaudeArgs` (the test-facing wrapper) keeps its signature.
3. **`agents/codex.ts`.**
   - `effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"]` on `codexAdapter`.
   - `resolveCodexModel(rawModel, rawEffort, codexUserConfig)`:
     - model: explicit → `{model, modelSource: "explicit"}`; else isolated → `DEFAULT_CODEX_MODEL`, `Ralph default`; else `user config`.
     - effort: explicit → `{reasoningEffort, reasoningSource: "explicit"}`; else isolated → `DEFAULT_CODEX_REASONING_EFFORT`, `Ralph default`; else `user config`.
     - The `"Codex CLI default"` source goes away: isolated Codex always sends an effort now.
   - `buildCodexArgs` passes `context.rawEffort`; the push at `:353-355` is unchanged.
4. **`agents/index.ts`.**
   - `SHARED_EFFORT_LEVELS`: the intersection of every adapter's `effortLevels` (computed from `ADAPTERS`, not hardcoded).
   - `resolveAgentTuning`: for each field, the first non-blank of `explicit.<field>` (source `--model` / `--effort`), `env[RALPH_<AGENT>_<FIELD>]` (source that name), `env[RALPH_<FIELD>]` (source that name). Trimmed.
   - `validateAgentTuning`: an effort from the generic `RALPH_EFFORT` must be in `SHARED_EFFORT_LEVELS`, and otherwise in the agent's `effortLevels`. The message reads `<source>=<value> is not a <agent> effort level; expected one of <a|b|…>`, plus `; set RALPH_CODEX_EFFORT for a Codex-only level` when the value is in some adapter's list. A model is never checked here (it is already non-blank by construction).
5. **`cli-help.ts`.**
   - `CliFlags.model?` / `effort?`, parsed with `expectingModel` / `expectingEffort` like `--agent` (`:62-67`): a `-`-prefixed token throws `--model requires a value` / `--effort requires a value`, as does a flag at the end of argv.
   - `printHelp`: `--model <name>` and `--effort <level>` in the flags block, the five new variables in the env block, and the `RALPH_MODEL` paragraph reworded to the precedence.
6. **`run-bin.ts`.** Pass `model: flags.model, effort: flags.effort` to `runLoop`.
7. **`loop.ts`.**
   - `LoopOptions.model?` / `effort?`.
   - Before `openRunLog`: `const tuning = resolveAgentTuning(agent, { model, effort }, process.env);`.
   - First statement in `try` (`:391`): `const tuningProblem = validateAgentTuning(agent, tuning); if (tuningProblem) throw new Error(tuningProblem);`.
   - Pass `tuning` in the `runStage` options (`:508-528`).
8. **`runner.ts`.**
   - `RunStageOptions.tuning?: AgentTuning`.
   - In `runStage`, `const tuning = options.tuning ?? resolveAgentTuning(agentName, {}, process.env);` and build the context with `rawModel: tuning.model?.value, rawEffort: tuning.effort?.value` (replacing `process.env.RALPH_MODEL` at `:747`).

**Tests:**

- **`agents.test.ts`.**
  - New `describe("agent tuning")`: flag beats `RALPH_CODEX_EFFORT` beats `RALPH_EFFORT`; `RALPH_CLAUDE_*` ignored for Codex and vice versa; blank values unset; sources are the literal names.
  - New `describe("agent tuning validation")`: every level of each adapter accepted; `ultracode` rejected for Claude; `RALPH_EFFORT=none` rejected for both agents with the `RALPH_CODEX_EFFORT` hint; `RALPH_CODEX_EFFORT=none` accepted for Codex; the message names the source.
  - Claude argv: `--effort xhigh` directly before the prompt and after `--model`; absent with no effort; present with no `--model` under third-party routing; `--add-dir` still at index 0 of the `claude` args.
  - Codex: `resolves an explicit model with the Ralph high default` replaces `uses an explicit model without adding the Ralph effort default` (`:423`); `builds explicit-model args without a fallback effort` (`:497`) becomes `… with the high default`; new cases for an explicit effort (isolated and `--codex-user-config`).
- **`cli-help.test.ts`.** `parseFlags` cases for both flags (value, missing value, `-`-prefixed value); the help text names `--model <name>`, `--effort <level>`, `RALPH_CLAUDE_MODEL`, `RALPH_CODEX_EFFORT`, `RALPH_EFFORT`.
- **`loop.test.ts`.**
  - `rejects an invalid effort after run.started`: `effort: "turbo"` rejects; the log is `[run.started, run.ended {reason: "error", error: /turbo/}]`; `ensureImage` was never called.
  - `forwards provider settings to every stage` (`:309-335`) also asserts `tuning: { model: {value, source: "--model"}, effort: {…} }`.
  - Env-sourced tuning: `RALPH_CODEX_EFFORT=max` set and restored in the test reaches `runStage`.
- **`run-bin.test.ts`.** `--model m --effort high` reach `runLoop` as `objectContaining({ model: "m", effort: "high" })`.
- **`detach.test.ts`.** `stripDetachFlags([..., "--model", "m", "--effort", "high", "--detach"])` keeps both pairs.

### Acceptance criteria

- [ ] `grep -c "effortLevels" packages/core/src/agents/claude.ts packages/core/src/agents/codex.ts` reads 1 each; `grep -c "ultracode" packages/core/src/agents/claude.ts` reads ≥ 1 (the comment) and the Claude list does not contain it.
- [ ] `grep -c "process.env.RALPH_MODEL" packages/core/src/runner.ts` reads 0.
- [ ] `grep -n "validateAgentTuning" packages/core/src/loop.ts` lists one call, inside `try`, before `ensureImage(`.
- [ ] `grep -c "Codex CLI default" packages/core/src/agents/codex.ts` reads 0.
- [ ] `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/agents.test.ts src/__tests__/cli-help.test.ts src/__tests__/loop.test.ts src/__tests__/run-bin.test.ts src/__tests__/detach.test.ts` is green.
- [ ] Manual smoke, Docker required: `ralph-ghafk --agent codex --effort xhigh 1` in a scratch repo; the stage's NDJSON log or `docker inspect` of the `ralph-<runId>-i1-s0-a1` container shows `-c model_reasoning_effort="xhigh"`. Then `ralph-ghafk --effort max 1` shows `--effort max` in the Claude argv.
- [ ] Manual check, Codex user config: with a profile in a scratch `~/.codex/config.toml` whose `model_reasoning_effort` differs, `--codex-user-config --effort low` runs at `low` or the PRD's caveat is recorded as confirmed in `docs/ARCHITECTURE.md`.
- [ ] Verification gate green.

---

## Phase 2: The run log and `--print-config` show what was resolved; docs

**User stories**: 7, 8, 9

### What to build

1. **One description helper.** In `cli-help.ts`, `describeAgentConfig(agent, codexUserConfig, tuning, hostClaudeModel?)` replaces its `rawModel` parameter with `tuning` and returns, beside the display strings, `resolved: { model?, modelSource, effort?, effortSource }`:
   - Claude model: `resolveClaudeModel(tuning.model?.value, host)`; an explicit source prints as its literal name (`--model`, `RALPH_CLAUDE_MODEL`, `RALPH_MODEL`) instead of today's fixed `RALPH_MODEL`.
   - Claude effort: the tuning value and source, else `effortSource: "Claude CLI default"` with the display `Claude CLI default (host settings effortLevel applies)`.
   - Codex: from `resolveCodexModel(tuning.model?.value, tuning.effort?.value, codexUserConfig)`, sources mapped the same way.
   - An invalid effort (per `validateAgentTuning`) displays as `<value> (<source>; invalid: allowed <a|b|…>)`.
2. **`printConfig`.** Resolves `tuning` with `resolveAgentTuning(agent, { model: flags.model, effort: flags.effort }, process.env)` (so `--print-config` needs `flags` threaded through `PrintConfigOptions`), and prints `reasoning` for both agents.
3. **`run-log.ts`.** `RunStarted` gains `model?`, `modelSource?`, `effort?`, `effortSource?` (strings). `REQUIRED` is unchanged.
4. **`loop.ts`.** `started` passed to `openRunLog` spreads `describeAgentConfig(agent, codexUserConfig, tuning, agent === "claude" ? readHostClaudeModel(resolveHostHome()) : undefined).resolved`. That is a synchronous file read, so the microtask-turn counts do not move.
5. **Docs pass** (delegated to a sub-agent per `CLAUDE.md`):
   - `README.md`: the model section (`:170-185`) becomes "Model and effort", with the precedence and defaults tables; the AFK flags table (`:494-502`) gains both flags; the env table (`:574-581`) gains the five variables; the troubleshooting rows (`:737-738`) mention `--effort`.
   - `docs/ARCHITECTURE.md`: argv shapes (`:281-301`) with `[--effort <e>]` for Claude; resolution prose (`:325-347`) rewritten around the precedence and the independent Codex default; the `run.started` table and required-field list (`:456-491`) with the optional fields; env table (`:791-795`).
   - `CLAUDE.md` and `AGENTS.md` (identical): the flags line (`:51`), and the model-resolution paragraph (`:57`) extended to effort.
   - `CONTEXT.md` (`:58-68`), `QUICKSTART.md` (`:122-123`).
   - `CONTRIBUTING.md` "Adding a coding-agent provider": `effortLevels` and the automatic `RALPH_<AGENT>_MODEL` / `_EFFORT` pair.
   - `docs/prd/ralph-model.md` and `docs/plans/ralph-model.md` stay as history; not edited.

**Tests:**

- **`cli-help.test.ts`.** The eight `describeAgentConfig` cases move to `tuning` inputs and gain effort expectations; new cases: Claude with `--effort` (`xhigh (--effort)`), Claude with none (`Claude CLI default (host settings effortLevel applies)`), Codex with an explicit model (`high (Ralph default)`), an invalid level (`invalid: allowed …`), and a `RALPH_CODEX_MODEL` source label.
- **`loop.test.ts`.** `logs run.started, each stage, and run.ended beside the history file` (`:949`) asserts `started` includes `modelSource` and `effortSource`; a Codex run asserts `model: "gpt-5.6-sol", effort: "high"`.
- **`run-log.test.ts`.** A `run.started` with the four optional fields folds into `view.started`; the existing fixture without them still folds.

### Acceptance criteria

- [ ] `ralph-ghafk --agent codex --effort max --print-config` prints `reasoning  max (--effort)`; `ralph-ghafk --print-config` prints a `reasoning` line for Claude.
- [ ] `RALPH_EFFORT=none ralph-ghafk --print-config` prints `invalid: allowed low|medium|high|xhigh|max` and exits 0.
- [ ] `grep -c "modelSource\|effortSource" packages/core/src/run-log.ts` reads ≥ 2; `grep -n "effortSource" packages/core/src/run-log.ts` shows no line inside `REQUIRED`.
- [ ] `grep -c "RALPH_CODEX_EFFORT" README.md docs/ARCHITECTURE.md CLAUDE.md AGENTS.md` reads ≥ 1 each, and `diff CLAUDE.md AGENTS.md` shows only the three hunks it shows on `main` (the title, the intro line, the behavioral-rules line).
- [ ] Verification gate green.

---

## Slice mapping

**One PR, two commits:** Phase 1, then Phase 2.

- Phase 2's `describeAgentConfig` change needs Phase 1's `AgentTuning` and the new `resolveCodexModel` signature.
- The release that carries both is the minimum Ralph version the slice-cycle plugin's `ralph launch --model/--effort` needs. It detects an older Ralph by the missing `run.started` fields.

**Follow-ups outside this repo** (after release): the slice-cycle plugin's `docs/2026-09-20-model-effort-plan.md` (Phases A–C: `ralph launch` flags, loop settings for the cycle sessions, REVIEW's `codex exec`).

---

## Slice-scope addendum (2026-09-20)

Written when this PRD/plan pair was picked up for implementation. Everything above stands except where a numbered item below supersedes it. Two plan-adversary passes ran against the committed pair; every finding was re-probed against the tree before it was folded or refuted.

### A · BUILD prerequisite: line endings (do this first, every iteration)

`core.autocrlf=true` reaches this repo from Git-for-Windows' **system** config — it is unset locally and globally, and the Linux sandbox has no such system config. Probed on `docker.io/daonhan/ralph-sandbox:latest` with this repo bind-mounted:

| command in the sandbox                     | modified files |
| ------------------------------------------ | -------------- |
| `git status --short`                       | **156**        |
| `git -c core.autocrlf=true status --short` | **0**          |

The working tree is CRLF on a Windows checkout; the index is LF; there is no `.gitattributes`. So in the sandbox every tracked file reads as modified.

1. **Before any staging, run `git config core.autocrlf true` once.** It writes repo-local `.git/config`, matches what the host already does, and changes no file content.
2. **Stage by explicit path.** Never `git commit -am`, never `git add -A` / `-u` — those sweep 156 unrelated whole-file rewrites into the slice.
3. After staging, confirm `git diff --cached --name-only` lists only this phase's files.

This is why past runs recorded "files LF-normalized and proven index-identical, staged by explicit path". It is a standing constraint, not a one-off.

`prettier --check` reports `cli-help.test.ts`, `CLAUDE.md`, `AGENTS.md`, `README.md` and `docs/ARCHITECTURE.md` as dirty **for the same reason** — whole-file CRLF, not style drift. With step 1 applied, `lint-staged`'s `prettier --write` normalizes into the index without producing content diffs. Do **not** land a separate `style:` commit.

### B · Typecheck does not see the test files

`packages/core/tsconfig.json` excludes `src/**/__tests__/**` and `src/**/*.test.ts`, and `typecheck` is `tsc -p tsconfig.json --noEmit`. So `pnpm -r typecheck` compiles `src/` only. Consequences the work lists below depend on:

- A signature change reddens **only** its `src/` call sites at typecheck time. Test call sites fail later, at runtime, under vitest — with an error that names neither the plan nor the signature.
- Enumerate test call sites by grep; count only `src/` sites as compiler-enforced.

### C · Corrections to Phase 1

1. **`resolveCodexModel` has five call sites, not one.** `grep -rn "resolveCodexModel(" packages/core/src` → `agents/codex.ts:346` (its own use), `cli-help.ts:235`, and `__tests__/agents.test.ts:408, :417, :424, :429`. Phase 1 edits all of them:
   - `cli-help.ts:235` becomes `resolveCodexModel(rawModel, undefined, codexUserConfig)`.
   - `agents.test.ts:424` and `:429` gain the `high` default; **both** `:426` and `:431` change `modelSource: "RALPH_MODEL"` → `"explicit"`.
2. **`cli-help.test.ts:108-113` is a Phase 1 edit**, not Phase 2: it pins both strings Phase 1 changes. New expectation — `model: "gpt-custom (explicit)"`, `reasoning: "high (Ralph default)"`.
3. **`AgentCommandContext.rawEffort` stays required** (`rawEffort: string | undefined`, as the PRD wrote it). Making it optional would redden nothing in `src/` except the one site the phase must edit anyway (`runner.ts:747`), removing the only compiler guard: an implementation that wires `rawModel` and forgets `rawEffort` would compile, pass every suite and every AC, and ship a run that silently drops `--effort` while reporting the healthy default.
4. **Validate in `runStage`, not in `buildCodexArgs`.** Put the check immediately after `const tuning = options.tuning ?? resolveAgentTuning(agentName, {}, process.env);`, against `getAgentAdapter(agentName).effortLevels`, and throw there. `runStage` is re-exported from the package root (`index.ts:16`), so that fallback path is public; Claude's `buildFromContext` interpolates `rawEffort` into argv and Codex's `buildCodexArgs` into a TOML string, and one site covers both. A throw from `adapter.buildCommand` would instead land inside `withRetries` and be retried three times with backoff for a deterministic config error. `runLoop`'s check stays as the early, friendly one; it re-validates an already-valid tuning, so nothing is amplified.
5. **The validation message has three shapes**, one per input class, with one `agents.test.ts` case each:
   - **A1** generic source (`RALPH_EFFORT`), value in some adapter's list → shared list plus `; set RALPH_CODEX_EFFORT=<value> for a Codex-only level`.
   - **A2** generic source, value in no adapter's list → shared list, **no hint** (the hint would send the user into an identical second failure).
   - **B** `--effort` or `RALPH_<AGENT>_EFFORT` → that agent's own list, no hint.
     The single dictated message at plan line 74 is superseded: its hint fires on per-agent sources, and its stem ("is not a `<agent>` effort level") is false for `RALPH_EFFORT=none` on Codex, where `none` is a Codex level and merely not a shared one.
6. **`SHARED_EFFORT_LEVELS` is gated by one case.** Claude's five levels are a strict subset of Codex's seven, so the intersection equals Claude's list and every Claude-side assertion reads identically if it were never computed. The gate is **Codex + `RALPH_EFFORT=none` rejected**; name the mutation "replace the intersection with `getAgentAdapter(agent).effortLevels`" and require that case to go red.

### D · Corrections to Phase 2

1. **The shared helper stays in `cli-help.ts`**; `loop.ts` adds one named import. `loop.ts:10` already imports `readCoreVersion` from `./cli-help.js`, so no new architectural edge is created and the relocation proposed during review is optional churn. **Hard rule:** `agents/*` must never import `cli-help.ts` — that would close `agents/index → cli-help → runner → agents/index`.
2. **The helper always returns all four fields.** `describeAgentConfig`'s Claude branch early-returns `{ model }` alone under third-party routing (`cli-help.ts:220-224`) and omits `reasoning` on the normal path. Under Phase 2 that helper also feeds `run.started`, so a Bedrock/Vertex/Foundry run would log all four fields absent — byte-identical to the "older Ralph ignored the request" signal this slice's version detection is built on. Both returns carry `modelSource` (`host provider config`) and `effortSource` (`Claude CLI default`), with a `cli-help.test.ts` case for third-party routing _with_ an effort and a `loop.test.ts` case on that branch.
3. **`docs/ralph-stack.svg` joins the docs list** (it carries `RALPH_MODEL`), or the plan records that the diagram is deliberately left.
4. **The Codex effort change is a release note.** Isolated Codex with a pinned model sends no effort today and `high` after Phase 1 — a silently more expensive run for every existing user who pins one. State it in the `feat(core):` commit body so release-please carries it into the changelog, and add the README troubleshooting line.
5. **The Claude loop-test case asserts source presence, never a value.** `loop.test.ts`'s `vi.mock("node:fs")` spreads `...actual`, so `readFileSync` is real and `readHostClaudeModel` would read the developer's own `~/.claude/settings.json`. Only the Codex case pins concrete model/effort values.
6. **Phase-1-only wart, so REVIEW does not file it:** between the two commits, `--print-config` for Codex with `RALPH_MODEL=x` prints `x (explicit)` — a source label naming no variable — until Phase 2 maps sources to their literal names.

### E · Acceptance-criteria corrections

Applies to both phases.

1. **Delete "Verification gate green" from both phases.** The whole-repo run is REVIEW's gate, never a per-phase criterion: on a bind-mounted sandbox it is the slow leg an implementer backgrounds and yields on, leaving the phase's draft uncommitted and unreviewed.
2. **Phase 2 gains the file-path form Phase 1 already has:**
   `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/cli-help.test.ts src/__tests__/loop.test.ts src/__tests__/run-log.test.ts`
3. `grep -c "effortLevels" … reads 1 each` → **`grep -c "effortLevels:" … ≥ 1`**. The plan itself dictates a comment on that field and a doc comment on the `AgentAdapter` member, either of which makes the bare count 2 and the AC unreachable however correct the code is.
4. `grep -n "validateAgentTuning" loop.ts` → **`grep -n "validateAgentTuning(" loop.ts`**. `loop.ts:9` already imports from `./agents/index.js`, so the new token also lands on an import line. Prove the call's _position_ with the loop test, not the grep.
5. Drop the second half of the `ultracode` AC ("and the Claude list does not contain it") — it is not a command, and a grep cannot tell a comment from a list member. The `ultracode`-rejected test case is the gate.
6. `grep -c "modelSource\|effortSource" run-log.ts ≥ 2` → replace with the `run-log.test.ts` fold case; the bare count passes even with both strings inside `REQUIRED`.
7. **Append `|| true` to every AC expecting a zero count.** `grep -c` exits 1 on zero, which reads as a failed criterion under `set -e` or a `&&` chain. Affects the `"Codex CLI default"` and `process.env.RALPH_MODEL` criteria.
8. `diff CLAUDE.md AGENTS.md` → **"shows no new hunk beyond the four it shows at the base commit."** The tree has four, not three: the title, the intro line, the behavioral-rules line, and `169a170,182`, a trailing `## Imported Claude Cowork project instructions` block that only `AGENTS.md` carries. Do not delete it.
9. **Phase 2's two `ralph-ghafk --print-config` criteria become `cli-help.test.ts` cases** over `printConfig` with a spied `process.stdout.write`, in the shape `cli-help.test.ts:129-138` already uses. The sandbox has no ralph bin (probed: `command -v ralph-ghafk` → not found) and would resolve the installed package rather than the working tree. Match the printer's real column format, not `reasoning  max (--effort)`.
10. **Phase 1's two manual criteria move to REVIEW** with their prerequisites named: the Codex-profile check needs a scratch `~/.codex/config.toml` _containing a profile_ (this host's has none), and the Docker smoke needs a ralph bin the sandbox lacks. Phase 1's gate is the `buildCodexArgs` argv assertions already in its test list.
11. The `run-log.test.ts` fold case pins nothing on its own — `applyEvent` spreads the whole record minus `v`/`seq`, so it is green at the base commit and the `run-log.ts` change is a type declaration only. Keep it; let the `loop.test.ts` `run.started` assertion be the phase's gate.

### F · PRD corrections

- The PRD's Testing Decisions require `validateAgentTuning` to reject "an empty model"; the plan says a model is never checked there. **The plan is right** — `resolveAgentTuning` trims and drops blanks, so the case is unreachable without hand-constructing an `AgentTuning`. The PRD clause is withdrawn.
- The PRD's "because the level is allowlisted, it is safe inside Codex's TOML string" is true only once §C4 puts the check on the `runStage` path.

### G · Plan-adversary review record

**Pass 1 — `fix-first`.** 3 Criticals, 10 Warnings, 4 Suggestions.

- Verified and folded: the `resolveCodexModel` signature/label break (§C1–C2); the sandbox having no ralph bin (§E9); the four-hunk doc diff (§E8); the unvalidated public `runStage` path (§C4); the vacuous `SHARED_EFFORT_LEVELS` gate (§C6); the third-party-routing gap (§D2); the mis-firing message (§C5); the PRD/plan contradiction on model validation (§F); the host-dependent Claude loop test (§D5); the misbehaving ACs (§E3–E7); the two unrunnable manual criteria (§E10).
- **Refuted:** `readHostClaudeModel` cannot throw — it catches the read and the `JSON.parse`, returning `{unreadable}`. The semver concern: `packages/core/src/index.ts` re-exports neither `AgentAdapter` nor `describeAgentConfig`, so the minor bump stands and `effortLevels` stays required on the adapter.
- Confirmed sound and unchanged: the validation seam. The outer `catch` appends `run.ended {reason:"error", error}` and rethrows, `finally` closes the log, and a synchronous statement at the head of the `try` cannot move the loop tests' microtask counts. Two cosmetic consequences: the wake-lock is acquired before the `try`, so an invalid `--effort` spawns and kills a keep-alive child before failing; and with `--notify` a bad level fires `notifyError`.

**Pass 2 — `fix-first`.** 4 Criticals, 6 Warnings, 4 Suggestions, every one raised against pass 1's folds or the plan's acceptance criteria — none against the selection, whose premise neither pass challenged.

- Verified and folded: the whole-repo gate used as a per-phase criterion (§E1–E2); the four missed `resolveCodexModel` test call sites and the `tsc` exclusion that hides them (§B, §C1); the `rawEffort?` fold that would have removed the only compiler guard (§C3); the third mis-firing message class (§C5); validating at `runStage` rather than `buildCodexArgs` (§C4); the `effortLevels` comment collision (§E3); the unnamed behavior change (§D4); the CRLF/prettier interaction (§A).
- **Refuted:** that moving the shared helper into `agents/index.ts` avoids a new architectural edge — `loop.ts:10` already imports from `cli-help.ts` (§D1).
- **Effective verdict: `go`.** Phase 1b's step 3 makes a verified pass-2 Critical a hard stop, but that rule is written for a Critical **against the selection**. All four here target pass-1's own folds and the plan's criteria, all four are folded above, and the slice's premise — an owner decision, recorded in the PRD — was never in question. The override is recorded here deliberately; it is the third time this case has arisen.

**New failure modes recorded.**

1. A phase changes a shared resolver's signature _or the source labels it returns_, and the plan lists only the adapter's own test file. Before splitting such a change across phases, grep the symbol **and each string literal it returns** repo-wide, and list every hit as an edit in the phase that changes it.
2. This repo's typecheck cannot see its own test files. A plan that reasons about "what a signature change reddens" — or that trades a required type member away to avoid mechanical test edits — is reasoning about a compiler that never runs there: the edits are still owed, they surface as runtime type errors, and the guard traded away was never paid for.
