import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isolationEnabled,
  missingVolumes,
  resolveSandboxVolumes,
  sandboxRunArgs,
} from "../sandbox-volumes.js";

const KNOB = "RALPH_ISOLATE_NODE_MODULES";
const original = process.env[KNOB];
const roots: string[] = [];

/** A temp workspace holding a `package.json` at each given POSIX relative path. */
function makeWorkspace(packagePaths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-sandbox-volumes-"));
  roots.push(root);
  for (const relPath of packagePaths) {
    const dir = relPath === "." ? root : join(root, ...relPath.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
  }
  return root;
}

function setKnob(value: string | undefined): void {
  if (value === undefined) delete process.env[KNOB];
  else process.env[KNOB] = value;
}

afterEach(() => {
  setKnob(original);
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("isolationEnabled", () => {
  it("follows the platform when the variable is unset", () => {
    setKnob(undefined);
    expect(isolationEnabled("linux")).toBe(false);
    expect(isolationEnabled("win32")).toBe(true);
    expect(isolationEnabled("darwin")).toBe(true);
  });

  it('honours "0" and "1" on any platform', () => {
    setKnob("0");
    expect(isolationEnabled("win32")).toBe(false);
    setKnob("1");
    expect(isolationEnabled("linux")).toBe(true);
  });

  it("trims the value", () => {
    setKnob(" 1 ");
    expect(isolationEnabled("linux")).toBe(true);
  });

  it("falls back to the platform on an unrecognised value", () => {
    setKnob("yes");
    expect(isolationEnabled("linux")).toBe(false);
    expect(isolationEnabled("win32")).toBe(true);
  });
});

describe("resolveSandboxVolumes", () => {
  it("gives a single-package workspace its node_modules and the store", () => {
    setKnob("1");
    const root = makeWorkspace(["."]);
    const volumes = resolveSandboxVolumes(root);

    expect(volumes).toHaveLength(2);
    expect(volumes[0].containerPath).toBe("/home/agent/workspace/node_modules");
    expect(volumes[0].name).toMatch(/^ralph-nm-[0-9a-f]{16}$/);
    expect(volumes[0].labels).toEqual([
      "ralph.kind=node-modules",
      `ralph.workspace=${root}`,
      "ralph.path=.",
    ]);
    expect(volumes[1]).toEqual({
      name: "ralph-pm-store",
      containerPath: "/home/agent/.pm-store",
      labels: ["ralph.kind=pm-store"],
    });
  });

  it("covers every package directory, root first then lexicographic", () => {
    setKnob("1");
    const root = makeWorkspace([".", "packages/b", "packages/a"]);

    expect(resolveSandboxVolumes(root).map((v) => v.containerPath)).toEqual([
      "/home/agent/workspace/node_modules",
      "/home/agent/workspace/packages/a/node_modules",
      "/home/agent/workspace/packages/b/node_modules",
      "/home/agent/.pm-store",
    ]);
  });

  it("skips node_modules, dot directories and anything below the depth cap", () => {
    setKnob("1");
    const root = makeWorkspace([
      ".",
      "node_modules/pkg",
      ".hidden/pkg",
      "a/b/c/d/e",
    ]);

    expect(resolveSandboxVolumes(root).map((v) => v.containerPath)).toEqual([
      "/home/agent/workspace/node_modules",
      "/home/agent/.pm-store",
    ]);
  });

  it("still reaches a package four levels below the root", () => {
    setKnob("1");
    const root = makeWorkspace([".", "a/b/c/d"]);

    expect(resolveSandboxVolumes(root).map((v) => v.containerPath)).toEqual([
      "/home/agent/workspace/node_modules",
      "/home/agent/workspace/a/b/c/d/node_modules",
      "/home/agent/.pm-store",
    ]);
  });

  it("returns nothing for a workspace with no package.json", () => {
    setKnob("1");
    const root = makeWorkspace([]);
    mkdirSync(join(root, "src"));

    expect(resolveSandboxVolumes(root)).toEqual([]);
  });

  it("returns nothing when isolation is off", () => {
    setKnob("0");
    expect(resolveSandboxVolumes(makeWorkspace(["."]))).toEqual([]);
  });

  it("names volumes stably per workspace and path", () => {
    setKnob("1");
    const root = makeWorkspace([".", "packages/a"]);
    const other = makeWorkspace([".", "packages/a"]);

    const first = resolveSandboxVolumes(root);
    const again = resolveSandboxVolumes(root);
    expect(first.map((v) => v.name)).toEqual(again.map((v) => v.name));
    expect(first[0].name).not.toBe(first[1].name);
    expect(first[1].name).not.toBe(resolveSandboxVolumes(other)[1].name);
  });
});

describe("sandboxRunArgs", () => {
  it("is empty for an empty volume list", () => {
    expect(sandboxRunArgs([])).toEqual([]);
  });

  it("mounts every volume and points the store at the store volume", () => {
    setKnob("1");
    const volumes = resolveSandboxVolumes(makeWorkspace([".", "packages/a"]));

    expect(sandboxRunArgs(volumes)).toEqual([
      "-v",
      `${volumes[0].name}:/home/agent/workspace/node_modules`,
      "-v",
      `${volumes[1].name}:/home/agent/workspace/packages/a/node_modules`,
      "-v",
      "ralph-pm-store:/home/agent/.pm-store",
      "-e",
      "npm_config_store_dir=/home/agent/.pm-store/pnpm",
      "-e",
      "npm_config_cache=/home/agent/.pm-store/npm",
    ]);
  });
});

describe("missingVolumes", () => {
  it("is the set difference by name, in input order", () => {
    setKnob("1");
    const volumes = resolveSandboxVolumes(makeWorkspace([".", "packages/a"]));

    expect(missingVolumes([], volumes)).toEqual(volumes);
    expect(
      missingVolumes(
        volumes.map((v) => v.name),
        volumes
      )
    ).toEqual([]);
    expect(missingVolumes([volumes[0].name], volumes)).toEqual(
      volumes.slice(1)
    );
  });
});
