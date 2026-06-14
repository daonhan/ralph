/**
 * Terminal pretty-printer for the Claude CLI's NDJSON stream, plus the TTY-gated
 * ANSI styling primitives. Extracted from runner.ts: this module has no runner
 * dependency — `renderEvent` consumes an already-parsed stream event and writes
 * assistant text to stdout and tool/diagnostic events to stderr.
 */

const TOOL_INPUT_PREVIEW = 200;
const TOOL_RESULT_PREVIEW = 120;
const TOOL_ERROR_PREVIEW = 400;

/* ── TTY-gated styling ────────────────────────────────────────────────── */

const NO_COLOR_ENV =
  process.env.NO_COLOR != null || process.env.TERM === "dumb";

/** Controls ANSI codes on stderr (tool events, banners, subprocess output). */
export const USE_COLOR = process.stderr.isTTY === true && !NO_COLOR_ENV;

/** Controls ANSI codes on stdout (assistant text bullets, completion line).
 *  Separate from USE_COLOR so `ralph-ghafk 1 > out.txt` stays clean even
 *  when stderr is still a TTY. */
const USE_COLOR_STDOUT = process.stdout.isTTY === true && !NO_COLOR_ENV;

const c = (code: string, s: string): string =>
  USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
const cOut = (code: string, s: string): string =>
  USE_COLOR_STDOUT ? `\x1b[${code}m${s}\x1b[0m` : s;
export const dim = (s: string): string => c("2", s);
export const bold = (s: string): string => c("1", s);
const cyan = (s: string): string => c("36", s);
const green = (s: string): string => c("32", s);
export const red = (s: string): string => c("31", s);
export const boldOut = (s: string): string => cOut("1", s);
const cyanOut = (s: string): string => cOut("36", s);
export const greenOut = (s: string): string => cOut("32", s);
export const dimOut = (s: string): string => cOut("2", s);

export const SYM = USE_COLOR
  ? { bullet: "●", cont: "⎿", check: "✓", cross: "✗", rule: "━", ellip: "…" }
  : {
      bullet: "*",
      cont: "  >",
      check: "ok",
      cross: "FAIL",
      rule: "=",
      ellip: "...",
    };

export const SYM_OUT = USE_COLOR_STDOUT ? { bullet: "●" } : { bullet: "*" };

type AssistantBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
};
type UserBlock = {
  type: string;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
};
export type StreamJson =
  | { type: "assistant"; message?: { content?: AssistantBlock[] } }
  | { type: "user"; message?: { content?: UserBlock[] } }
  | { type: "system"; subtype?: string; [k: string]: unknown }
  | { type: "result"; result?: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export type ToolTrack = { name: string; startedAt: number };

export function renderEvent(
  ev: StreamJson,
  toolMap: Map<string, ToolTrack>
): void {
  switch (ev.type) {
    case "system": {
      const sub = (ev as { subtype?: string }).subtype;
      if (sub === "init") {
        const model = (ev as { model?: string }).model ?? "?";
        const cwd = (ev as { cwd?: string }).cwd ?? "?";
        process.stderr.write(
          `${dim("───")} ${bold("init")} ${dim(`model=${model} cwd=${cwd}`)}\n`
        );
      }
      return;
    }
    case "assistant": {
      const content =
        (ev as { message?: { content?: AssistantBlock[] } }).message?.content ??
        [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          const lines = block.text.split("\n");
          const formatted = lines
            .map((l, idx) =>
              idx === 0 ? `${boldOut(cyanOut(SYM_OUT.bullet))} ${l}` : `  ${l}`
            )
            .join("\r\n");
          process.stdout.write(formatted + "\r\n\n");
        } else if (block.type === "thinking") {
          process.stderr.write(
            `${dim(SYM.bullet + " thinking" + SYM.ellip)}\n`
          );
        } else if (block.type === "tool_use") {
          const name = block.name ?? "?";
          const preview = previewInput(name, block.input);
          if (block.id) {
            toolMap.set(block.id, { name, startedAt: Date.now() });
          }
          process.stderr.write(
            `${cyan(SYM.bullet)} ${bold(name)} ${dim(preview)}\n`
          );
        }
      }
      return;
    }
    case "user": {
      const content =
        (ev as { message?: { content?: UserBlock[] } }).message?.content ?? [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const text = stringifyToolResult(block.content);
        const tracked = block.tool_use_id
          ? toolMap.get(block.tool_use_id)
          : undefined;
        const toolName = tracked?.name ?? "tool";
        const elapsed = tracked ? ` (${Date.now() - tracked.startedAt}ms)` : "";
        if (block.tool_use_id) toolMap.delete(block.tool_use_id);

        if (block.is_error) {
          const snippet = text
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, TOOL_ERROR_PREVIEW);
          process.stderr.write(
            `${dim(SYM.cont)} ${red(SYM.cross)} ${bold(toolName)}${red(" failed")}\n  ${red(snippet)}${text.length > snippet.length ? " " + SYM.ellip : ""}\n`
          );
        } else {
          const snippet = text
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, TOOL_RESULT_PREVIEW);
          process.stderr.write(
            `${dim(SYM.cont)} ${green(SYM.check)} ${bold(toolName)}${dim(elapsed)} ${dim(snippet)}${text.length > snippet.length ? " " + SYM.ellip : ""}\n`
          );
        }
      }
      return;
    }
    case "result": {
      const isError = (ev as { is_error?: boolean }).is_error;
      if (isError)
        process.stderr.write(`${red(SYM.bullet + " result errored")}\n`);
      return;
    }
    default:
      return;
  }
}

function previewInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Pick the most informative field per tool.
  const keyOrder: Record<string, string[]> = {
    Bash: ["command"],
    Edit: ["file_path"],
    Write: ["file_path"],
    Read: ["file_path"],
    Glob: ["pattern", "path"],
    Grep: ["pattern", "path"],
    TodoWrite: [],
  };
  const keys = keyOrder[toolName] ?? Object.keys(obj).slice(0, 2);
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${truncate(s, TOOL_INPUT_PREVIEW)}`);
  }
  return parts.join(" ");
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c)
          return String((c as { text: unknown }).text ?? "");
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + SYM.ellip;
}
