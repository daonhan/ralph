/**
 * Terminal pretty-printer for the Claude CLI's NDJSON stream, plus the TTY-gated
 * ANSI styling primitives. Extracted from runner.ts: this module has no docker
 * dependency — `renderEvent` consumes an already-parsed stream event and writes
 * assistant text to stdout and tool/diagnostic events to stderr.
 */

import type { AgentRenderEvent } from "./agents/types.js";

const TOOL_INPUT_PREVIEW = 200;
const TOOL_RESULT_PREVIEW = 120;
const TOOL_ERROR_PREVIEW = 400;

/* ── TTY-gated styling ────────────────────────────────────────────────── */

const NO_COLOR_ENV =
  process.env.NO_COLOR != null || process.env.TERM === "dumb";

/** Controls ANSI codes on stderr (tool events, banners, docker output). */
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

export type ToolTrack = { name: string; startedAt: number };

export function renderEvent(
  ev: AgentRenderEvent,
  toolMap: Map<string, ToolTrack>
): void {
  switch (ev.type) {
    case "init":
      process.stderr.write(`${dim("───")} ${bold("init")} ${dim(ev.detail)}\n`);
      return;
    case "assistant": {
      const lines = ev.text.split("\n");
      const formatted = lines
        .map((line, index) =>
          index === 0
            ? `${boldOut(cyanOut(SYM_OUT.bullet))} ${line}`
            : `  ${line}`
        )
        .join("\r\n");
      process.stdout.write(formatted + "\r\n\n");
      return;
    }
    case "thinking":
      process.stderr.write(`${dim(SYM.bullet + " thinking" + SYM.ellip)}\n`);
      return;
    case "tool-start": {
      if (ev.id) {
        toolMap.set(ev.id, { name: ev.name, startedAt: Date.now() });
      }
      process.stderr.write(
        `${cyan(SYM.bullet)} ${bold(ev.name)} ${dim(
          previewInput(ev.name, ev.input)
        )}\n`
      );
      return;
    }
    case "tool-result": {
      const text = stringifyToolResult(ev.content);
      const tracked = ev.id ? toolMap.get(ev.id) : undefined;
      const toolName = tracked?.name ?? ev.name ?? "tool";
      const elapsed = tracked ? ` (${Date.now() - tracked.startedAt}ms)` : "";
      if (ev.id) toolMap.delete(ev.id);
      if (ev.isError) {
        const snippet = text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, TOOL_ERROR_PREVIEW);
        process.stderr.write(
          `${dim(SYM.cont)} ${red(SYM.cross)} ${bold(toolName)}${red(
            " failed"
          )}\n  ${red(snippet)}${
            text.length > snippet.length ? " " + SYM.ellip : ""
          }\n`
        );
      } else {
        const snippet = text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, TOOL_RESULT_PREVIEW);
        process.stderr.write(
          `${dim(SYM.cont)} ${green(SYM.check)} ${bold(toolName)}${dim(
            elapsed
          )} ${dim(snippet)}${
            text.length > snippet.length ? " " + SYM.ellip : ""
          }\n`
        );
      }
      return;
    }
    case "diagnostic":
      process.stderr.write(
        ev.isError
          ? `${red(SYM.bullet + " " + ev.message)}\n`
          : `${dim(SYM.bullet + " " + ev.message)}\n`
      );
  }
}

function previewInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Pick the most informative field per tool.
  const keyOrder: Record<string, string[]> = {
    Bash: ["command"],
    command: ["command"],
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
