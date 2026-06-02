# PRD: `RALPH_MODEL` env knob to pin the sandbox Claude model

> Tracking: [daonhan/ralph#35](https://github.com/daonhan/ralph/issues/35) (PRD). Target release: `@daonhan/ralph-core` 0.7.0 (new env knob → `feat(core)` minor bump).

## Problem Statement

When I run `ralph-afk` / `ralph-ghafk`, the Claude model used inside the sandbox is
whatever the bundled Claude Code CLI in the `ralph-sandbox` image happens to default
to at image build time. The Dockerfile installs the CLI unpinned
(`packages/core/templates/Dockerfile`: `curl -fsSL https://claude.ai/install.sh | bash`),
so the in-container default model is frozen to the moment the image was built — and
drifts away from the model my host CLI uses as the image ages.

Concretely: an end-to-end run logged `init model=claude-opus-4-7[1m]` inside the
sandbox while my host Claude Code was already on Opus 4.8. The runner spawns
`claude --verbose --print --output-format stream-json --permission-mode <mode>`
(`packages/core/src/runner.ts` `runStage`) with **no `--model` flag and no model env
var**, so I have no way to control which model each stage uses short of rebuilding the
image (non-deterministic — depends on what `install.sh` fetches) or editing
`~/.claude/settings.json` (leaks into my host Claude Code default, since that file is
bind-mounted into the container).

I want a deterministic, isolated way to pin the model the sandbox uses, per run,
without rebuilding the image and without mutating shared host config.

## Solution

Add a `RALPH_MODEL` environment variable. When set to a non-empty value, the loop
passes `--model <value>` to the `claude` invocation inside the sandbox for every
stage. When unset (or empty/whitespace), behavior is unchanged — the in-container CLI
keeps its own default, so nothing breaks for existing users.

The resolved model is surfaced in `--print-config` (so I can confirm what a run will
use before launching docker) and documented in `--help` alongside the other `RALPH_*`
knobs. The value is passed through verbatim to the CLI, so any spec the `claude` CLI
accepts (`opus`, `sonnet`, a full model id like `claude-opus-4-8`, an alias, etc.)
works — validation is the CLI's job, not ours.

From the user's perspective: I export `RALPH_MODEL`, run the loop, and every stage
uses that model; the `init model=…` line in the stream reflects my choice.

## User Stories

1. As a ralph operator, I want to set `RALPH_MODEL=claude-opus-4-8` and have every sandbox stage use that model, so that the loop matches the model I expect rather than a stale image default.
2. As a ralph operator, I want `RALPH_MODEL` to apply to both the implementer and reviewer stages in a single run, so that my whole loop is consistent.
3. As a ralph operator, I want `RALPH_MODEL` to apply to both `ralph-afk` and `ralph-ghafk`, so that the knob behaves identically across both bins.
4. As a ralph operator, I want the model knob to work without rebuilding the sandbox image, so that I can change models on the next run with zero build latency.
5. As a ralph operator, I want pinning the model to NOT change my host Claude Code default model, so that the sandbox config is isolated from my interactive sessions.
6. As a ralph operator, I want `ralph-afk --print-config` to show the model the run will use (the `RALPH_MODEL` value, or an explicit "sandbox CLI default" when unset), so that I can verify the setting before burning tokens.
7. As a ralph operator, I want `ralph-afk --help` to document `RALPH_MODEL` in the environment-variable section, so that the knob is discoverable without reading source.
8. As a ralph operator, I want leaving `RALPH_MODEL` unset to preserve today's behavior exactly (no `--model` flag), so that upgrading is a no-op for anyone who doesn't want it.
9. As a ralph operator, I want an empty or whitespace-only `RALPH_MODEL` to be treated as unset, so that an exported-but-blank variable in my shell doesn't pass a broken `--model ""` to the CLI.
10. As a ralph operator, I want the value passed through verbatim, so that I can use short aliases (`opus`) or full model ids without ralph second-guessing me.
11. As a ralph maintainer, I want the model-resolution logic extracted into a small pure function, so that it is unit-testable in isolation without spawning docker.
12. As a ralph maintainer, I want the new function to follow the existing `parseGraceMs` / `resolveDockerSocketMount` pattern, so that it matches the codebase's established shape for env-driven argv helpers.
13. As a ralph maintainer, I want `RALPH_MODEL` documented in CLAUDE.md and the README env table, so that the knob is captured in the same places as the other `RALPH_*` knobs.
14. As a ralph operator on Windows/macOS/Linux, I want the knob to behave identically across platforms, so that there is no OS-specific surprise (it only affects argv, not mounts).

## Implementation Decisions

- **New deep module — `resolveModelArgs(raw: string | undefined): string[]` in `runner.ts`.** Pure function. Trims the input; returns `["--model", trimmed]` for a non-empty value, or `[]` for unset/empty/whitespace. No side effects, no `process.env` read inside (the caller passes `process.env.RALPH_MODEL`), mirroring how `parseGraceMs` takes its raw string as an argument. Trivially unit-testable.
- **`runStage` (runner.ts) wiring.** After the base `claude --verbose --print --output-format stream-json` args are pushed (around the existing `--permission-mode` push), splice in `...resolveModelArgs(process.env.RALPH_MODEL)`. Flag ordering among `claude` options is irrelevant; the positional prompt string stays last.
- **`printConfig` (cli-help.ts).** Add one line to the resolved-config block: the `RALPH_MODEL` value when set, or `sandbox CLI default` when not. Reads `process.env.RALPH_MODEL` the same way the existing socket/image lines read their env.
- **`printHelp` (cli-help.ts).** Add a `RALPH_MODEL` entry to the "Environment variables" block describing the pass-through `--model` behavior and the unset default.
- **Docs.** Add `RALPH_MODEL` to the env-knobs list in `CLAUDE.md` (the "Other env knobs" line) and the README "Running AFK" env table, matching the surrounding entries.
- **Pass-through, no validation.** ralph does not validate the model string; whatever is provided is handed to the `claude` CLI, which already errors on an unknown model. Keeps ralph decoupled from the CLI's evolving model catalog.
- **No new CLI flag.** Scope is the env var only; a `--model` bin flag is explicitly not added (keeps the change to env-driven config, consistent with the other `RALPH_*` knobs and the flat bin layer).
- **Applies uniformly to all stages.** Both stages in a chain (implementer / ghafkImplementer + reviewer) read the same env var; there is no per-stage override.

## Testing Decisions

- **What makes a good test here:** assert only external behavior of the pure function — given an input string (or undefined), it returns the correct argv fragment. No mocking of docker, no spawning, no inspection of internal state.
- **Module under test:** `resolveModelArgs`. Cases: `undefined` → `[]`; `""` → `[]`; whitespace-only → `[]`; `"opus"` → `["--model", "opus"]`; full id `"claude-opus-4-8"` → `["--model", "claude-opus-4-8"]`; surrounding whitespace trimmed (`"  opus  "` → `["--model", "opus"]`).
- **Prior art:** the existing `parseGraceMs` suite in `packages/core/src/__tests__/runner.test.ts` — same file, same vitest style (`describe` / `it` / `expect`), same "pure string-parser fed raw input, assert return value" shape. The new suite sits alongside it.
- **Out of unit-test scope (by repo convention):** `runStage`'s argv splicing and the docker spawn are shallow glue, validated by the existing manual smoke flow (a real 1-iteration run confirming the `init model=…` line reflects `RALPH_MODEL`), not by unit tests. `printConfig` / `printHelp` output is verified by eye via `--print-config` / `--help`.

## Out of Scope

- A `--model` bin flag (env var only for now).
- Per-stage model overrides (e.g. a cheaper reviewer model). One knob applies to all stages.
- Validating the model string against a known catalog, or mapping friendly names.
- Rebuilding or re-pinning the CLI version inside the sandbox image (a separate concern; this PRD deliberately avoids touching the Dockerfile).
- Passing other `claude` knobs (temperature, max tokens, fallback model, etc.).
- Any change to host Claude Code config or `~/.claude/settings.json`.

## Further Notes

- Root cause reference: the Dockerfile installs the CLI unpinned, so the in-container default model is frozen at image build time; the host CLI auto-updates and drifts ahead. `RALPH_MODEL` is the per-run override that decouples the run's model from the image's frozen default.
- The `claude` CLI accepts `--model`; ordering relative to `--print` / `--permission-mode` does not matter.

## Release

- Target version: **`@daonhan/ralph-core` 0.7.0** (minor bump from 0.6.1 — adds a new env knob).
- Mechanism: lands as a `feat(core): …` conventional commit; release-please picks it up and opens the release PR automatically (no manual `package.json` / `.release-please-manifest.json` edits required).
- `@daonhan/ralph` (CLI) is **not** bumped by this change — the CLI only re-exports `runAfk` from core. If a sibling commit in the same release cycle touches the CLI bins, release-please bumps the CLI separately.
- Sandbox image (`packages/core/templates`) is unaffected; no `ralph-sandbox-v*` tag.
