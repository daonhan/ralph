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
