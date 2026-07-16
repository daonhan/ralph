import { describe, expect, it } from "vitest";

import { createClaudeDecoder } from "../agents/claude.js";
import { createCodexDecoder } from "../agents/codex.js";

describe("Claude stream decoder", () => {
  it("normalizes init, assistant, tool, and result records", () => {
    const decoder = createClaudeDecoder();
    expect(
      decoder.decode({
        type: "system",
        subtype: "init",
        model: "sonnet",
        cwd: "/work",
      }).events
    ).toEqual([{ type: "init", detail: "model=sonnet cwd=/work" }]);

    expect(
      decoder.decode({
        type: "assistant",
        message: {
          content: [
            { type: "thinking" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "pnpm test" },
            },
            { type: "text", text: "Done" },
          ],
        },
      }).events
    ).toEqual([
      { type: "thinking" },
      {
        type: "tool-start",
        id: "tool-1",
        name: "Bash",
        input: { command: "pnpm test" },
      },
      { type: "assistant", text: "Done" },
    ]);

    expect(
      decoder.decode({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "passed",
              is_error: false,
            },
          ],
        },
      }).events
    ).toEqual([
      {
        type: "tool-result",
        id: "tool-1",
        content: "passed",
        isError: false,
      },
    ]);

    expect(
      decoder.decode({ type: "result", result: "final", is_error: false })
    ).toEqual({ events: [], completion: "final" });
    expect(decoder.finish()).toBe("final");
  });

  it("preserves Claude's legacy empty finish result", () => {
    expect(createClaudeDecoder().finish()).toBe("");
  });
});

describe("Codex stream decoder", () => {
  it("normalizes a successful turn and returns the last agent message", () => {
    const decoder = createCodexDecoder();
    expect(
      decoder.decode({
        type: "thread.started",
        thread_id: "thread-1",
      }).events
    ).toEqual([{ type: "init", detail: "agent=codex thread=thread-1" }]);

    expect(
      decoder.decode({
        type: "item.started",
        item: {
          id: "item-1",
          type: "command_execution",
          command: "pnpm test",
        },
      }).events
    ).toEqual([
      {
        type: "tool-start",
        id: "item-1",
        name: "command",
        input: { command: "pnpm test" },
      },
    ]);

    expect(
      decoder.decode({
        type: "item.completed",
        item: {
          id: "item-1",
          type: "command_execution",
          aggregated_output: "passed",
          exit_code: 0,
          status: "completed",
        },
      }).events
    ).toEqual([
      {
        type: "tool-result",
        id: "item-1",
        name: "command",
        content: "passed",
        isError: false,
      },
    ]);

    expect(
      decoder.decode({
        type: "item.completed",
        item: {
          id: "item-2",
          type: "agent_message",
          text: "finished",
        },
      }).events
    ).toEqual([{ type: "assistant", text: "finished" }]);

    expect(decoder.decode({ type: "turn.completed" })).toEqual({
      events: [],
      completion: "finished",
    });
    expect(decoder.finish()).toBe("finished");
  });

  it.each([
    [
      "file_change",
      { changes: [{ path: "a.ts", kind: "update" }] },
      "file_change",
    ],
    [
      "mcp_tool_call",
      { server: "github", tool: "search", result: { count: 1 } },
      "github.search",
    ],
    ["web_search", { query: "Codex docs", result: ["hit"] }, "web_search"],
    ["plan", { text: "1. test" }, "plan"],
  ])("normalizes completed %s items", (type, fields, name) => {
    const decoder = createCodexDecoder();
    const decoded = decoder.decode({
      type: "item.completed",
      item: { id: "item-x", type, status: "completed", ...fields },
    });
    expect(decoded.events[0]).toMatchObject({
      type: "tool-result",
      id: "item-x",
      name,
      isError: false,
    });
  });

  it("accepts a successful MCP item with a null error", () => {
    const decoded = createCodexDecoder().decode({
      type: "item.completed",
      item: {
        id: "item-mcp",
        type: "mcp_tool_call",
        server: "github",
        tool: "search",
        status: "completed",
        result: { count: 1 },
        error: null,
      },
    });

    expect(decoded.events[0]).toMatchObject({
      type: "tool-result",
      id: "item-mcp",
      name: "github.search",
      isError: false,
    });
  });

  it("rejects a declined command without an exit code", () => {
    const decoded = createCodexDecoder().decode({
      type: "item.completed",
      item: {
        id: "item-command",
        type: "command_execution",
        command: "pnpm test",
        status: "declined",
      },
    });

    expect(decoded.events[0]).toMatchObject({
      type: "tool-result",
      id: "item-command",
      name: "command",
      isError: true,
    });
  });

  it("surfaces turn failures and error records", () => {
    const decoder = createCodexDecoder();
    expect(
      decoder.decode({
        type: "turn.failed",
        error: { message: "model unavailable" },
      }).failure
    ).toBe("model unavailable");
    expect(
      decoder.decode({ type: "error", message: "auth missing" }).failure
    ).toBe("auth missing");
  });

  it("rejects completion without a final agent message", () => {
    expect(createCodexDecoder().decode({ type: "turn.completed" })).toEqual({
      events: [],
      failure: "codex turn completed without a final agent message",
    });
  });

  it("rejects a successful process finish without turn.completed", () => {
    const decoder = createCodexDecoder();
    decoder.decode({
      type: "item.completed",
      item: { type: "agent_message", text: "partial" },
    });
    expect(() => decoder.finish()).toThrow(
      "codex exited without turn.completed"
    );
  });

  it("ignores unknown additive events", () => {
    expect(
      createCodexDecoder().decode({
        type: "future.event",
        payload: { value: 1 },
      })
    ).toEqual({ events: [] });
  });
});
