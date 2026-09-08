import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectSandboxInstall } from "../host-check.js";

const roots: string[] = [];

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-host-check-"));
  roots.push(root);
  return root;
}

/** Write `<root>/node_modules/.modules.yaml` with the given body. */
function writeModulesYaml(root: string, body: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".modules.yaml"), body, "utf8");
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("detectSandboxInstall", () => {
  it("finds nothing in an empty workspace", () => {
    expect(detectSandboxInstall(makeWorkspace())).toEqual([]);
  });

  it("accepts a host store path", () => {
    const root = makeWorkspace();
    writeModulesYaml(
      root,
      [
        "hoistPattern:",
        "  - '*'",
        "storeDir: D:\\.pnpm-store\\v3",
        "virtualStoreDir: node_modules/.pnpm",
        "",
      ].join("\n")
    );
    expect(detectSandboxInstall(root)).toEqual([]);
  });

  it("reports a store path under the sandbox home", () => {
    const root = makeWorkspace();
    writeModulesYaml(
      root,
      "storeDir: /home/agent/workspace/.pnpm-store/v3\nnodeLinker: isolated\n"
    );
    expect(detectSandboxInstall(root)).toEqual([
      "node_modules/.modules.yaml storeDir: /home/agent/workspace/.pnpm-store/v3",
    ]);
  });

  it("reports a stray .pnpm-store at the workspace root", () => {
    const root = makeWorkspace();
    mkdirSync(join(root, ".pnpm-store"));
    expect(detectSandboxInstall(root)).toEqual([
      ".pnpm-store/ present at the workspace root",
    ]);
  });

  it("reports both fingerprints, .modules.yaml first", () => {
    const root = makeWorkspace();
    writeModulesYaml(root, "storeDir: /home/agent/workspace/.pnpm-store/v3\n");
    mkdirSync(join(root, ".pnpm-store"));
    expect(detectSandboxInstall(root)).toEqual([
      "node_modules/.modules.yaml storeDir: /home/agent/workspace/.pnpm-store/v3",
      ".pnpm-store/ present at the workspace root",
    ]);
  });

  it("finds nothing when .modules.yaml carries no storeDir line", () => {
    const root = makeWorkspace();
    writeModulesYaml(root, "hoistPattern:\n  - '*'\nnodeLinker: isolated\n");
    expect(detectSandboxInstall(root)).toEqual([]);
  });

  it("swallows a read error when .modules.yaml is a directory", () => {
    const root = makeWorkspace();
    mkdirSync(join(root, "node_modules", ".modules.yaml"), { recursive: true });
    expect(() => detectSandboxInstall(root)).not.toThrow();
    expect(detectSandboxInstall(root)).toEqual([]);
  });
});
