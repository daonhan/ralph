# PRD: Codex Ultra effort in Ralph

> Slice ID: `codex-ultra-effort` · written 2026-09-22.
> Plan: [codex-ultra-effort.md](../plans/codex-ultra-effort.md).
> Scope confirmed by the owner: **Ultra support + compatibility docs**, preserving the existing defaults and the shared implementer/reviewer settings.

## Problem statement

Ralph can already select arbitrary Codex model IDs and reasoning effort, but its effort allowlist stops at `max`. A user who requests `--agent codex --effort ultra` receives an invalid-effort error before any stage starts, even when their Codex installation and selected model support Ultra. Loading the entire host configuration is currently the only indirect way to request it.

The documentation also lists provider-wide effort values without explaining that individual models support different subsets. Accepting a value in Ralph is not evidence that an account, model, or installed Codex client can run it.

## Implemented baseline and evidence

Baseline: `4e90253992cab3126cc8f7569243a420b2ce6cac`, core `0.17.0`, CLI `0.7.1`.

- Both bins support `--agent`, `--model`, `--effort`, and `--print-config` already. Issues #161 and #162 are closed; this slice must not rebuild that feature.
- Per field, flags outrank provider-specific environment variables, then generic variables. Model and effort resolve independently.
- Isolated Codex uses `gpt-5.6-sol` / `high`; an explicit model alone retains `high`.
- Codex receives effort as `-c model_reasoning_effort="<value>"`. With `--codex-user-config`, untuned fields remain delegated to Codex configuration.
- The loop captures tuning once and sends it to every stage. `run.started` records the requested model/effort and their sources through the same description helper as `--print-config`.
- The shipped sandbox pins Codex `0.154.0` and normally updates it before each stage. Custom images and `RALPH_CODEX_UPDATE=0` can leave older clients in use.

Read-only investigation on 2026-09-22 used local `codex-cli 0.154.0` and `codex debug models --bundled`. Its bundled model catalog reports:

| Model ID        | Advertised effort values                         |
| --------------- | ------------------------------------------------ |
| `gpt-6-astra`   | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-sol`   | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna`  | `low`, `medium`, `high`, `xhigh`, `max`          |

This is a dated client-catalog snapshot, not account entitlement or a permanent model registry. The OpenAI [models page](https://learn.chatgpt.com/docs/models) describes Ultra as maximum reasoning with automatic delegation, and the [subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents#reasoning-effort-model_reasoning_effort) explicitly lists `ultra` under `model_reasoning_effort`. These support using the existing Codex configuration path. The same subagent guide distinguishes local clients: current local Codex releases delegate after a direct request or applicable project/skill instruction. Preserve that CLI-specific qualification in the product docs; selecting the configuration value does not prove proactive delegation. Ralph must not synthesize its own orchestration or promise that every task will spawn subagents. No live model invocation was performed while planning.

## Solution

Extend Ralph's Codex effort choices with `ultra`. Forward that exact value through the existing configuration argument, display it with its source, and persist it in the existing run event fields. Explain the model-dependent nature of effort and the meaning of Ultra in help and product documentation.

## User stories

1. As a Codex user, I can request `--effort ultra` for one Ralph run without importing my host configuration.
2. As an automation author, I can set `RALPH_CODEX_EFFORT=ultra`, while a flag still overrides it and Claude runs ignore it.
3. As an operator, I can inspect the requested Ultra setting and its source in `--print-config` and `run.started`.
4. As a user switching providers, I receive a clear error for generic `RALPH_EFFORT=ultra`, with a hint to use `RALPH_CODEX_EFFORT`.
5. As a user choosing a model, I understand which combinations the checked client advertised and that Codex owns current compatibility and access errors.
6. As an existing user, I retain the same defaults, inherited-config behavior, stage settings, and failure semantics unless I explicitly select Ultra.

## Requirements and acceptance criteria

| ID  | Observable requirement                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Both bins accept `--agent codex --effort ultra`; library callers supplying the equivalent tuning are accepted too.                                                                                                                                                                                                                              |
| U2  | `RALPH_CODEX_EFFORT=ultra` resolves with that source. An explicit effort wins; whitespace is trimmed; blank values fall through as before.                                                                                                                                                                                                      |
| U3  | Claude rejects explicit `ultra`; both providers reject a winning `RALPH_EFFORT=ultra`. The generic error names the Codex-specific variable. The shared effort set remains `low`, `medium`, `high`, `xhigh`, `max`.                                                                                                                              |
| U4  | Isolated and inherited-config Codex with explicit Ultra receive exactly `-c` and `model_reasoning_effort="ultra"`. Keep `--ignore-user-config` in isolated runs. Do not translate Ultra to `max`, enable unrelated features, or add a prompt requesting delegation.                                                                             |
| U5  | `--print-config` shows `ultra` with `--effort` or `RALPH_CODEX_EFFORT` and no invalid suffix for those valid Codex selections. Invalid generic/Claude selections remain diagnostic output with exit 0.                                                                                                                                          |
| U6  | `run.started` records `effort: "ultra"` and the literal source. A two-stage run receives the same tuning on implementer and reviewer. A bad generic/Claude value follows the existing durable `run.started` then `run.ended error` path before image setup.                                                                                     |
| U7  | Unset tuning still produces Sol/high in isolated mode. In inherited mode, unset fields stay unspecified; explicit Ultra overrides only effort. Arbitrary model IDs still pass through. Ralph performs no model fallback or effort downgrade on a Codex error.                                                                                   |
| U8  | Help and docs explain Ultra, provider versus model support, unchanged defaults, generic-variable rejection, account/client dependencies, and a dated compatibility snapshot. Examples cover one-shot flags and PowerShell environment variables.                                                                                                |
| U9  | A scratch-workspace sandbox smoke using a supported model and isolated configuration completes a single Ultra stage with a final agent message and `turn.completed`. Record the image, actual client version, requested model/effort, command and sanitized result. This proves invocation compatibility, not a guarantee that subagents spawn. |

## Implementation decisions

- Keep provider-wide validation and the existing adapter boundary. Only Codex's declared effort set grows; the computed intersection naturally keeps Ultra out of the generic setting.
- Reuse the current resolver, command builder, config description, and event schema. No new runtime module, asynchronous preflight, model catalog fetch, or log field is needed.
- Keep exact lowercase effort tokens. This slice does not add aliases or case folding.
- Codex remains responsible for model/account/client compatibility. An unsupported pair may pass Ralph validation and then fail in Codex; retain the existing failure and retry policy. Do not claim that `--print-config` validates account access or reads inherited effective values.
- The verified client is 0.154.0, already the image's baked version; this is not a claim about the earliest version supporting Ultra. No image/version bump is part of the slice.
- Ultra may consume more time/tokens and may delegate. It does not change Ralph's outer implementer/reviewer topology, permissions, mounted skills, retry limits, or cleanup ownership.

## Testing decisions

Test observable seams: selected-agent validation, emitted Codex argv, bin-to-loop forwarding, diagnostic output, durable run events, and both stages receiving tuning. Use literal expected values rather than a test that only loops over the adapter's own allowlist. Restore environment variables between tests. Add cases to existing suites; do not create a new framework or a network-dependent unit test.

Required repository gate is `pnpm -r typecheck`, `pnpm -r test`, and `pnpm test`; build and the four existing offline smoke scripts should also match CI. The exploration baseline passed build/typecheck/root tests; core had 380 passes and one CRLF-specific failure in the existing shipped-skill frontmatter assertion on Windows. That failure must be reported distinctly, not silently waived. Obtain a full green gate from a clean LF Linux checkout/CI at the candidate head; do not fold an unrelated test fix into this feature.

## Out of scope

- Changing Ralph's default model or effort.
- Per-stage model/effort settings, model discovery, model-specific runtime validation, or automatic model migration.
- Parsing the host's complete configuration, exposing Codex profiles, or changing credential mounts.
- A Ralph-owned subagent scheduler, new delegation prompts, new mounts, or changes to stream decoding without a separately verified defect.
- Changes to slice-cycle's launcher, budgets, or plugin cache; Claude's `ultracode` remains excluded.
- Implementing this slice in the planning task.

## Dependencies, release and rollback

No dependency changes. The slice requires the existing model/effort implementation and a supported authenticated Codex client for its live smoke. If the smoke is blocked by account or client availability, record a blocker rather than claiming U9 passed. Release the core change through the existing release-please flow using `feat(core)`; do not manually edit versions.

Rollback is a normal revert of the one feature PR. No schema or persistent state migration is involved. Operators must remove an explicit Ultra selection when reverting to a Ralph version that rejects it; existing string-valued run history remains readable.

## Slice-cycle handoff

One independently shippable slice, one implementation issue, one PR. The implementation task uses the installed **slice-cycle 0.8.0 worker, contract v1**, with its own checkpoint and current preflight. The planning task creates local artifacts only. Issue publication, branch execution state and BUILD belong to the separate worker. The plan contains the issue-ready brief and the exact ownership rules; implementation must not select a different next slice.
