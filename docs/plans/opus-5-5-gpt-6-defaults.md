# Plan: Opus 5.5 and GPT-6 Sol/Luna defaults

> Slice ID: `opus-5-5-gpt-6-defaults` · Slice 175 ([issue #175](https://github.com/daonhan/ralph/issues/175) → [issue #176](https://github.com/daonhan/ralph/issues/176)).

**Goal:** Ralph defaults to `claude-opus-5-5[1m]` and isolated-Codex `gpt-6-sol`, and the sandbox bakes a Codex client that knows `gpt-6-sol` and `gpt-6-luna`.

**Spec:** [PRD](../prd/opus-5-5-gpt-6-defaults.md).

**Base:** `main` at 71d7ee6. Host gate is green: typecheck ok, core 411/411, root 60/60.

## Invariants

- `--model` and `RALPH_*_MODEL` stay verbatim pass-through. No aliases, no validation, no fallback.
- Model and effort resolve independently. Isolated Codex keeps `high`. Claude sends no `--effort` unless tuned.
- `CLAUDE.md` and `AGENTS.md` mirror each other. Neither names the literal defaults, so neither is edited.
- Commit identity is harness-owned. Never set `user.*` or pass `--author`.
- Historical records stay untouched: `docs/prd`, `docs/plans`, `docs/superpowers`, `docs/reviews`, CHANGELOGs.

## Phase A — defaults, pin and tests (issue #175)

Files and edits:

| File                                           | Edit                                                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/__tests__/agents.test.ts`   | line 343 `toBe("claude-opus-5[1m]")` → `toBe("claude-opus-5-5[1m]")`; line 740 `"gpt-5.6-sol",` → `"gpt-6-sol",` (the isolated default argv case)                                                  |
| `packages/core/src/__tests__/cli-help.test.ts` | line 206 `"gpt-5.6-sol (Ralph default)"` → `"gpt-6-sol (Ralph default)"`; line 209 `model: "gpt-5.6-sol",` → `model: "gpt-6-sol",`; line 330 `toContain("gpt-5.6-sol")` → `toContain("gpt-6-sol")` |
| `packages/core/src/__tests__/loop.test.ts`     | line 600 `configured model=gpt-5.6-sol (Ralph default)` → `configured model=gpt-6-sol (Ralph default)`; line 1179 `model: "gpt-5.6-sol",` → `model: "gpt-6-sol",`                                  |
| `scripts/smoke-image.test.mjs`                 | line 27 `"codex-cli 0.154.0\n"` → `"codex-cli 0.156.1\n"`; line 197 `/ARG CODEX_VERSION=0\.154\.0/` → `/ARG CODEX_VERSION=0\.156\.1/`                                                              |
| `packages/core/src/agents/claude.ts`           | line 137 `DEFAULT_CLAUDE_MODEL = "claude-opus-5-5[1m]"`                                                                                                                                            |
| `packages/core/src/agents/codex.ts`            | line 248 `DEFAULT_CODEX_MODEL = "gpt-6-sol"`                                                                                                                                                       |
| `packages/core/src/cli-help.ts`                | line 232 `none), then claude-opus-5-5[1m] (Ralph default). Host`; line 236 `Codex defaults to gpt-6-sol, and to high reasoning`                                                                    |
| `scripts/smoke-image.mjs`                      | line 72 `"codex-cli 0.156.1"`                                                                                                                                                                      |
| `packages/core/templates/Dockerfile`           | line 52 `ARG CODEX_VERSION=0.156.1`                                                                                                                                                                |

Leave these fixtures alone. They are explicit or host-set values, not defaults:

- `run-log.test.ts:264,272`
- `agents.test.ts:217,251,302-306,347,359,369-375,437-455,510,517,527-540`
- `cli-help.test.ts:98-119`

Order:

1. Edit the four test files first.
2. Run the suites below and see them **red** on the default cases: agents 2, cli-help 2, loop 2, smoke-image 2 or more.
3. Edit the five source files and see them green.

Per-phase verification, by file path:

```bash
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/agents.test.ts src/__tests__/cli-help.test.ts src/__tests__/loop.test.ts
node --test scripts/smoke-image.test.mjs
pnpm -r typecheck
```

Acceptance criteria:

- `grep -rnoE 'claude-opus-5\[1m\]|gpt-5\.6-sol' packages/core/src --include=*.ts --exclude-dir=__tests__` → 0 hits. It reads 4 before: `claude.ts:137`, `codex.ts:248`, `cli-help.ts:232` and `cli-help.ts:236`.
- `grep -rnoE '0\.154\.0|0\\\.154\\\.0' packages/core/templates/Dockerfile scripts` → 0 hits. It reads 4 before: `Dockerfile:52`, `smoke-image.mjs:72`, `smoke-image.test.mjs:27` and `smoke-image.test.mjs:197`.
- The three vitest files and `smoke-image.test.mjs` pass, and typecheck passes.
- Mutation gate: reverting `DEFAULT_CLAUDE_MODEL` alone turns `agents.test.ts` "pins the Ralph default model value" red. Reverting `DEFAULT_CODEX_MODEL` alone turns the isolated-argv case, `describes isolated Codex defaults`, the loop attempt-line case and the `run.started` case red.
- Commit subject, at most 72 characters: `feat(core): default to Opus 5.5 and GPT-6 Sol; pin Codex 0.156.1`. The one commit spans both release-please components, `packages/core` and `packages/core/templates`.

## Phase B — docs (issue #176, blocked by #175)

`README.md`:

| Line    | Edit                                                                                                                                                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 189     | `claude-opus-5[1m]` → `claude-opus-5-5[1m]`                                                                                                                                                                                                                                                   |
| 190     | `` `gpt-5.6-sol` `` → `` `gpt-6-sol` ``, keeping the table padding                                                                                                                                                                                                                            |
| 199     | the attempt-line example names `gpt-6-sol`                                                                                                                                                                                                                                                    |
| 249-256 | the catalog. Its heading line becomes `model is entitled to run it. The Codex 0.156.1 bundled catalog reported this` / `snapshot on 2026-09-23:`. Its rows become the table below. The paragraph after it stays; its "none and minimal … absent from this modern-model snapshot" still holds. |
| 277-278 | the examples block below                                                                                                                                                                                                                                                                      |
| 405     | `npm install --global @openai/codex@0.156.1`                                                                                                                                                                                                                                                  |
| 692     | env table `RALPH_MODEL` default cell: `` Claude `claude-opus-5-5[1m]`; isolated Codex `gpt-6-sol` ``. Re-pad the table column if Prettier asks.                                                                                                                                               |
| 856     | "does not silently fall back to `gpt-6-sol`"                                                                                                                                                                                                                                                  |

Catalog rows. They come from 0.156.1 `codex debug models --bundled` and use the old table's rule: listed modern models that advertise `max`. `gpt-5.5` stays out.

| Model ID        | Advertised effort values                         |
| --------------- | ------------------------------------------------ |
| `gpt-6-astra`   | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-6-sol`     | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-6-luna`    | `low`, `medium`, `high`, `xhigh`, `max`          |
| `gpt-5.6-sol`   | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna`  | `low`, `medium`, `high`, `xhigh`, `max`          |

Examples block. It replaces the first two lines of the PowerShell block at README 277-278; the env-pin lines after them stay:

```powershell
ralph-afk --agent codex --model gpt-6-sol --effort ultra --print-config
ralph-afk --agent codex --model gpt-6-sol --effort ultra "docs/plan.md" 3
ralph-afk --agent codex --model gpt-6-luna --effort max "docs/plan.md" 3
ralph-afk --model claude-opus-5-5 --effort xhigh "docs/plan.md" 3
```

Troubleshooting bullet. It is new, and goes right after the "An explicit Codex model or effort fails" bullet (README 856). Insert it verbatim:

```markdown
- **`API Error: 400 Claude Code <version> does not support this model; version 2.1.280 or newer is required`, or Codex `The '<model>' model requires a newer version of Codex`** — the CLI that ran predates the model: Claude Code older than 2.1.280 cannot run `claude-opus-5-5` (Ralph's Claude default), and a Codex client older than the image's pinned 0.156.1 may not know `gpt-6-sol` (Ralph's isolated Codex default) or `gpt-6-luna`. The per-stage update normally prevents this; the fix depends on why it did not run:
  - the update failed (offline, registry down), so the stage ran the copy cached in the `ralph-claude-home` / `ralph-codex-cli` volume → retry once the registry answers, or remove the volume (`docker volume rm ralph-claude-home` / `docker volume rm ralph-codex-cli`; refused while a run is using it) so the next run re-seeds it from the local image — the only cost is one download;
  - `RALPH_CLAUDE_UPDATE=0` / `RALPH_CODEX_UPDATE=0` runs the image's baked CLI → `docker pull docker.io/daonhan/ralph-sandbox:latest`;
  - a locally tagged image (for example `ralph-sandbox:pg17`) is never re-pulled → rebuild it with `docker build --pull`, then remove the volume as above;
  - or name an older model explicitly: `--model "claude-opus-5[1m]"`, or `--agent codex --model gpt-5.6-sol`.
```

`QUICKSTART.md`:

- line 94: `npm install --global @openai/codex@0.156.1`
- line 125: `` `gpt-6-sol` ``

`docs/ARCHITECTURE.md`:

| Line | Edit                                                  |
| ---- | ----------------------------------------------------- |
| 307  | `else claude-opus-5-5[1m]>`                           |
| 317  | `else gpt-6-sol>`                                     |
| 361  | the attempt-line example names `gpt-6-sol`            |
| 414  | ``(`claude-opus-5-5[1m]`)``                           |
| 432  | ``(`gpt-6-sol`)``                                     |
| 564  | example `run.started` `"model":"claude-opus-5-5[1m]"` |
| 888  | env table default cell, as in README 692              |

Every new example that passes `[1m]` on a command line quotes it, because zsh globs an unquoted `[1m]`.

Verification:

```bash
grep -rnE 'claude-opus-5\[1m\]|gpt-5\.6-sol|0\.154\.0' README.md QUICKSTART.md docs/ARCHITECTURE.md
npx prettier --check README.md QUICKSTART.md docs/ARCHITECTURE.md
```

Acceptance criteria:

- The grep above prints **exactly two lines**, both in `README.md`: the catalog row ``| `gpt-5.6-sol`   |`` and the troubleshooting line `or name an older model explicitly: …`. That is 3 occurrences with `-o`, against 21 before. The count was dry-run on a scratch copy at the planned end state.
- `grep -c 'gpt-6-luna' README.md` is at least 3 (the catalog row, the example, the troubleshooting bullet). `grep -c 'claude-opus-5-5' README.md` is at least 4 (the defaults table, the example, the env table, the troubleshooting bullet).
- Prettier check is clean.
- Commit subject: `docs: document Opus 5.5 and GPT-6 Sol/Luna defaults`.

## REVIEW-owned checks

BUILD does not run these, and no issue body carries them:

- Whole gate on the host: `pnpm -r typecheck`, `pnpm -r test`, `pnpm test`.
- Image: `docker build -t ralph-sandbox:gpt6 -f packages/core/templates/Dockerfile .`, then `node scripts/smoke-image.mjs --image ralph-sandbox:gpt6`, then `docker run --rm --entrypoint codex ralph-sandbox:gpt6 debug models --bundled` lists `gpt-6-sol` and `gpt-6-luna`.
- Print-config on the host, with `pnpm -r build` first:
  - `node apps/cli/bin/ralph-afk.js --print-config` → `claude-opus-5-5[1m] (Ralph default)`
  - `node apps/cli/bin/ralph-afk.js --agent codex --print-config` → `gpt-6-sol (Ralph default)` / `high`
  - explicit `--agent codex --model gpt-6-luna --effort max` → the explicit values
  - explicit `--model claude-opus-5-5 --effort xhigh` → the explicit values
- Live smoke. Prerequisites confirmed at plan time: host `~/.codex/auth.json` and `~/.claude/.credentials.json` exist. In PowerShell, set `$env:RALPH_CODEX_UPDATE="0"` and `$env:RALPH_IMAGE="ralph-sandbox:gpt6"`, then run one `ralph-afk --agent codex --model gpt-6-luna` iteration on a scratch workspace. This shows the baked 0.156.1 accepts GPT-6 with no update step.
- Post-merge, owed to the owner: after the release, the `ralph-sandbox-v*` release exists and `docker run --rm --entrypoint codex docker.io/daonhan/ralph-sandbox:latest --version` prints `codex-cli 0.156.1`.

## BUILD notes (recurring sandbox blockers)

- `.husky/pre-commit` is CRLF in the sandbox checkout, so run the hook's two steps by hand (`npx lint-staged`, `pnpm typecheck`) and commit with `-c core.hooksPath=/dev/null`.
- Two failures exist only in the sandbox and are pre-existing: `resolveGitConfigArgs` cases in `runner.test.ts`, and the CRLF `template-contract.test.ts` skill-name case. They are not this slice's, and the phases do not run those files.
- The sandbox has no docker CLI. Every docker check is REVIEW's.

## Rollback

Revert the merge. Nothing persisted changes.
