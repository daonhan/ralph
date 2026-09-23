# PRD: Opus 5.5 and GPT-6 Sol/Luna defaults

> Slice ID: `opus-5-5-gpt-6-defaults` · 2026-09-23 · Slice 175 ([issue #175](https://github.com/daonhan/ralph/issues/175), [issue #176](https://github.com/daonhan/ralph/issues/176)). Designed and approved by the owner on 2026-09-23.

## Problem

Ralph operators want Claude Opus 5.5 and Codex GPT-6 Sol/Luna. Passing them as arguments already works, because `--model` and `RALPH_*_MODEL` are free-form and verbatim: `parseArgs` in `cli-help.ts` stores any value, `resolveClaudeModel` (`agents/claude.ts`) and `resolveCodexModel` (`agents/codex.ts`) pass it through trimmed, and each adapter emits `--model <id>`. The effort allowlists already fit, too. Opus 5.5 takes `low…max`. The Codex 0.156.1 catalog advertises `low…max` plus `ultra` for `gpt-6-sol`, and `low…max` without `ultra` for `gpt-6-luna`.

Two gaps remain:

1. **The defaults are a generation behind.** `DEFAULT_CLAUDE_MODEL` is `claude-opus-5[1m]` and isolated Codex's `DEFAULT_CODEX_MODEL` is `gpt-5.6-sol`.
2. **The sandbox's baked Codex predates GPT-6 Sol/Luna.** The image pins `@openai/codex@0.154.0` (`packages/core/templates/Dockerfile`). Run inside `docker.io/daonhan/ralph-sandbox:latest`, `codex debug models --bundled` lists `gpt-6-astra` and the `gpt-5.6-*` family but no `gpt-6-sol` or `gpt-6-luna`. The server refuses models the client predates. Today those models work only because each Codex stage runs `codex update` first.

## Outcome

- With no model set, Claude stages send `--model claude-opus-5-5[1m]` and isolated Codex stages send `--model gpt-6-sol`. Isolated Codex keeps `high` reasoning.
- The sandbox image pins `@openai/codex@0.156.1`, the npm `latest` tag on 2026-09-23. Its bundled catalog lists `gpt-6-sol` and `gpt-6-luna`.
- `--model claude-opus-5-5`, `--agent codex --model gpt-6-sol` and `--agent codex --model gpt-6-luna` stay the documented way to choose. Ralph adds no short aliases.

## User stories

1. As an operator who sets no model, `ralph-afk --print-config` shows `claude-opus-5-5[1m] (Ralph default)` when host `~/.claude/settings.json` pins none, and the stage argv carries that value.
2. As a Codex operator who sets no model, `ralph-afk --agent codex --print-config` shows `gpt-6-sol (Ralph default)` and `high (Ralph default)`, and the attempt line reads `attempt 1 · codex · configured model=gpt-6-sol (Ralph default) · effort=high (Ralph default)`.
3. As an operator running `RALPH_CODEX_UPDATE=0` on a freshly built or pulled image, `--agent codex --model gpt-6-luna` reaches a client that knows the model.
4. As an operator whose stage fails because a CLI predates the model, the README troubleshooting section names the exact error and a remedy for each of the three ways a stale CLI runs.
5. As a reader, the README catalog snapshot, defaults table, examples and env table name the new defaults and the new models.

## Implementation decisions

- `packages/core/src/agents/claude.ts`: `DEFAULT_CLAUDE_MODEL = "claude-opus-5-5[1m]"`. The `[1m]` suffix stays (owner decision). Plan-time probe: host Claude Code 2.1.280 accepts both `claude-opus-5-5[1m]` and bare `claude-opus-5-5` (`claude -p` answered, `modelUsage` key `claude-opus-5-5[1m]`). So the owner's fallback to the bare id does not trigger.
- `packages/core/src/agents/codex.ts`: `DEFAULT_CODEX_MODEL = "gpt-6-sol"`. `DEFAULT_CODEX_REASONING_EFFORT` stays `high`.
- `packages/core/src/cli-help.ts`: the two help-text literals name the new defaults.
- Codex pin `0.154.0` → `0.156.1` at every site. That is the five sites of the prior bump (`d33c6d9`): `Dockerfile` `ARG CODEX_VERSION`, `scripts/smoke-image.mjs`'s version check, the `scripts/smoke-image.test.mjs` fixture, and the README and QUICKSTART install lines. Plus a sixth, the regex-escaped assertion `/ARG CODEX_VERSION=0\.154\.0/` in `scripts/smoke-image.test.mjs`, which a plain literal grep does not match.
- Tests: only the assertions that encode a _default_ change: `agents.test.ts` (the `DEFAULT_CLAUDE_MODEL` literal pin and the isolated-Codex default argv), `cli-help.test.ts` (the isolated-Codex describe and the help text) and `loop.test.ts` (the attempt line and `run.started`). Explicit or host-set fixture values stay, because `claude-opus-5[1m]` and `gpt-5.6-sol` remain valid choices. The literal pin in `agents.test.ts` is the gate. Every other default site references the constant, so only that literal catches an accidental edit.
- Commit types reach both release-please components: `feat(core)` for the defaults, `fix(sandbox)` for the pin, or one `feat(core)` phase commit spanning both paths.
- Docs cover current user-facing docs only: README, QUICKSTART and `docs/ARCHITECTURE.md`. `CLAUDE.md` and `AGENTS.md` name the constants only by identifier and need no edit.

## Testing decisions

- Red first. Update the default assertions, watch them fail against the old constants, then change the constants.
- Per-phase suites run by file path. Whole-repo gates are REVIEW's.
- Docker, the image build and live model calls are REVIEW's. The sandbox has no docker CLI.

## Exclusions

- No Ralph-side aliases, no model validation or fallback, no Claude effort change, no Claude Code version floor check in `smoke-image.mjs`. Every image build installs the current Claude Code, so a build-time check would always pass; the exposure is stale caches, which only the docs can address.
- No edits to historical records: `docs/prd`, `docs/plans`, `docs/superpowers`, `docs/reviews` and the CHANGELOGs.

## Dependencies

- `@openai/codex@0.156.1` on npm (`latest` tag, 2026-09-23).
- The release after merge must publish a new `ralph-sandbox` image. The `packages/core/templates` release-please component triggers `publish-image.yml`. `smoke-image.mjs` runs in no workflow, so that release is checked by hand (see Risks).

## Risks

- **A CLI older than the model runs.** Claude Code 2.1.278, baked into today's image, answers `API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required.` for both forms of the id. That text arrived as the assistant message and the `result` through `--output-format stream-json`, the argv shape Ralph uses. `claude-opus-5[1m]` still works there, so for an operator with no model set this is a regression. The stale CLI is hit on three paths:
  1. `claude update` or `codex update` fails, and the stage runs the copy cached in the `ralph-claude-home` or `ralph-codex-cli` volume. Docker seeds a named volume only while it is empty.
  2. `RALPH_CLAUDE_UPDATE=0` or `RALPH_CODEX_UPDATE=0` runs the image's baked CLI from a stale pulled image.
  3. A locally tagged image such as `ralph-sandbox:pg17` is never re-pulled (`isFloatingRef` in `runner.ts`).
     The pin covers Codex with updates off, and the first seeding of an empty `ralph-codex-cli` volume. A failed update still runs the cached Codex. The README troubleshooting bullet maps a remedy to each path.
- **The image release fails while the npm packages ship.** `gpt-6-sol` would then be the default while `:latest` still bakes 0.154.0. Post-release check, owed to the owner: the `ralph-sandbox-v*` release exists, and `docker run --rm --entrypoint codex docker.io/daonhan/ralph-sandbox:latest --version` prints `codex-cli 0.156.1`.
- **The account lacks the new default model.** Codex and Claude own that error, and Ralph never falls back. The existing troubleshooting bullets cover it.

## Rollback

Revert the merge. No persisted schema, migration or run-log field changes. Operators can pin the old models meanwhile with `--model "claude-opus-5[1m]"` or `--agent codex --model gpt-5.6-sol`.

## Unresolved assumptions

- The owner decided to keep `[1m]`. It is kept because the live probe accepted it.
- A Claude Code version between 2.1.278 and 2.1.280 is untested. The docs quote the floor from the CLI's own error, `2.1.280 or newer`.

## Notes

### Plan-time evidence (2026-09-23)

- `npm view @openai/codex version` returned `0.156.1`. The `alpha` tag is `0.157.0-alpha.11` and is not used.
- `codex debug models --bundled` from 0.156.1 (installed inside `ralph-sandbox:latest`). The listed models are:
  - `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`: `low…max` plus `ultra`
  - `gpt-6-luna`, `gpt-5.6-luna`: `low…max`
  - `gpt-5.5`: `low…xhigh`
    The baked 0.154.0 lists no `gpt-6-sol` or `gpt-6-luna`.
- Baked Claude Code 2.1.278 exits 1 with zero API usage on `claude-opus-5-5[1m]` and on `claude-opus-5-5`, and answers on `claude-opus-5[1m]`. Host Claude Code 2.1.280 answers on both new forms.
- Host baseline on `main` 71d7ee6: `pnpm -r typecheck` ok, `pnpm -r test` 411/411 across 19 files, root `pnpm test` 60/60.

### Census

These counts are read by command on base 71d7ee6:

| Reading                                                                    | Count                                                                                                                                                 | Command                                                                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Old-default occurrences in non-test source                                 | 4 (claude.ts:137, codex.ts:248, cli-help.ts:232, cli-help.ts:236)                                                                                     | `grep -rnoE 'claude-opus-5\[1m\]\|gpt-5\.6-sol' packages/core/src --include=*.ts --exclude-dir=__tests__`                                      |
| Old-pin occurrences                                                        | 4 (Dockerfile:52, smoke-image.mjs:72, smoke-image.test.mjs:27, smoke-image.test.mjs:197)                                                              | `grep -rnoE '0\.154\.0\|0\\\.154\\\.0' packages/core/templates/Dockerfile scripts`                                                             |
| Old-default and old-pin occurrences in README, QUICKSTART and ARCHITECTURE | 21 before; 3 in 2 README lines at the planned end state (the catalog's `gpt-5.6-sol` row, and the troubleshooting bullet's explicit-older-model line) | `grep -rnoE 'claude-opus-5\[1m\]\|gpt-5\.6-sol\|0\.154\.0' README.md QUICKSTART.md docs/ARCHITECTURE.md` (end state dry-run in a scratch copy) |

Census figures that do not move: the suite totals. Tests change assertions but none is added, so they stay at 411 core and 60 root.

### Plan-adversary review

- **Pass 1: `fix-first`, effective `fix-first`, no Criticals.**
  - W1, the regex-escaped pin at `smoke-image.test.mjs:197` missing from the site list: folded.
  - W2, the claim that only `RALPH_CLAUDE_UPDATE=0` is hit being too narrow, because a failed update runs the cached volume copy and local tags are never re-pulled: folded into Risks and the troubleshooting bullet.
  - W3, the pin not covering an update that failed with updates on: folded.
  - W4, the npm default depending on the image release, with commit types needing to reach both components: folded (post-release check, dictated commit types).
  - S1, the verification recipes (`--image`, `node apps/cli/bin/…`, PowerShell `$env:`): folded.
  - S2, no Claude check in `smoke-image.mjs`: folded as an exclusion.
  - S3, quoting `[1m]` in shell examples: folded.
- **Pass 2: `fix-first`, effective `go`, no Criticals.**
  - W1, the docs grep AC reading 0 with most stale sites unfixed: folded, the AC now greps all three tokens and names its two expected hits.
  - W2, the README and QUICKSTART install lines belonging to neither issue: folded into issue B, with the pin AC split per issue.
  - W3, the bullet overclaiming and the symptom text perhaps never reaching the user: folded after a probe through `--output-format stream-json`, whose assistant text is the `API Error: 400 … 2.1.280 or newer is required` line now quoted, and a host probe showing 2.1.280 accepts the bare id too.
  - S1, remedies mapped per path, plus "volume is in use": folded.
  - S3, a Codex fallback example: folded.
  - S4, no `visibility=list` claim in the heading: folded.
- New failure mode: a literal grep for a pinned value misses its regex-escaped test copy, and a named-volume CLI cache outlives a newer image. Both are recorded in `.claude/agent-memory/plan-adversary/`.
