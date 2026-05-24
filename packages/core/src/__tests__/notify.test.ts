import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  notify,
  type NotifySpawnedChild,
  type NotifySpawner,
} from "../notify.js";

type SpawnCall = {
  command: string;
  args: readonly string[];
  child: FakeChild;
};

class FakeChild extends EventEmitter {
  public unref = vi.fn();
}

function makeSpawner(): { spawner: NotifySpawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawner: NotifySpawner = (command, args) => {
    const child = new FakeChild();
    calls.push({ command, args, child });
    return child as unknown as NotifySpawnedChild;
  };
  return { spawner, calls };
}

function makeStderr() {
  const writes: string[] = [];
  return {
    stderr: { write: (s: string) => writes.push(s) },
    writes,
  };
}

describe("notify", () => {
  it("writes \\x07 to stderr on every call", () => {
    const { spawner } = makeSpawner();
    const { stderr, writes } = makeStderr();
    notify({
      level: "info",
      title: "t",
      body: "b",
      platform: "linux",
      spawner,
      stderr,
    });
    expect(writes).toContain("\x07");
  });

  it("sound:false suppresses the bell", () => {
    const { spawner } = makeSpawner();
    const { stderr, writes } = makeStderr();
    notify({
      level: "info",
      title: "t",
      body: "b",
      sound: false,
      platform: "linux",
      spawner,
      stderr,
    });
    expect(writes).not.toContain("\x07");
  });

  it("linux: invokes notify-send with normal urgency for info", () => {
    const { spawner, calls } = makeSpawner();
    const { stderr } = makeStderr();
    notify({
      level: "info",
      title: "Ralph complete",
      body: "done",
      platform: "linux",
      spawner,
      stderr,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("notify-send");
    expect(calls[0].args).toEqual([
      "--urgency",
      "normal",
      "Ralph complete",
      "done",
    ]);
    expect(calls[0].child.unref).toHaveBeenCalledTimes(1);
  });

  it("linux: invokes notify-send with critical urgency for error", () => {
    const { spawner, calls } = makeSpawner();
    const { stderr } = makeStderr();
    notify({
      level: "error",
      title: "Ralph failed",
      body: "boom",
      platform: "linux",
      spawner,
      stderr,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "--urgency",
      "critical",
      "Ralph failed",
      "boom",
    ]);
  });

  it("darwin: invokes osascript display notification with Glass sound for info", () => {
    const { spawner, calls } = makeSpawner();
    const { stderr } = makeStderr();
    notify({
      level: "info",
      title: "Ralph complete",
      body: "done",
      platform: "darwin",
      spawner,
      stderr,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("osascript");
    expect(calls[0].args[0]).toBe("-e");
    expect(calls[0].args[1]).toContain('display notification "done"');
    expect(calls[0].args[1]).toContain('with title "Ralph complete"');
    expect(calls[0].args[1]).toContain('sound name "Glass"');
  });

  it("darwin: uses a different sound for error", () => {
    const { spawner, calls } = makeSpawner();
    const { stderr } = makeStderr();
    notify({
      level: "error",
      title: "Ralph failed",
      body: "boom",
      platform: "darwin",
      spawner,
      stderr,
    });
    expect(calls[0].args[1]).not.toContain('sound name "Glass"');
    expect(calls[0].args[1]).toContain("sound name");
  });

  it("win32: tries BurntToast (powershell) then msg.exe", () => {
    const { spawner, calls } = makeSpawner();
    const { stderr } = makeStderr();
    notify({
      level: "info",
      title: "Ralph complete",
      body: "done",
      platform: "win32",
      spawner,
      stderr,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe("powershell");
    expect(calls[0].args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      expect.stringContaining("BurntToast"),
    ]);
    expect(calls[1].command).toBe("msg.exe");
    expect(calls[1].args).toEqual(["*", "Ralph complete: done"]);
  });

  it("missing utility (spawner throws ENOENT): bell still fires, no crash", () => {
    const spawner: NotifySpawner = () => {
      const err = new Error(
        "spawn notify-send ENOENT"
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const { stderr, writes } = makeStderr();
    expect(() =>
      notify({
        level: "info",
        title: "t",
        body: "b",
        platform: "linux",
        spawner,
        stderr,
      })
    ).not.toThrow();
    expect(writes).toContain("\x07");
  });

  it("unsupported platform: bell-only, no spawn attempt, no crash", () => {
    const { spawner, calls } = makeSpawner();
    const { stderr, writes } = makeStderr();
    notify({
      level: "info",
      title: "t",
      body: "b",
      platform: "freebsd" as NodeJS.Platform,
      spawner,
      stderr,
    });
    expect(calls).toHaveLength(0);
    expect(writes).toContain("\x07");
  });

  it("body containing single quotes is safely escaped on darwin", () => {
    const { spawner, calls } = makeSpawner();
    const { stderr } = makeStderr();
    notify({
      level: "info",
      title: "title",
      body: `hit "the" sentinel`,
      platform: "darwin",
      spawner,
      stderr,
    });
    expect(calls[0].args[1]).toContain('hit \\"the\\" sentinel');
  });
});
