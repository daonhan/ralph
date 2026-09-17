import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return { ...actual, spawnSync: spawnSyncMock };
});

import { parseRunContainers, runningRunContainers } from "../runner.js";

describe("parseRunContainers", () => {
  it("reads a runId and a container name per line", () => {
    expect(
      parseRunContainers(
        "2026-09-17-101500-ghafk ralph-2026-09-17-101500-ghafk-i1-s0-a1\r\n\r\n" +
          "2026-09-17-120000-afk-main ralph-2026-09-17-120000-afk-main-i2-s1-a1\n"
      )
    ).toEqual([
      {
        runId: "2026-09-17-101500-ghafk",
        name: "ralph-2026-09-17-101500-ghafk-i1-s0-a1",
      },
      {
        runId: "2026-09-17-120000-afk-main",
        name: "ralph-2026-09-17-120000-afk-main-i2-s1-a1",
      },
    ]);
  });

  it("skips lines that do not carry both", () => {
    expect(parseRunContainers("   \n2026-09-17-101500-ghafk\n")).toEqual([]);
  });
});

describe("runningRunContainers", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("lists the running containers labelled with a run", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout:
        "2026-09-17-101500-ghafk ralph-2026-09-17-101500-ghafk-i1-s0-a1\n",
    });

    expect(runningRunContainers()).toEqual([
      {
        runId: "2026-09-17-101500-ghafk",
        name: "ralph-2026-09-17-101500-ghafk-i1-s0-a1",
      },
    ]);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "docker",
      [
        "ps",
        "--filter",
        "label=ralph.run",
        "--format",
        '{{.Label "ralph.run"}} {{.Names}}',
      ],
      expect.objectContaining({ timeout: 10_000 })
    );
  });

  it.each([
    ["the docker CLI is missing", { error: new Error("ENOENT"), status: null }],
    ["the daemon is down", { status: 1, stdout: "" }],
    ["docker ps timed out", { error: new Error("ETIMEDOUT"), status: null }],
  ])("reports none when %s", (_why, result) => {
    spawnSyncMock.mockReturnValue(result);
    expect(runningRunContainers()).toEqual([]);
  });
});
