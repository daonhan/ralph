# Improve `ralph-ghafk` / `ralph-afk` CLI output (Claude-Code-like)

## Context

Today the harness streams Claude Code CLI's `--output-format stream-json` events and re-prints them as flat `[bracket]` lines on stderr (model init, `[tool] Bash ...`, `[tool:ok] ...`, `[thinking]`, `[docker] ...`) plus raw assistant text on stdout. It is functional but hard to scan during long AFK runs: no visual grouping of a tool call with its result, no color, no distinction between iteration boundaries, and the `[docker]` passthrough noise mixes with substantive events.

Goal: re-render the same stream-json events so a live run reads like Claude Code's own pretty terminal output — `●` bullets for assistant turns and tool calls, `⎿` continuation glyph for tool results, cyan tool names, dim metadata, clear iteration/stage banners — while staying safe when piped to a file or CI log.

All the data needed is already in the stream (`runner.ts:37-42`); this is purely a rendering change in `renderEvent` plus a banner update in `loop.ts`. No protocol or stage changes.

## Scope

In: `packages/core/src/runner.ts` (`renderEvent`, helpers, `streamDocker` stderr handling), `packages/core/src/loop.ts` (iteration/stage banner).
Out: `apps/cli/bin/*.js` (no changes), templates, stages, Dockerfile, ndjson log format (stays byte-identical — only terminal rendering changes).

## Design

### 1. TTY-gated styling (`runner.ts`, top-of-file helpers)

Add a small module-local style layer. No new prod deps (matches existing "small files" style).

```ts
const USE_COLOR =
  process.stderr.isTTY === true &&
  process.env.NO_COLOR == null &&
  process.env.TERM !== "dumb";

const c = (code: string, s: string) =>
  USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const cyan = (s: string) => c("36", s);
const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const yellow = (s: string) => c("33", s);
const magenta = (s: string) => c("35", s);

const SYM = USE_COLOR
  ? { bullet: "●", cont: "⎿", arrow: "›" }
  : { bullet: "*", cont: "  >", arrow: ">" };
```

Honors `NO_COLOR` (de-facto standard) and `TERM=dumb`. Plain ASCII fallback keeps log files / CI clean.

### 2. Event rendering (`renderEvent` in `runner.ts:253`)

Pair tool_use with tool_result by carrying a small `Map<tool_use_id, {name, startedAt}>` inside `streamDocker`'s closure (currently dropped — `AssistantBlock.id` and `UserBlock.tool_use_id` exist in the type but aren't used). Pass the map to `renderEvent` so result lines can show the originating tool name and elapsed ms.

Per-event format (all to stderr except assistant text → stdout, unchanged):

| Event                    | Today                    | New                                                                                     |
| ------------------------ | ------------------------ | --------------------------------------------------------------------------------------- |
| `system/init`            | `[init] model=… cwd=…`   | `dim("───") bold("init") dim(" model=… cwd=…")`                                         |
| `assistant/text`         | raw text + `\r\n\n`      | `bold(cyan("●")) " "` + first line; subsequent lines indented 2 spaces. Keep on stdout. |
| `assistant/thinking`     | `[thinking]`             | `dim("● thinking…")` (one-line marker, per user choice)                                 |
| `assistant/tool_use`     | `[tool] Bash command=…`  | `cyan("●") " " bold(name) " " dim(previewInput(...))`                                   |
| `user/tool_result` ok    | `[tool:ok] …`            | `dim(SYM.cont) " " green("✓") " " bold(toolName) dim(" ("+ms+"ms) ") dim(snippet)`      |
| `user/tool_result` error | `[tool:error] …`         | `dim(SYM.cont) " " red("✗") " " bold(toolName) red(" failed") "\n  " red(snippet)`      |
| `result` is_error        | `[result] is_error=true` | `red("● result errored")`                                                               |

Tool-name lookup: when rendering a `user.tool_result`, read `block.tool_use_id` and resolve from the map. Fallback: `"tool"` if missing.

Snippet rules unchanged (`stringifyToolResult`, `truncate`, 120-char preview for ok / 400 for error — drop today's 400/800 because Claude Code's own output is terser).

### 3. Iteration / stage banner (`loop.ts:29`)

Replace:

```
[sandcastle] iteration 1/3 stage 1/2 (ghafk-implementer)
```

With (when colored):

```
━━━ iteration 1/3 · ghafk-implementer (stage 1/2) ━━━
```

Plain fallback:

```
== iteration 1/3 · ghafk-implementer (stage 1/2) ==
```

Color: dim rule, bold stage name. Same line lives in `loop.ts` — single `process.stderr.write` change. Keep the prior blank line before the banner so iterations are visually separable.

Also retitle `[sandcastle] log → …` to `dim("log → " + logPath)` (drop the prefix; the banner already establishes context).

### 4. Docker stderr noise (`runner.ts:230`)

`[docker]` lines today dump everything Docker writes (image pull progress, TLS warnings, etc.). Keep the ring-buffer tail for the failure path, but route live lines through `dim("docker  " + line)` instead of `[docker] line` so they recede visually. No filtering — same information, just lower contrast.

### 5. Final completion line (`loop.ts:38`)

`Ralph complete after N iterations.` → `green("●") " " bold("Ralph complete") dim(" after " + N + " iterations")`. Stays on stdout (it's a terminal status, not an event).

## Files touched

- `packages/core/src/runner.ts` — add style helpers, rewrite `renderEvent`, thread tool-use-id map through `streamDocker`, soften `[docker]` prefix, soften `log →` line.
- `packages/core/src/loop.ts` — banner + completion line.

No new files. No package.json changes. No deps added.

## Verification

1. `pnpm -r typecheck` — must pass; the only type surface that changes is the local map inside `streamDocker`.
2. Smoke run interactively against a small target repo:
   ```bash
   pnpm -r build
   RALPH_WORKSPACE=/tmp/target ralph-ghafk 1
   ```
   Expect: colored banner, cyan `●` tool calls, `⎿ ✓` results pairing with the tool above, dim thinking marker, dim docker chatter, no double-printed iteration text. Confirm tool name on result line matches the tool above it.
3. Pipe-to-file test (forces plain branch):
   ```bash
   ralph-ghafk 1 2>&1 | tee run.log
   ```
   `run.log` must contain zero `\x1b[` escape sequences (`grep -Pc '\x1b\['` returns 0). Symbols degrade to `*` / `>`.
4. `NO_COLOR=1 ralph-ghafk 1` — same plain output even on a TTY.
5. Inspect a fresh `.ralph-tmp/logs/*.ndjson` — content must be byte-identical to a pre-change run for the same prompt (rendering layer doesn't touch the log file).
6. Force a tool failure (e.g. point at a workspace with a broken `gh` config) — confirm `✗` line renders in red and the stderr tail still surfaces on non-zero exit.

## Out of scope (deferred)

- Surfacing usage tokens / cost / duration in a final summary line. Claude Code's stream-json doesn't always emit these — would require either a stage-end accumulator or upstream CLI changes. Worth a follow-up.
- Per-subagent color rotation (Claude Code's 8-color palette). Ralph only runs one stage at a time, so no parallel tasks to disambiguate.
- Replacing `console.error(e?.stack ?? e)` in the bins with a styled crash dump.
