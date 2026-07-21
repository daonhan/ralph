import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return { ...actual, spawn: spawnMock };
});

import { createCodexDecoder } from "../agents/codex.js";
import { streamDocker } from "../runner.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

function writeJson(child: FakeChild, value: unknown): void {
  child.stdout.write(JSON.stringify(value) + "\n");
}

describe("streamDocker", () => {
  let root: string;
  let child: FakeChild;
  let originalGrace: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ralph-stream-"));
    child = fakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child as never);
    originalGrace = process.env.RALPH_RESULT_GRACE_MS;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalGrace === undefined) {
      delete process.env.RALPH_RESULT_GRACE_MS;
    } else {
      process.env.RALPH_RESULT_GRACE_MS = originalGrace;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the Codex final message and preserves raw JSONL", async () => {
    const logPath = join(root, "stage.ndjson");
    const run = streamDocker([], logPath, createCodexDecoder());
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "finished" },
    });
    writeJson(child, { type: "turn.completed" });
    child.emit("close", 0);

    await expect(run).resolves.toBe("finished");
    expect(readFileSync(logPath, "utf8")).toContain('"turn.completed"');
  });

  it("kills and rejects on a provider failure event", async () => {
    const run = streamDocker(
      [],
      join(root, "failure.ndjson"),
      createCodexDecoder()
    );
    writeJson(child, { type: "error", message: "auth missing" });

    await expect(run).rejects.toThrow("auth missing");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("survives a transient reconnect notice and still completes", async () => {
    const run = streamDocker(
      [],
      join(root, "reconnect.ndjson"),
      createCodexDecoder()
    );
    writeJson(child, { type: "error", message: "Reconnecting... 1/5" });
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "finished" },
    });
    writeJson(child, { type: "turn.completed" });
    child.emit("close", 0);

    await expect(run).resolves.toBe("finished");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["", "   "])(
    "rejects a provider failure with an empty message before later completion",
    async (message) => {
      const run = streamDocker(
        [],
        join(root, "empty-failure.ndjson"),
        createCodexDecoder()
      );
      writeJson(child, { type: "error", message });
      writeJson(child, {
        type: "item.completed",
        item: { type: "agent_message", text: "finished" },
      });
      writeJson(child, { type: "turn.completed" });
      child.emit("close", 0);

      await expect(run).rejects.toThrow("codex error");
      expect(child.kill).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects exit zero when the Codex terminal record is absent", async () => {
    const run = streamDocker(
      [],
      join(root, "incomplete.ndjson"),
      createCodexDecoder()
    );
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "partial" },
    });
    child.emit("close", 0);

    await expect(run).rejects.toThrow("codex exited without turn.completed");
  });

  it("applies the existing grace timer to Codex completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    process.env.RALPH_RESULT_GRACE_MS = "10";
    const run = streamDocker(
      [],
      join(root, "grace.ndjson"),
      createCodexDecoder()
    );
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "finished" },
    });
    writeJson(child, { type: "turn.completed" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10);

    await expect(run).resolves.toBe("finished");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
