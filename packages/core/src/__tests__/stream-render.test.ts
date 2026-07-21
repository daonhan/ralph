import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderEvent, type ToolTrack } from "../stream-render.js";

describe("renderEvent", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let tools: Map<string, ToolTrack>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    tools = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the Claude init detail format", () => {
    renderEvent({ type: "init", detail: "model=sonnet cwd=/work" }, tools);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("init model=sonnet cwd=/work")
    );
  });

  it("writes assistant text only to stdout", () => {
    renderEvent({ type: "assistant", text: "line one\nline two" }, tools);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("line one\r\n  line two")
    );
    expect(stderr).not.toHaveBeenCalled();
  });

  it("pairs tool starts and results", () => {
    renderEvent(
      {
        type: "tool-start",
        id: "tool-1",
        name: "command",
        input: { command: "pnpm test" },
      },
      tools
    );
    renderEvent(
      {
        type: "tool-result",
        id: "tool-1",
        content: "passed",
        isError: false,
      },
      tools
    );
    expect(tools.size).toBe(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("command"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("passed"));
  });

  it("renders provider failures as errors", () => {
    renderEvent(
      { type: "diagnostic", message: "auth missing", isError: true },
      tools
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("auth missing")
    );
  });
});
