# Plan: Model and effort for every Ralph attempt

> Slice ID: `attempt-model-effort` · Slice 171 ([issue #171](https://github.com/daonhan/ralph/issues/171)).
> Execution: installed slice-cycle worker 0.8.0, contract v1, app mode; Ralph owns BUILD and product repairs. User approved the design and execution with `go`. Stop at a verified PR ready for review; no merge authority.

**Goal:** Show truthful model/effort configuration for every implementer/reviewer attempt, including retries.

**Spec:** [PRD](../prd/attempt-model-effort.md).

**Architecture:** Preserve run-level tuning resolution. Introduce the smallest synchronous per-attempt provider resolution snapshot so display and provider command construction share the same requested model/effort. Keep provider differences in `agents/`; the loop stays provider-neutral. Reuse current resolution and description helpers where practical without relocating unrelated behavior.

## Baseline and independent review

Base: `ff73294b0b63f2acb871716f46f7aa41c2a77e17`, verified clean `main` / `origin/main` on 2026-09-22. Both bins share `runLoop`. `loop.ts` prints a stage banner, exits early for skipped stages, and increments attempts inside `withRetries` before template rendering. `runner.ts` calls the adapter after asynchronous volume preparation. `agents/claude.ts` currently rereads host settings in `buildCommand`; `cli-help.ts:describeAgentConfig` already describes sources but cannot independently be called for the banner without risking stale data. Existing installed Ralph is CLI 0.7.3 / core 0.18.1.

Prior independent read-only adversary `/root/review_attempt_display_plan` returned GO provided display and launch share per-attempt resolution. Re-probed against source: startup descriptions are insufficient; settings can change by command construction. Its requested regression and direct-call compatibility are included below. No critical finding remains unresolved by this plan.

## One vertical task: attempt configuration display

Files likely affected: `packages/core/src/loop.ts`, `runner.ts`, provider types/adapters and a focused configuration helper if required; existing `cli-help.ts` description logic only as necessary; relevant Vitest suites under `src/__tests__`; README and architecture guidance. No CLI package build changes.

- [ ] Add failing behavior tests that exercise the existing loop retry callback and actual provider command arguments. Assert one line per attempt on stderr, 1-based numbering reset per stage, both implementer/reviewer, and no config line for skipped stages.
- [ ] Pin template-render failure semantics: resolve/print inside the retry closure before rendering, so failed renders still get numbered configuration; subsequent retry prints its own line and eventual argv matches that attempt.
- [ ] Add the crucial regression: first attempt uses one Claude host model, host settings change between attempts, second uses another; each display and argv agree. Also simulate a settings change after snapshot and before command construction (volume preparation awaits) to prevent a hidden second read.
- [ ] Introduce only the synchronous snapshot needed to feed both formatting and provider argv. Carry it through `RunStageOptions`/`AgentCommandContext` as an optional internal addition where appropriate; direct calls without it preserve resolution behavior. Do not add provider-name branches to the loop or extra pre-run awaits.
- [ ] Format one compact stderr line with sources and truthful configured/provider-managed language. Sanitize displayed CR/LF/terminal control characters without mutating the underlying argv value. Use the existing color policy or plain text for all output.
- [ ] Cover Codex isolated defaults, explicit model/effort, each source precedence, inherited config with neither/one/both fields explicit; Claude host model, default model, third-party routing and provider-managed effort. Preserve current warnings and `--print-config`/`run.started` semantics.
- [ ] Delegate a product-docs pass within Ralph and update README/architecture together with behavior; mirror AGENTS/CLAUDE only if their interface guidance needs changes. Explain configured values versus backend execution and fresh-per-attempt resolution.
- [ ] Run focused failing tests to prove red, then passing tests and the complete verification gate. Make one conventional product commit following repository author rules. Report issue/commit and handover evidence.

## Review focus and validation

Exercise the load-bearing boundaries, not just the formatter: direct adapter/runStage calls without a snapshot, optional fields that intentionally omit argv switches, settings changes across retries and during async preparation, failed rendering and skipped stages, no-color output under redirection/NO_COLOR/TERM=dumb, and terminal-control characters. Keep the existing failure, signal, sentinel, log-order and microtask-count tests green. No Docker/API live provider call is needed to prove this display-only feature; mocked runner tests must inspect real assembled command arguments.

Required full gate: `pnpm -r typecheck`, `pnpm -r test`, `pnpm test`. Record command exit codes, logs and exact head SHA. Independent code and security reviewers inspect the full base-to-head diff and all commits; route actionable changes through at most two marked Ralph repair rounds and rerun affected gates.

## Verified BUILD constraints

- Node 22.22.2, git 2.55, authenticated gh, Docker, installed Ralph available in the Windows host environment. Root image exists: `docker.io/daonhan/ralph-sandbox:latest`, linux/amd64. Isolated Codex resolves default Sol/high and keeps updates enabled. Do not import host user config.
- No open issues/PRs at initial preflight; re-fetch all open issues with pagination before every launch and require exact ready-wave ownership. Installed template ingestion is limited to 50 open issues, so verify the slice's ready issue is visible. Issue numbers determine budget, not filtering.
- One ready issue means two iterations (ready issues plus one spare). Use the descriptor-returned companion's `ralph status`, `limits check`, `ralph codex-check` and `ralph launch --repo D:\Workspaces\ralph --issues <issue> --agent codex`. Wait/reconcile any active or unknown run; never double launch.
- Use an ignored, atomically written `.ralph-tmp/codex-worker/attempt-model-effort/checkpoint.json`. Numeric slice identity follows this repository's `slice-<issue-number>` convention and must be recorded with the published issue before BUILD; branch `codex/slice-<issue-number>-attempt-model-effort`.
- No direct product/test/dependency edits by the worker or its subagents. Planning artifacts and review evidence are worker-owned. No merge, outer supervisor or new user-visible task.

## Issue and rollback

Publish one `ready-for-agent` issue with marker `slice-cycle:id=attempt-model-effort`, linking these artifacts and all eight PRD acceptance criteria. Search the marker first to avoid duplicates. Commit planning artifacts before BUILD; no push or PR until implementation and local review gates pass.

Revert product commits to restore the old display; the slice changes no persisted format, migrations, defaults or provider authentication. Runtime checkpoint and logs remain ignored.
