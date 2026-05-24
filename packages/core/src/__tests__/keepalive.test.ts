import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { acquire, type SpawnedChild, type Spawner } from "../keepalive.js";

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: { detached?: boolean; stdio?: "ignore" };
  child: FakeChild;
};

class FakeChild extends EventEmitter {
  public pid = 12345;
  public kill = vi.fn();
}

function makeSpawner(): { spawner: Spawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawner: Spawner = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child as unknown as SpawnedChild;
  };
  return { spawner, calls };
}

describe("acquire", () => {
  it("windows: spawns powershell with SetThreadExecutionState script", () => {
    const { spawner, calls } = makeSpawner();
    const warn = vi.fn();
    const releaser = acquire({ platform: "win32", spawner, warn });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("powershell");
    expect(calls[0].args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      expect.stringContaining("SetThreadExecutionState"),
    ]);
    expect(warn).not.toHaveBeenCalled();

    releaser.release();
    expect(calls[0].child.kill).toHaveBeenCalledTimes(1);
  });

  it("darwin: spawns caffeinate -i -w <pid>", () => {
    const { spawner, calls } = makeSpawner();
    const releaser = acquire({
      platform: "darwin",
      spawner,
      parentPid: 4242,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("caffeinate");
    expect(calls[0].args).toEqual(["-i", "-w", "4242"]);

    releaser.release();
    expect(calls[0].child.kill).toHaveBeenCalledTimes(1);
  });

  it("linux: spawns systemd-inhibit with --what=sleep", () => {
    const { spawner, calls } = makeSpawner();
    const releaser = acquire({
      platform: "linux",
      spawner,
      reason: "test-run",
      wslHint: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("systemd-inhibit");
    expect(calls[0].args).toEqual([
      "--what=sleep",
      "--why=test-run",
      "--mode=block",
      "sleep",
      "infinity",
    ]);

    releaser.release();
    expect(calls[0].child.kill).toHaveBeenCalledTimes(1);
  });

  it("WSL2: emits a warning and still runs the linux path", () => {
    const { spawner, calls } = makeSpawner();
    const warn = vi.fn();
    acquire({
      platform: "linux",
      spawner,
      wslHint: () => true,
      warn,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/WSL2/);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("systemd-inhibit");
  });

  it("missing utility (ENOENT): warns once and returns a safe no-op releaser", () => {
    const warn = vi.fn();
    const spawner: Spawner = () => {
      const err = new Error("spawn caffeinate ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };

    const releaser = acquire({ platform: "darwin", spawner, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/caffeinate not found/);
    expect(() => releaser.release()).not.toThrow();
  });

  it("unsupported platform: warns and returns a no-op releaser", () => {
    const warn = vi.fn();
    const { spawner, calls } = makeSpawner();
    const releaser = acquire({
      platform: "freebsd" as NodeJS.Platform,
      spawner,
      warn,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/unsupported platform/);
    expect(calls).toHaveLength(0);
    expect(() => releaser.release()).not.toThrow();
  });

  it("release is idempotent: kill only fires once", () => {
    const { spawner, calls } = makeSpawner();
    const releaser = acquire({ platform: "darwin", spawner });
    releaser.release();
    releaser.release();
    expect(calls[0].child.kill).toHaveBeenCalledTimes(1);
  });

  it("warns when the wake-lock child exits before release", () => {
    const { spawner, calls } = makeSpawner();
    const warn = vi.fn();
    acquire({ platform: "linux", spawner, warn, wslHint: () => false });

    calls[0].child.emit("close", 1, null);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/exited early/);
    expect(warn.mock.calls[0][0]).toMatch(/continuing without wake-lock/);
  });
});
