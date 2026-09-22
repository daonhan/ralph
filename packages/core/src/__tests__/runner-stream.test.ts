import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
    spawnSync: childProcessMocks.spawnSync,
  };
});

import { createCodexDecoder } from "../agents/codex.js";
import { runStage, streamDocker } from "../runner.js";

const spawnMock = childProcessMocks.spawn;

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
}

const container = { name: "ralph-run-i1-s0-a1", runId: "run" };

/** The detached `docker rm -f` calls made after the `docker run` spawn. */
function removals(): unknown[][] {
  return spawnMock.mock.calls.filter(
    (call) => (call[1] as string[])[0] === "rm"
  );
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
    childProcessMocks.spawnSync.mockReset();
    childProcessMocks.spawnSync.mockReturnValue({ status: 1, stdout: "" });
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

    await expect(run).resolves.toEqual({ text: "finished", meta: {} });
    expect(readFileSync(logPath, "utf8")).toContain('"turn.completed"');
  });

  it("uses the supplied snapshot after asynchronous runner preparation", async () => {
    const chownChild = fakeChild();
    const stageChild = fakeChild();
    spawnMock
      .mockReturnValueOnce(chownChild as never)
      .mockReturnValueOnce(stageChild as never);
    childProcessMocks.spawnSync.mockImplementation((command, args) => {
      if (command === "docker" && Array.isArray(args) && args[0] === "volume") {
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    });

    const home = join(root, "home");
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, '{ "model": "claude-first" }');
    writeFileSync(join(root, "package.json"), "{}\n");
    const saved = {
      home: process.env.HOME,
      isolate: process.env.RALPH_ISOLATE_NODE_MODULES,
      socket: process.env.RALPH_DOCKER_SOCK,
    };
    process.env.HOME = home;
    process.env.RALPH_ISOLATE_NODE_MODULES = "1";
    process.env.RALPH_DOCKER_SOCK = "0";

    try {
      const run = runStage(
        {
          name: "implementer",
          template: "afk.md",
          permissionMode: "bypassPermissions",
        },
        "prompt",
        root,
        1,
        undefined,
        join(root, "stage.ndjson"),
        {
          agent: "claude",
          configSnapshot: {
            model: "claude-first",
            modelSource: "host ~/.claude/settings.json",
            effortSource: "Claude CLI default",
          },
        }
      );

      expect(spawnMock).toHaveBeenCalledTimes(1);
      writeFileSync(settings, '{ "model": "claude-second" }');
      chownChild.emit("close", 0);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

      const dockerArgs = spawnMock.mock.calls[1]![1] as string[];
      expect(dockerArgs).toContain("claude-first");
      expect(dockerArgs).not.toContain("claude-second");

      writeJson(stageChild, { type: "result", result: "done" });
      stageChild.emit("close", 0);
      await expect(run).resolves.toEqual({ text: "done", meta: {} });
    } finally {
      for (const [key, value] of [
        ["HOME", saved.home],
        ["RALPH_ISOLATE_NODE_MODULES", saved.isolate],
        ["RALPH_DOCKER_SOCK", saved.socket],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps direct runStage calls resolving provider config when no snapshot is supplied", async () => {
    const home = join(root, "direct-home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{ "model": "claude-direct" }'
    );
    const saved = {
      home: process.env.HOME,
      isolate: process.env.RALPH_ISOLATE_NODE_MODULES,
      socket: process.env.RALPH_DOCKER_SOCK,
    };
    process.env.HOME = home;
    process.env.RALPH_ISOLATE_NODE_MODULES = "0";
    process.env.RALPH_DOCKER_SOCK = "0";

    try {
      const run = runStage(
        { name: "implementer", template: "afk.md" },
        "prompt",
        root,
        1,
        undefined,
        join(root, "direct.ndjson"),
        { agent: "claude" }
      );
      const dockerArgs = spawnMock.mock.calls[0]![1] as string[];
      expect(dockerArgs).toContain("claude-direct");
      writeJson(child, { type: "result", result: "done" });
      child.emit("close", 0);
      await expect(run).resolves.toEqual({ text: "done", meta: {} });
    } finally {
      for (const [key, value] of [
        ["HOME", saved.home],
        ["RALPH_ISOLATE_NODE_MODULES", saved.isolate],
        ["RALPH_DOCKER_SOCK", saved.socket],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reports each JSON record the agent writes, and nothing else", async () => {
    const onOutput = vi.fn();
    const run = streamDocker(
      [],
      join(root, "output.ndjson"),
      createCodexDecoder(),
      { onOutput }
    );
    writeJson(child, { type: "turn.started" });
    child.stdout.write("not a record\n");
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "finished" },
    });
    writeJson(child, { type: "turn.completed" });
    child.emit("close", 0);

    await expect(run).resolves.toEqual({ text: "finished", meta: {} });
    expect(onOutput).toHaveBeenCalledTimes(3);
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
    expect(removals()).toEqual([]);
  });

  it("removes the named container it abandons on a provider failure", async () => {
    const run = streamDocker(
      [],
      join(root, "failure-named.ndjson"),
      createCodexDecoder(),
      { container }
    );
    writeJson(child, { type: "error", message: "auth missing" });

    await expect(run).rejects.toThrow("auth missing");
    expect(removals()).toEqual([
      [
        "docker",
        ["rm", "-f", container.name],
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      ],
    ]);
    expect(child.unref).toHaveBeenCalled();
  });

  it("removes the named container when the stage is aborted", async () => {
    const abort = new AbortController();
    const run = streamDocker(
      [],
      join(root, "abort-named.ndjson"),
      createCodexDecoder(),
      { container, signal: abort.signal }
    );

    abort.abort();

    await expect(run).rejects.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(removals().map((call) => call[1])).toEqual([
      ["rm", "-f", container.name],
    ]);
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

    await expect(run).resolves.toEqual({ text: "finished", meta: {} });
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

  it("applies the existing grace timer and flags graceTimerFired", async () => {
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

    await expect(run).resolves.toEqual({
      text: "finished",
      meta: { graceTimerFired: true },
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(removals()).toEqual([]);
  });

  it("removes the named container the grace timer gives up on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    process.env.RALPH_RESULT_GRACE_MS = "10";
    const run = streamDocker(
      [],
      join(root, "grace-named.ndjson"),
      createCodexDecoder(),
      { container }
    );
    writeJson(child, {
      type: "item.completed",
      item: { type: "agent_message", text: "finished" },
    });
    writeJson(child, { type: "turn.completed" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10);

    await expect(run).resolves.toMatchObject({ text: "finished" });
    expect(removals().map((call) => call[1])).toEqual([
      ["rm", "-f", container.name],
    ]);
  });

  it("survives a docker CLI that cannot be spawned for the removal", async () => {
    const run = streamDocker(
      [],
      join(root, "failure-nodocker.ndjson"),
      createCodexDecoder(),
      { container }
    );
    spawnMock.mockImplementation(() => {
      throw new Error("spawn docker ENOENT");
    });
    writeJson(child, { type: "error", message: "auth missing" });

    await expect(run).rejects.toThrow("auth missing");
  });
});
