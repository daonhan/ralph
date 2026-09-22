# PRD: Model and effort for every Ralph attempt

> Slice ID: `attempt-model-effort` · 2026-09-22 · Slice 171 ([issue #171](https://github.com/daonhan/ralph/issues/171)).

Ralph operators need to see the model and effort requested for each implementer and reviewer attempt, including retries, without separately invoking `--print-config` or inferring settings from provider output.

## Behavior and acceptance

1. Before each attempted stage, print one compact line to stderr with its 1-based attempt number, agent, configured model and configured effort, including their source. Preserve the existing iteration/stage banner. Example:

   ```text
   == iteration 2/5 · reviewer (stage 2/2) ==
   attempt 1 · codex · configured model=gpt-5.6-sol (Ralph default) · effort=high (Ralph default)
   ```

2. Repeat the line for retries; numbering resets for each stage. Include attempts whose template rendering fails, since they consume the same retry budget. Skipped stages retain their existing skip message and print no configuration line.
3. Resolve provider configuration once per attempt and use that same snapshot for display and command arguments. Claude settings may change between attempts; the next attempt must observe the change without display/argv disagreement within either attempt. Retain existing run-level flag/environment resolution.
4. Say `configured`: requested aliases and provider-managed settings do not prove the backend's actual execution model or reasoning. Use honest `provider-managed` labels when Ralph omits a setting (Claude effort, Claude third-party routing, inherited Codex config). Do not invent inherited values or parse Codex TOML to guess them.
5. Preserve precedence, defaults, provider behavior and independent model/effort selection. Explicit values retain accurate flag/environment sources. Preserve direct `runStage` and adapter command callers that do not supply a snapshot.
6. Output is readable in terminals, redirected stderr and detached logs; no ANSI escapes when redirected, `NO_COLOR` or `TERM=dumb`. Keep control characters in configuration values from producing extra terminal lines or escape sequences, while leaving the actual command value untouched.
7. Preserve the standalone sentinel, stage-skip behavior, retries, run event schema and fsync ordering, history, provider decoders, credential/mount behavior and public CLI flags. No extra asynchronous work before the first `runStage`.
8. README documents the line and configured/provider-managed semantics; architecture docs explain snapshot ownership and retry timing. Delegate the product documentation pass per repository instructions; synchronize AGENTS/CLAUDE if guidance changes.

## Non-goals

No new flag, provider discovery, model validation/fallback, live backend verification, per-provider model switching, new run events/history fields, dependency, release/version bump or unrelated refactor.

## Delivery and rollback

One independently shippable issue and PR. Existing tuning and output APIs are the baseline, including completed issues #161/#162/#166. BUILD and all product repairs use Codex in `ralph-ghafk` via the slice-cycle 0.8.0 companion. Run `pnpm -r typecheck`, `pnpm -r test`, and `pnpm test`; review exact-head source and security independently. Roll back by reverting this slice's product commit(s); no migration or persisted schema change is needed.
