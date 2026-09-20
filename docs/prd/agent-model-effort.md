# PRD: A model and an effort for each agent

> Written 2026-09-20 from a design session. It collected the owner's decisions, took one plan-adversary red-team (verdict: fix-first), and folds its findings in. The decisions below record that session; they are not open options. The implementation plan is [docs/plans/agent-model-effort.md](../plans/agent-model-effort.md). The slice-cycle plugin's side of the feature has its own PRD in that repo (`docs/2026-09-20-model-effort-prd.md`), which depends on this one.

## Problem Statement

A user who drives Ralph with Claude or Codex cannot say which model and which effort each agent runs with.

**Model: one env var for whichever agent runs.**

- The only input is `RALPH_MODEL`. There is no flag. It is read straight from `process.env` in two places: `--print-config` (`cli-help.ts:342`) and each stage's argv (`runner.ts:747`).
- One variable serves both agents, so a value that names a Claude model breaks a Codex run and vice versa. A caller that picks the agent per run (the slice-cycle loop picks Claude or Codex per cycle, by budget) has to rewrite the variable on every switch.

**Effort: Codex only, and only as a default.**

- Isolated Codex with no `RALPH_MODEL` gets `-c model_reasoning_effort="high"` (`agents/codex.ts:276-281`, `:353-355`). Nothing lets a user choose another level.
- Setting any Codex model, even the default `gpt-5.6-sol`, silently drops that `high` to the Codex CLI's own default (`codex.ts:262-268`).
- The only route to more Codex effort is `--codex-user-config` plus a `model_reasoning_effort` line in `~/.codex/config.toml`. That also mounts the host's MCP servers and hooks into the Linux sandbox, where a Windows-only command makes the run refuse to start.
- Claude gets no effort at all. The adapter never sends `--effort` (`agents/claude.ts:287-306`). The bind-mounted host `~/.claude/settings.json` `effortLevel` applies by accident, and `--print-config` does not show it.

**Nothing records what ran.** `run.started` records the agent (`run-log.ts:38-55`), not the model or effort, so a supervisor cannot tell whether the model it asked for is the one that ran, or whether the Ralph it launched is too old to understand the request.

## Solution

- **Two flags for the selected agent:** `--model <name>` and `--effort <level>`.
- **Per-agent env vars:** `RALPH_CLAUDE_MODEL`, `RALPH_CLAUDE_EFFORT`, `RALPH_CODEX_MODEL`, `RALPH_CODEX_EFFORT`. Both agents can be configured at once, and each run uses its own agent's pair.
- **A generic effort var** beside the existing generic model var: `RALPH_EFFORT`.
- **Precedence, per field:** flag → `RALPH_<AGENT>_X` → `RALPH_X` → default.
- **Model and effort resolve independently.** Isolated Codex keeps `high` whenever no effort is given, whatever the model.
- **Effort levels are allowlisted per agent** and checked once per run, inside `runLoop`, after `run.started` is on disk. A bad value ends the run with `run.ended error` naming the source and the allowed levels.
- **Claude gets `--effort <e>`** in its argv; Codex keeps its `-c model_reasoning_effort="<e>"`.
- **`run.started` records the resolved model and effort** with their sources, and `--print-config` shows both for both agents.

## User Stories

1. As a Ralph user, I want to pass `--model` and `--effort` on the command line, so that a one-off run needs no environment edits.
2. As a Ralph user who switches between Claude and Codex, I want to set each agent's model and effort once, so that switching agents never sends one agent the other's model.
3. As a Ralph user, I want to raise Codex effort without `--codex-user-config`, so that I keep the isolated sandbox config and still get `xhigh` or `max`.
4. As a Ralph user, I want to set Claude's effort for the sandbox, so that the sandbox runs at the level I chose rather than whatever the CLI defaults to.
5. As a Ralph user, I want a Codex model override to keep Ralph's `high` default effort, so that naming a model does not silently lower the effort.
6. As a Ralph user, I want a mistyped effort to stop the run at once with the allowed levels, so that I do not find out after a failed stage.
7. As a supervisor that launches Ralph in a window it cannot read, I want a bad model/effort setting to be recorded in the run log, so that I can report it instead of "no run registered".
8. As a supervisor, I want the run log to record the model and effort Ralph resolved, and where each came from, so that I can confirm my request reached the run and detect an older Ralph that ignored it.
9. As a Ralph user, I want `--print-config` to show the model and effort for either agent, with their sources, so that I can check a setup before a long run.
10. As a Ralph user, I want `--detach` to keep my `--model` and `--effort`, so that a background run uses the same settings.

## Implementation Decisions

- **Flags.**
  - `parseFlags` (`cli-help.ts:46-120`) gains `--model <name>` and `--effort <level>`, parsed like `--agent`: the next token is the value, a token starting with `-` or a missing value is an error (`--model requires a value`, `--effort requires a value`).
  - `CliFlags` gains `model?: string` and `effort?: string`. `parseFlags` does not check the effort level, because the allowed levels depend on the agent, which may still come from `RALPH_AGENT`.
  - `--detach` needs no change: `stripDetachFlags` (`detach.ts:37-49`) removes only `--detach` and `--log <path>`, so the child re-parses both flags.
- **Env vars.**

  | Variable              | Applies to  | Values                                                          |
  | --------------------- | ----------- | --------------------------------------------------------------- |
  | `RALPH_CLAUDE_MODEL`  | Claude runs | any non-empty model name                                        |
  | `RALPH_CLAUDE_EFFORT` | Claude runs | `low\|medium\|high\|xhigh\|max`                                 |
  | `RALPH_CODEX_MODEL`   | Codex runs  | any non-empty model name                                        |
  | `RALPH_CODEX_EFFORT`  | Codex runs  | `none\|minimal\|low\|medium\|high\|xhigh\|max`                  |
  | `RALPH_MODEL`         | either      | any non-empty model name (unchanged)                            |
  | `RALPH_EFFORT`        | either      | `low\|medium\|high\|xhigh\|max` (the levels both agents accept) |

  Values are trimmed; blank counts as unset, as `RALPH_MODEL` does today.

- **Precedence.** For each of model and effort, the first set source wins: the flag, then `RALPH_<AGENT>_X`, then `RALPH_X`, then the default below. The flag always applies to the selected agent.
- **Defaults (model and effort resolve independently).**

  | Agent  | Model default                                                                                                                  | Effort default                                                                                           |
  | ------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
  | Claude | unchanged: host `settings.json` (`env.ANTHROPIC_MODEL`, else `model`) → `DEFAULT_CLAUDE_MODEL`; none under third-party routing | none: no `--effort` is sent, so the host settings' `effortLevel` or the CLI default applies              |
  | Codex  | isolated: `DEFAULT_CODEX_MODEL`; `--codex-user-config`: none (the file owns it)                                                | isolated: `DEFAULT_CODEX_REASONING_EFFORT` (`high`), **whatever the model**; `--codex-user-config`: none |

  The Codex effort row is a behavior change. Today an explicit model drops `high` (`codex.ts:262-268`); the design doc that introduced that coupling (`docs/superpowers/specs/2026-07-16-codex-provider-design.md:245-247`) gives no reason for it. The test `uses an explicit model without adding the Ralph effort default` (`agents.test.ts:423`) is rewritten to expect `high`. An explicit effort with `--codex-user-config` is sent as `-c` too.

- **Allowlists live on the adapter.**
  - `AgentAdapter` gains `readonly effortLevels: readonly string[]`.
  - Claude: `["low", "medium", "high", "xhigh", "max"]`, from `claude --help` on 2.1.278 and on the sandbox image's 2.1.269. `ultracode` is left out on purpose: it turns on workflow orchestration, which an unattended stage should not start.
  - Codex: `["none", "minimal", "low", "medium", "high", "xhigh", "max"]`, from the Codex 0.154 binary's effort enum.
  - The generic `RALPH_EFFORT` is checked against the levels both adapters accept, whichever agent runs, so a value that works today keeps working after an agent switch. For `none` or `minimal` the error says to use `RALPH_CODEX_EFFORT`.
  - Because the level is allowlisted, it is safe inside Codex's TOML string (`model_reasoning_effort="<e>"`).
  - A model is only checked for being non-empty. The agent CLI owns model errors (a 400 on an unknown model), as today.
- **One resolver.** `agents/index.ts` gains:

  ```ts
  export type TuningValue = { value: string; source: string };
  export type AgentTuning = { model?: TuningValue; effort?: TuningValue };

  /** Flag, then RALPH_<AGENT>_X, then RALPH_X. Pure: no defaults, no validation. */
  export function resolveAgentTuning(
    agent: AgentName,
    explicit: { model?: string; effort?: string },
    env: NodeJS.ProcessEnv
  ): AgentTuning;

  /** undefined when valid, else one message naming the source and the allowed levels. */
  export function validateAgentTuning(
    agent: AgentName,
    tuning: AgentTuning
  ): string | undefined;
  ```

  `source` is the literal the user typed: `--model`, `--effort`, `RALPH_CODEX_MODEL`, `RALPH_EFFORT`, and so on. Defaults stay in the adapters (`resolveClaudeModel`, `resolveCodexModel`), which already name them (`Ralph default`, `host settings`, `user config`).

- **Threading.**
  - `runBin` passes `flags.model` and `flags.effort` to `runLoop` as `LoopOptions.model` / `LoopOptions.effort`. It does not read the env vars.
  - `runLoop` calls `resolveAgentTuning(agent, { model, effort }, process.env)` once, before `openRunLog`, and passes the result to every `runStage` as `RunStageOptions.tuning`. Library callers that omit `model`/`effort` get the env vars the same way.
  - `runStage` uses `options.tuning` when given, and otherwise resolves from `process.env` itself, so a direct `runStage` caller that relied on `RALPH_MODEL` keeps working. `runner.ts:747`'s `rawModel: process.env.RALPH_MODEL` becomes `rawModel: tuning.model?.value` and a new `rawEffort: tuning.effort?.value`.
  - `AgentCommandContext` (`agents/types.ts:18-27`) gains `rawEffort: string | undefined`.
  - Nothing in `src/` writes `process.env`, so resolving once per run is equivalent to today's per-attempt read.
- **Validation runs in `runLoop`, after `run.started`.**
  - The first statement of the `try` block (`loop.ts:391`) calls `validateAgentTuning` and throws `new Error(message)` on a problem. The existing `catch` writes `run.ended` with `reason: "error"` and the message, and rethrows, so the bin exits 1. No new `await` is added.
  - Why here and not in `runBin`: a caller that launches Ralph in a window of its own (the slice-cycle plugin) cannot read Ralph's stderr after the window closes. An error before `run.started` leaves it only "no run registered". After `run.started`, the reason is in the log.
  - The claim check runs first, so a live run in the workspace still refuses the launch before a bad setting is reported.
  - `--print-config` does not validate. It shows the value followed by `(invalid: allowed low|medium|…)`.
- **Argv.**
  - Claude: `buildClaudeCommand` (`claude.ts:287-306`) takes an `effortArgs` list beside `modelArgs` and pushes `...modelArgs, ...effortArgs, promptInstruction`. The variadic `--add-dir` stays first (`:296-299`). `--effort <e>` is sent only when an effort is set, including under third-party routing, since effort is a CLI setting.
  - Codex: `resolveCodexModel(rawModel, rawEffort, codexUserConfig)` returns the effort by the defaults table; `buildCodexArgs` keeps its push at `codex.ts:353-355`.
- **Visibility.**
  - `RunStarted` (`run-log.ts:38-55`) gains optional `model?`, `modelSource?`, `effort?`, `effortSource?`. They are not in `REQUIRED` (`:208-218`), so this is additive within v1 and older readers skip them.
  - The values are the ones the adapters will send: `model` is the `--model` value, absent when none is sent (Claude under third-party routing, Codex with the user config), and `modelSource` still names what decides (`host provider config`, `user config`). The same holds for effort. For Claude with no effort, `effortSource` is `Claude CLI default`.
  - `describeAgentConfig` (`cli-help.ts:206-247`) and `runLoop` share one helper that returns these four fields, so the log and `--print-config` cannot disagree.
  - `--print-config` prints the `reasoning` line for Claude too. With no effort it reads `Claude CLI default (host settings effortLevel applies)`.
  - `printHelp` (`cli-help.ts:147-204`) lists the two flags and five env vars. The `RALPH_MODEL` paragraph is shortened to point at the precedence.
- **Documented caveat, to verify at implementation.** With `--codex-user-config`, a profile selected in `~/.codex/config.toml` may carry its own `model_reasoning_effort`, and older codex-rs let a profile outrank a top-level `-c` override. This must be checked on Codex 0.154 before the docs claim `--effort` always wins over the file. This host's config has no profiles.

## Testing Decisions

- **What makes a good test here.** The resolver, the validator and the argv builders are pure; tests pass literal flags, env objects and contexts and compare exact argv arrays, like the existing `builds isolated default args` (`agents.test.ts:448`). The loop is tested through its existing harness by reading the run log back through `reduceRunLog`. No test sets `process.env` without restoring it in `afterEach`.
- **`agents.test.ts`.**
  - `resolveAgentTuning`: the precedence matrix for both agents (flag over per-agent over generic; the other agent's variables ignored; blank counts as unset).
  - `validateAgentTuning`: each adapter's levels; `ultracode` rejected for Claude; `none` in `RALPH_EFFORT` rejected with the `RALPH_CODEX_EFFORT` hint, accepted in `RALPH_CODEX_EFFORT`; the message names the source. (The "empty model rejected" case is withdrawn — `resolveAgentTuning` trims and drops blanks, so it is unreachable without hand-constructing an `AgentTuning`. See the plan's slice-scope addendum §F.)
  - Claude argv: `--effort` right before the prompt, after `--model`; absent when unset; present under third-party routing with no `--model`; `--add-dir` still first.
  - Codex: an explicit model keeps `high` (the rewritten `:423` case); an explicit effort replaces it; `--codex-user-config` with an explicit effort sends `-c` and no model.
- **`cli-help.test.ts`.** `--model`/`--effort` parse, reject a missing value and a `-`-prefixed value; help text lists both flags and the five variables; `describeAgentConfig` prints sources and the Claude `reasoning` line; an invalid effort is shown with `(invalid: …)`.
- **`loop.test.ts`.** An invalid effort writes `[run.started, run.ended {reason: "error", error}]`, starts no image and rejects. `runStage` receives the resolved `tuning` in every stage. `run.started` carries `model`/`effort` and their sources. The microtask-turn counts are unchanged.
- **`run-bin.test.ts`.** The flags reach `runLoop` as `model`/`effort`.
- **`detach.test.ts`.** `--model x --effort high` survive `stripDetachFlags`.
- **`run-log.test.ts`.** A `run.started` with the optional fields folds; one without them still folds.

## Out of Scope

- **Recording model/effort per stage** (`StageMeta`, the history `.md` header). The Claude decoder's `init` line already shows the model the CLI chose.
- **A Ralph default effort for Claude.**
- **Checking model names** against a list.
- **Unknown flags.** `parseFlags` puts an unrecognised token in `rest`, and `ralph-ghafk` reads only `rest[0]`, so an older Ralph silently ignores `--model`/`--effort`. This is an existing gap; `run.started`'s new fields are how a caller detects it.
- **The slice-cycle plugin's side.** It ships in its own repo after this release: `ralph launch --model/--effort`, loop settings for the cycle sessions, and REVIEW's `codex exec`. See that repo's `docs/2026-09-20-model-effort-prd.md`.

## Further Notes

**Probes (Windows 11 host, 2026-09-20).**

- `claude --help` on the host (2.1.278) and inside `docker.io/daonhan/ralph-sandbox:latest` (2.1.269): `--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)`. The image's baked CLI accepts the flag, so `RALPH_CLAUDE_UPDATE=0` does not break it.
- Claude Code's documented precedence: `--effort` > `CLAUDE_CODE_EFFORT_LEVEL` > settings `effortLevel` / `modelSettings` > the model's default. An unsupported level falls back to the highest supported one below it.
- `codex exec --help` (0.154): no effort flag; `-c key=value` overrides a config value, and a value that fails to parse as TOML is used as a literal string. The binary's effort enum reads `none, minimal, low, medium, high, xhigh, max`.
- Host `~/.codex/config.toml` pins `model = "gpt-5.6-sol"` and `model_reasoning_effort = "high"` at top level, with no profiles and no `shell_environment_policy`.

**Owner decisions** (2026-09-20):

1. Per-agent env vars plus a generic fallback, and flags for the selected agent.
2. Per-agent allowlists, checked before any stage runs.
3. Isolated Codex keeps `high` when only a model is given.
4. The plugin covers BUILD, the cycle sessions and REVIEW (its own PRD).
5. PRD and plan first; the owner decides when to implement.

**Picked up for implementation 2026-09-20.** Two further plan-adversary passes ran against this committed pair; their findings, the corrections to the plan's work lists and acceptance criteria, and the sandbox line-ending prerequisite are in the plan's **Slice-scope addendum**. Where the addendum and this PRD disagree, the addendum wins.

**Plan-adversary review (fix-first), folded in.**

- An explicit Codex model dropped `high` silently → decision 3.
- A generic `RALPH_EFFORT` valid for one agent broke the other after a switch → checked against the shared levels.
- Validation before `run.started` is invisible to a supervisor whose Ralph window closes → validation inside `runLoop`.
- An older Ralph ignores the request silently → `run.started` records what was resolved.
- A Codex profile may outrank `-c` → documented caveat, verified at implementation.
