# Drop Docker → Host-First Native-Sandbox Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ralph's Docker sandbox with Claude Code's native OS (Seatbelt) sandbox, running `claude` directly on the host, and delete all Docker plumbing.

**Architecture:** `runStage` spawns `claude --print …` with `cwd = workspaceDir` instead of `docker run …`. A new `RALPH_RUNNER` selects `sandbox` (default — writes a transient `--settings` JSON enabling the Seatbelt sandbox with writes confined to the workspace) or `host` (no sandbox, bare while-loop). `ensureImage`, socket detection, credential mounts, and the image/Dockerfile/CI are removed.

**Tech Stack:** Node ≥20 ESM, TypeScript (NodeNext), vitest. macOS primary (Seatbelt). Relative `src/` imports end in `.js`.

**Spec:** `docs/superpowers/specs/2026-06-14-drop-docker-native-sandbox-design.md`

---

## File Structure

| File | Responsibility after this change |
| --- | --- |
| `packages/core/src/runner.ts` | Spawn `claude` + stream NDJSON. Holds `resolveRunner`, `resolveSandboxNet`, `buildSandboxSettings`, `buildClaudeArgs`, `runStage`, `streamClaude`, `parseGraceMs`, `resolveModelArgs`, `stageLogPath`. No Docker. |
| `packages/core/src/loop.ts` | Iteration driver. No `ensureImage`, no `ralphDir`. |
| `packages/core/src/run-bin.ts` | Resolve dirs (no `ralphDir`), drive `runLoop`. |
| `packages/core/src/cli-help.ts` | Flags + `--help`/`--print-config` (runner/sandbox-net, no Docker). |
| `packages/core/src/stages.ts` | Stage table; updated blast-radius comment. |
| `packages/core/src/index.ts` | Public exports (drop `ensureImage`). |
| `packages/core/templates/{prompt,review}.md` | Playbooks minus the MSB3248 virtiofs workaround. |
| Deleted | `templates/Dockerfile`, `templates/CHANGELOG.md`, `.github/workflows/publish-image.yml`, release-please `ralph-sandbox` component, SECURITY.md docker.sock section. |

---

## Task 1: Probe the installed `claude` sandbox surface (verification only — no code)

**Files:** none.

- [ ] **Step 1: Confirm `--settings` accepts a path and discover sandbox keys**

Run:
```bash
claude --help 2>&1 | grep -iE "settings|sandbox|permission-mode" || echo "no match"
claude --version
```

- [ ] **Step 2: Record the decision rules**

Confirm and note in the PR description:
1. `--settings <file>` is accepted (a JSON file path). If only `--settings <json>` inline is supported, `runStage` will pass inline JSON instead of a temp-file path — the rest of the plan is unchanged except `buildSandboxSettings` output is `JSON.stringify`'d straight into the arg.
2. Default network behavior when the settings JSON has **no** `sandbox.network` block. Expected/desired: network unrestricted. If the installed version instead **prompts** on first domain (which would stall a non-interactive run), set the `RALPH_SANDBOX_NET` default in Task 2's `resolveSandboxNet` to a baked-in allowlist `["api.anthropic.com", "github.com", "registry.npmjs.org", "*.nuget.org"]` rather than `[]`. Otherwise keep `[]` (truly unrestricted).

Expected: both confirmed before writing code. This task gates the network default chosen in Task 2.

---

## Task 2: Runner-selection + sandbox-settings helpers (TDD)

**Files:**
- Modify: `packages/core/src/runner.ts`
- Test: `packages/core/src/__tests__/runner.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `runner.test.ts`:

```ts
import {
  buildSandboxSettings,
  resolveRunner,
  resolveSandboxNet,
} from "../runner.js";

describe("resolveRunner", () => {
  it("defaults to sandbox when unset", () => {
    expect(resolveRunner(undefined)).toBe("sandbox");
  });
  it("defaults to sandbox for empty / unknown values", () => {
    expect(resolveRunner("")).toBe("sandbox");
    expect(resolveRunner("docker")).toBe("sandbox");
  });
  it("selects host only for the literal 'host'", () => {
    expect(resolveRunner("host")).toBe("host");
    expect(resolveRunner("  host  ")).toBe("host");
  });
});

describe("resolveSandboxNet", () => {
  it("returns [] when unset or empty", () => {
    expect(resolveSandboxNet(undefined)).toEqual([]);
    expect(resolveSandboxNet("   ")).toEqual([]);
  });
  it("splits, trims, and drops empties", () => {
    expect(resolveSandboxNet("github.com, api.anthropic.com,")).toEqual([
      "github.com",
      "api.anthropic.com",
    ]);
  });
});

describe("buildSandboxSettings", () => {
  it("confines writes to the workspace and omits network when no domains", () => {
    expect(buildSandboxSettings("/ws", [])).toEqual({
      sandbox: { enabled: true, filesystem: { allowWrite: ["/ws"] } },
    });
  });
  it("adds an allowedDomains network block when domains are given", () => {
    expect(buildSandboxSettings("/ws", ["github.com"])).toEqual({
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: ["/ws"] },
        network: { allowedDomains: ["github.com"] },
      },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @daonhan/ralph-core test -- runner`
Expected: FAIL — `resolveRunner`/`resolveSandboxNet`/`buildSandboxSettings` are not exported.

- [ ] **Step 3: Implement the helpers**

Add to `runner.ts` (near `resolveModelArgs`):

```ts
export type Runner = "sandbox" | "host";

/** `RALPH_RUNNER=host` → bare host run; anything else (incl. unset) → sandbox. */
export function resolveRunner(raw: string | undefined): Runner {
  return raw?.trim() === "host" ? "host" : "sandbox";
}

/** Parse `RALPH_SANDBOX_NET` into a domain allowlist. Empty = unrestricted. */
export function resolveSandboxNet(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Claude Code native-sandbox settings: confine writes to the workspace. When
 * `allowedDomains` is non-empty, also restrict network egress to that list;
 * otherwise leave network unrestricted (filesystem is the blast-radius control).
 */
export function buildSandboxSettings(
  workspaceDir: string,
  allowedDomains: string[]
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    enabled: true,
    filesystem: { allowWrite: [workspaceDir] },
  };
  if (allowedDomains.length > 0) {
    sandbox.network = { allowedDomains };
  }
  return { sandbox };
}
```

> If Task 1 found that an absent network block causes prompts, change `resolveSandboxNet`'s `if (!raw) return [];` to `return ["api.anthropic.com", "github.com", "registry.npmjs.org", "*.nuget.org"];`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @daonhan/ralph-core test -- runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runner.ts packages/core/src/__tests__/runner.test.ts
git commit -m "feat(runner): add runner-selection + sandbox-settings helpers"
```

---

## Task 3: Teach `buildClaudeArgs` to inject `--settings` (TDD)

**Files:**
- Modify: `packages/core/src/runner.ts:392-412`
- Test: `packages/core/src/__tests__/runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("buildClaudeArgs", …)` block:

```ts
  it("injects --settings before the prompt when a settings path is given", () => {
    const args = buildClaudeArgs(stage, promptPath, [], "/ws/.ralph-tmp/s.json");
    const sIdx = args.indexOf("--settings");
    expect(sIdx).toBeGreaterThan(-1);
    expect(args[sIdx + 1]).toBe("/ws/.ralph-tmp/s.json");
    const promptIdx = args.findIndex((a) => a.includes(promptPath));
    expect(sIdx).toBeLessThan(promptIdx);
  });

  it("omits --settings when no settings path is given", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--settings");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @daonhan/ralph-core test -- runner`
Expected: FAIL — `buildClaudeArgs` ignores the 4th arg.

- [ ] **Step 3: Update `buildClaudeArgs`**

Replace the current function body with (note the renamed param + new optional `settingsPath`):

```ts
export function buildClaudeArgs(
  stage: Stage,
  promptRelPath: string,
  modelArgs: string[],
  settingsPath?: string
): string[] {
  const args = [
    "claude",
    "--verbose",
    "--print",
    "--output-format",
    "stream-json",
  ];
  if (stage.permissionMode) {
    args.push("--permission-mode", stage.permissionMode);
  }
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }
  args.push(...modelArgs);
  args.push(
    `Read the full instructions from the file ./${promptRelPath} in the current workspace and execute them.`
  );
  return args;
}
```

- [ ] **Step 4: Run to verify all `buildClaudeArgs` tests pass**

Run: `pnpm --filter @daonhan/ralph-core test -- runner`
Expected: PASS (existing argv tests unaffected — `--settings` slots between `--permission-mode` and `--model`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runner.ts packages/core/src/__tests__/runner.test.ts
git commit -m "feat(runner): inject --settings into the claude argv"
```

---

## Task 4: Rewrite `runStage` to spawn `claude` (replace `streamDocker`)

**Files:**
- Modify: `packages/core/src/runner.ts:414-633`

No new unit test (these are integration-spawning paths; covered by the loop tests + the smoke test in Task 13). The pure argv/settings logic is already tested in Tasks 2–3.

- [ ] **Step 1: Replace the `runStage` body**

Replace the whole `runStage` function (keep the exported signature — `loop.ts` and `loop.test.ts` call it with 7 positional args) with:

```ts
export async function runStage(
  stage: Stage,
  renderedPrompt: string,
  workspaceDir: string,
  iteration: number,
  spillHostDir?: string,
  logPathOverride?: string,
  options: RunStageOptions = {}
): Promise<string> {
  const tmpHostDir = join(workspaceDir, ".ralph-tmp");
  mkdirSync(tmpHostDir, { recursive: true });

  const logsDir = join(tmpHostDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath =
    logPathOverride ?? stageLogPath(workspaceDir, iteration, stage.name);

  const promptName = `.run-${process.pid}-${iteration}-${Date.now()}.md`;
  const promptHostPath = join(tmpHostDir, promptName);
  const promptRelPath = posix.join(".ralph-tmp", promptName);
  writeFileSync(promptHostPath, renderedPrompt, "utf8");

  let settingsHostPath: string | undefined;
  if (resolveRunner(process.env.RALPH_RUNNER) === "sandbox") {
    const settings = buildSandboxSettings(
      workspaceDir,
      resolveSandboxNet(process.env.RALPH_SANDBOX_NET)
    );
    settingsHostPath = join(
      tmpHostDir,
      `.sandbox-${process.pid}-${iteration}-${Date.now()}.json`
    );
    writeFileSync(settingsHostPath, JSON.stringify(settings), "utf8");
  }

  process.stderr.write(`${dim("log → " + logPath)}\n`);

  try {
    const argv = buildClaudeArgs(
      stage,
      promptRelPath,
      resolveModelArgs(process.env.RALPH_MODEL),
      settingsHostPath
    );
    return await streamClaude(argv, workspaceDir, logPath, options);
  } finally {
    rmSync(promptHostPath, { force: true });
    if (settingsHostPath) rmSync(settingsHostPath, { force: true });
    if (spillHostDir) rmSync(spillHostDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Rename `streamDocker` → `streamClaude` and spawn `claude`**

Replace the `streamDocker` function signature + spawn call. The body is identical to the current `streamDocker` EXCEPT the three marked lines:

```ts
function streamClaude(
  argv: string[],
  cwd: string,
  logPath: string,
  options: RunStageOptions = {}
): Promise<string> {
  if (options.signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const logFd = openSync(logPath, "a");
    const toolMap = new Map<string, ToolTrack>();
    const graceMs = parseGraceMs(process.env.RALPH_RESULT_GRACE_MS);

    // CHANGED: spawn claude (argv[0]) on the host instead of `docker`.
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // … identical to the current streamDocker body from `let finalResult = "";`
    // down to the end, with TWO label changes:
    //   • the stderr line prefix: `dim("claude  " + line)` (was "docker  ")
    //   • the close-handler error: `new Error(`claude exited with ${code}\n…`)`
  });
}
```

Apply the same `finalResult`/grace-timer/abort/readline/close logic verbatim from the old `streamDocker` (lines ~518–632), changing only the stderr prefix string `"docker  "` → `"claude  "` and the exit-error string `"docker run exited with"` → `"claude exited with"`.

- [ ] **Step 3: Verify typecheck (will still error until Task 5 deletes the now-orphaned Docker code)**

Run: `pnpm --filter @daonhan/ralph-core typecheck`
Expected: errors ONLY about unused Docker symbols (`spawnSync`, `statSync`, etc.) — resolved in Task 5. Do not commit yet; bundle with Task 5.

---

## Task 5: Delete the Docker plumbing from `runner.ts` + fix exports

**Files:**
- Modify: `packages/core/src/runner.ts`
- Modify: `packages/core/src/index.ts:6`

- [ ] **Step 1: Delete the Docker-only symbols from `runner.ts`**

Remove entirely: `IMAGE_REF`, `dockerSockWarned`, `detectDockerSocketPath`, `parseDockerHost`, `resolveDockerSocketMount`, `isFloatingRef`, `resolveDockerfile`, `resolveBuildAfterPullFail`, `runDockerCommand`, `DockerCommandOptions`, `ensureImageSync`, `ensureImageAsync`, the `ensureImage` overloads, and `STDERR_TAIL_LINES`/`DEFAULT_RESULT_GRACE_MS` only if now unused (`DEFAULT_RESULT_GRACE_MS` is still used by `parseGraceMs` — keep it; `STDERR_TAIL_LINES` is still used by `streamClaude` — keep it). Keep `abortError` (used by `streamClaude`).

- [ ] **Step 2: Prune now-unused imports**

Update the top-of-file imports so only what remains is imported:
- `node:child_process` → `{ spawn }` (drop `spawnSync`).
- `node:fs` → `{ appendFileSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync }` (drop `existsSync`, `statSync`).
- `./stream-render.js` → `{ dim, renderEvent, SYM, type StreamJson, type ToolTrack }` — drop `bold`, `red` if no longer referenced (they were only used by the removed docker.sock warning). Verify with a grep below.

- [ ] **Step 3: Fix the barrel export**

In `index.ts` line 6, drop `ensureImage`:

```ts
export { runStage } from "./runner.js";
```

- [ ] **Step 4: Verify no dangling references**

Run:
```bash
grep -rnE "ensureImage|IMAGE_REF|resolveDockerfile|detectDockerSocketPath|resolveDockerSocketMount|isFloatingRef" packages/core/src apps/cli || echo "clean"
pnpm --filter @daonhan/ralph-core typecheck
```
Expected: `clean` from grep (except matches inside `cli-help.ts`/`loop.ts`, fixed in Tasks 6–8) and typecheck passes once those are done. If `cli-help.ts`/`loop.ts` still reference them, proceed to Tasks 6–8 before committing.

- [ ] **Step 5: Commit (bundled with Task 4)**

```bash
git add packages/core/src/runner.ts packages/core/src/index.ts
git commit -m "refactor(runner): spawn claude on the host, delete all docker plumbing"
```

---

## Task 6: Drop `ensureImage`/`ralphDir` from the loop (TDD)

**Files:**
- Modify: `packages/core/src/loop.ts`
- Modify: `packages/core/src/__tests__/loop.test.ts`

- [ ] **Step 1: Update the loop test mocks + options**

In `loop.test.ts`:

(a) Remove `ensureImage` from the hoisted mocks object (lines 14–21) and from the `vi.mock("../runner.js", …)` factory (lines 32–42) — leave `runStage` + `stageLogPath`.

(b) In `loopOptions` (lines 86–96), delete the `ralphDir: dirs.ralphDir,` line. In `LoopDirs`/`makeDirs`, delete `ralphDir` (lines 64, 70, 75) — it is no longer used.

(c) Replace the test `"acquires the wake-lock before image setup and releases on completion"` (lines 117–135) with:

```ts
  it("acquires the wake-lock and releases on completion", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(sentinel);

    await runLoop(loopOptions(dirs, { notify: true }));

    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.notifyComplete).toHaveBeenCalledWith(1, true);
  });
```

(d) Replace the test `"aborts image setup and releases the wake-lock on SIGTERM"` (lines 265–295) with a SIGTERM-aborts-active-stage test mirroring the SIGINT one:

```ts
  it("aborts the active stage and releases the wake-lock on SIGTERM", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    let capturedSignal: AbortSignal | undefined;
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) => {
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          capturedSignal!.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      }
    );

    const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    expect(() => process.emit("SIGTERM")).toThrow("exit 143");
    expect(capturedSignal?.aborted).toBe(true);
    await loop;
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @daonhan/ralph-core test -- loop`
Expected: FAIL — `runLoop` still calls `ensureImage` / `LoopOptions` still requires `ralphDir`.

- [ ] **Step 3: Update `loop.ts`**

(a) Remove the `ensureImage` import (line 14 — change `import { ensureImage, runStage, stageLogPath }` to `import { runStage, stageLogPath }`).

(b) In `LoopOptions`, delete the `ralphDir` field + its doc comment (lines 38–39).

(c) In the `runLoop` destructure, delete `ralphDir,` (line 61).

(d) Delete the `await ensureImage(ralphDir, { signal: stageAbort.signal });` line (line 111).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @daonhan/ralph-core test -- loop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop.ts packages/core/src/__tests__/loop.test.ts
git commit -m "refactor(loop): drop image setup and ralphDir; sandbox needs no image"
```

---

## Task 7: Drop `ralphDir`/`RALPH_DOCKER_CONTEXT` from `run-bin.ts`

**Files:**
- Modify: `packages/core/src/run-bin.ts`

- [ ] **Step 1: Remove the ralphDir resolution + pass-through**

(a) Delete line 54: `const ralphDir = resolve(process.env.RALPH_DOCKER_CONTEXT ?? packageDir);`

(b) Update the `printConfig` call (lines 62–70) to drop the `ralphDir` argument:

```ts
    printConfig(cfg.bin, workspaceDir, packageDir, {
      cliVersion: cfg.cliVersion,
      noKeepAlive: flags.noKeepAlive,
      maxRetries: flags.maxRetries,
      detach: flags.detach,
      detachLogPath,
      notify: flags.notify,
    });
```

(c) In the `runLoop({…})` call (lines 94–106), delete the `ralphDir,` line.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @daonhan/ralph-core typecheck`
Expected: errors only in `cli-help.ts` (printConfig signature) — fixed next. Do not commit until Task 8.

---

## Task 8: Update `cli-help.ts` (`--print-config` + `--help`)

**Files:**
- Modify: `packages/core/src/cli-help.ts`

- [ ] **Step 1: Remove Docker imports**

Delete the `IMAGE_REF, detectDockerSocketPath, resolveDockerSocketMount, resolveDockerfile` import from `./runner.js` (lines 6–11). `cli-help.ts` then imports only `DEFAULT_MAX_RETRIES` from `./retry.js` and node builtins it still uses. Remove `existsSync`/`fileURLToPath`/`join`/`dirname` only if they become unused (`readCoreVersion` still uses `readFileSync`, `dirname`, `join`, `fileURLToPath` — keep those; `existsSync` becomes unused — remove it).

- [ ] **Step 2: Rewrite `printConfig`**

Replace the whole `printConfig` (and its `PrintConfigOptions` stays as-is) with a Docker-free version. New signature drops `ralphDir`:

```ts
export function printConfig(
  bin: string,
  workspaceDir: string,
  packageDir: string,
  opts: PrintConfigOptions = {}
): void {
  const {
    cliVersion,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    detach = false,
    detachLogPath,
    notify = false,
  } = opts;
  const core = readCoreVersion();
  const cli = cliVersion ?? "?";

  const runner = process.env.RALPH_RUNNER?.trim() === "host" ? "host" : "sandbox";
  const rawNet = process.env.RALPH_SANDBOX_NET?.trim();
  const netStatus =
    runner === "host"
      ? "n/a (host runner)"
      : rawNet
        ? `restricted to: ${rawNet}`
        : "unrestricted (filesystem-only sandbox)";

  const keepAliveStatus = noKeepAlive ? "off" : "on (system sleep only)";
  const detachStatus =
    detach && detachLogPath ? `on (log: ${detachLogPath})` : "off";
  const notifyStatus = notify ? "on" : "off";
  const rawModel = process.env.RALPH_MODEL;
  const modelStatus =
    rawModel && rawModel.trim() !== ""
      ? `${rawModel.trim()} (RALPH_MODEL)`
      : "claude CLI default (RALPH_MODEL unset)";

  process.stdout.write(`[${bin}] resolved config
  version               ${bin} ${cli} (core ${core})
  RALPH_WORKSPACE       ${workspaceDir}${process.env.RALPH_WORKSPACE ? "" : "  (default: cwd)"}
  packageDir            ${packageDir}
  RALPH_RUNNER          ${runner}${process.env.RALPH_RUNNER ? "" : "  (default)"}
  sandbox network       ${netStatus}
  model                 ${modelStatus}
  keep-alive            ${keepAliveStatus}
  max-retries           ${maxRetries}
  detach                ${detachStatus}
  notify                ${notifyStatus}
`);
}
```

- [ ] **Step 3: Update `printHelp`**

In the `--print-config` flag line, change "resolve workspace / docker context / image / docker socket, print, exit without launching docker" → "resolve workspace / runner / sandbox config, print, and exit".

Replace the entire `Environment variables:` block (and the trailing `Image resolution:` paragraph) with:

```
Environment variables:
  RALPH_WORKSPACE   host dir Claude runs against (default: cwd)
  RALPH_RUNNER      "sandbox" (default) runs claude in the native OS sandbox with
                    writes confined to the workspace; "host" runs claude unsandboxed
                    (bare while-loop — only safe in a throwaway tree).
  RALPH_SANDBOX_NET comma-separated domain allowlist for sandbox network egress.
                    Unset = unrestricted (filesystem is the blast-radius control).
  RALPH_MODEL       pin the claude model ("--model <value>" pass-through). Unset =
                    claude CLI default. The claude CLI validates the value.
  RALPH_RESULT_GRACE_MS  post-result grace timer ms (default 30000; 0 disables).
```

- [ ] **Step 4: Typecheck + commit (bundles Task 7)**

Run: `pnpm -r typecheck`
Expected: PASS.

```bash
git add packages/core/src/run-bin.ts packages/core/src/cli-help.ts
git commit -m "refactor(cli): print runner/sandbox config; drop docker env + flags"
```

---

## Task 9: Update the `stages.ts` blast-radius comment

**Files:**
- Modify: `packages/core/src/stages.ts:7-15`

- [ ] **Step 1: Replace the comment block**

Replace the `// All stages run inside the ephemeral ralph-sandbox container …` comment (lines 7–15) with:

```ts
// Every stage runs `claude --permission-mode bypassPermissions` so bash + edits
// auto-approve for non-interactive AFK. Blast radius is bounded by the runner
// (see resolveRunner in runner.ts): the default `sandbox` runner confines writes
// to the workspace via the native OS sandbox; `RALPH_RUNNER=host` runs unsandboxed
// (git-recoverable workspace only). See the spec under docs/superpowers/specs/.
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm -r typecheck`
Expected: PASS.

```bash
git add packages/core/src/stages.ts
git commit -m "docs(stages): describe sandbox/host runner blast radius"
```

---

## Task 10: Remove the MSB3248 virtiofs workaround from the playbooks

**Files:**
- Modify: `packages/core/templates/prompt.md:48-60`
- Modify: `packages/core/templates/review.md:44` (the parenthetical)

- [ ] **Step 1: Delete the workaround from `prompt.md`**

Remove the block starting `**If \`dotnet test\` or \`dotnet build\` fails with MSB3248** …` through the closing fenced code block and the "Only if that second attempt also fails …" line (lines 49–60). Leave the `### Backend / Dotnet` bullets (`dotnet test`, `dotnet build`) intact.

- [ ] **Step 2: Simplify the `review.md` dotnet line**

Change `\`dotnet test\`, \`dotnet build\` (apply MSB3248 workaround from the implementer playbook if it triggers)` → `\`dotnet test\`, \`dotnet build\``.

- [ ] **Step 3: Commit**

```bash
git add packages/core/templates/prompt.md packages/core/templates/review.md
git commit -m "docs(templates): drop MSB3248 virtiofs workaround (no docker mount)"
```

---

## Task 11: Delete the image, Dockerfile, and CI

**Files:**
- Delete: `packages/core/templates/Dockerfile`
- Delete: `packages/core/templates/CHANGELOG.md`
- Delete: `.github/workflows/publish-image.yml`
- Modify: release-please config (remove the `ralph-sandbox` component)
- Modify: `packages/core/package.json` (`files` array — drop `Dockerfile`)

- [ ] **Step 1: Inspect release config + package files**

Run:
```bash
grep -rln "ralph-sandbox\|Dockerfile\|publish-image\|templates/CHANGELOG" \
  release-please-config.json .release-please-manifest.json .github packages/core/package.json 2>/dev/null
cat packages/core/package.json | grep -nA6 '"files"'
```
Expected: identifies the release-please component entry + manifest version line for `packages/core/templates` (image) and the `files` array entry.

- [ ] **Step 2: Delete files**

```bash
git rm packages/core/templates/Dockerfile packages/core/templates/CHANGELOG.md .github/workflows/publish-image.yml
```

- [ ] **Step 3: Remove the `ralph-sandbox` component**

In `release-please-config.json`, delete the `"packages/core/templates"` (a.k.a. `ralph-sandbox`) package object. In `.release-please-manifest.json`, delete its version line. In `packages/core/package.json`'s `files` array, remove `"Dockerfile"` (keep `"templates/"` — the prompt/review markdown still ship). Remove any `"templates/Dockerfile"`/`"templates/CHANGELOG.md"` entries if listed individually.

- [ ] **Step 4: Verify nothing else references the image build**

Run:
```bash
grep -rn "ralph-sandbox\|publish-image\|docker build\|RALPH_DOCKER" .github release-please-config.json .release-please-manifest.json packages apps || echo "clean"
```
Expected: only doc-prose matches remain (handled in Task 12), no config/CI wiring.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove sandbox image, Dockerfile, and image CI/release wiring"
```

---

## Task 12: Update prose docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`, `RELEASING.md`, `SECURITY.md`

- [ ] **Step 1: Find every Docker mention**

Run:
```bash
grep -rniE "docker|ralph-sandbox|RALPH_IMAGE|RALPH_DOCKER|container|dockerfile|docker.sock|bind-mount" \
  CLAUDE.md README.md RELEASING.md SECURITY.md docs/ARCHITECTURE.md
```

- [ ] **Step 2: Rewrite each hit to the host/sandbox model**

For each file, replace the Docker runtime description with: "Ralph runs `claude` directly on the host; the default `RALPH_RUNNER=sandbox` uses Claude Code's native OS sandbox (writes confined to the workspace), `RALPH_RUNNER=host` runs unsandboxed." Specifically:
- **CLAUDE.md** — "What this repo is", the `runStage`/`ensureImage`/runner bullets, the env-knob list (drop `RALPH_IMAGE`/`RALPH_DOCKER_*`, add `RALPH_RUNNER`/`RALPH_SANDBOX_NET`), "Credential mounts" → "Credentials" (host reads `~/.claude`, `~/.config/gh` natively), the "Building / publishing the sandbox image" section (delete), "Sandbox image" (delete).
- **README.md** — install/first-run no longer needs Docker; remove image pull/build troubleshooting; document `RALPH_RUNNER`/`RALPH_SANDBOX_NET`; keep the macOS Seatbelt note.
- **docs/ARCHITECTURE.md** — runtime model: spawn `claude` not `docker run`; remove the image-lifecycle + socket sections.
- **RELEASING.md** — remove the image release component; releases are npm-only now (`@daonhan/ralph-core` + `@daonhan/ralph`).
- **SECURITY.md** — replace the docker.sock blast-radius section with the sandbox/host blast-radius description.

- [ ] **Step 3: Verify**

Run:
```bash
grep -rniE "RALPH_IMAGE|RALPH_DOCKER|ralph-sandbox|docker run|docker pull|docker.sock" \
  CLAUDE.md README.md RELEASING.md SECURITY.md docs/ARCHITECTURE.md || echo "clean"
```
Expected: `clean` (any surviving "docker" mention should only be e.g. "Docker is no longer required").

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md RELEASING.md SECURITY.md docs/ARCHITECTURE.md
git commit -m "docs: describe host-first native-sandbox runner; remove docker docs"
```

---

## Task 13: Full verification + manual smoke test

**Files:** none (verification).

- [ ] **Step 1: Run the full verification gate**

Run:
```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm test
```
Expected: all green. (`pnpm test` at root runs `node --test scripts/*.test.mjs`.)

- [ ] **Step 2: Confirm no Docker references remain in shipped code**

Run:
```bash
grep -rnE "docker|ensureImage|IMAGE_REF" packages/core/src apps/cli || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Manual smoke test (sandbox runner, no Docker)**

In a throwaway git repo with a trivial plan file, with `claude` authenticated:
```bash
cd /tmp && rm -rf ralph-smoke && mkdir ralph-smoke && cd ralph-smoke && git init -q && echo "# plan: create HELLO.md containing 'hi'" > plan.md && git add -A && git commit -qm init
RALPH_WORKSPACE=/tmp/ralph-smoke ralph-afk "Read plan.md and do it" 1
```
Expected: a stage runs with **no `docker` process** (confirm `docker ps` shows nothing new / `pgrep -fl docker` unchanged), `HELLO.md` is created, and a commit lands. Inspect `/tmp/ralph-smoke/.ralph-tmp/logs/*.ndjson` for the stream and confirm a `.sandbox-*.json` was written + cleaned.

- [ ] **Step 4: Smoke test the `host` runner**

```bash
RALPH_RUNNER=host RALPH_WORKSPACE=/tmp/ralph-smoke ralph-afk --print-config "x" 1
```
Expected: `--print-config` prints `RALPH_RUNNER  host` and `sandbox network  n/a (host runner)`.

- [ ] **Step 5: Final commit (if any doc tweaks fell out of smoke testing)**

```bash
git add -A && git commit -m "test: verify host-first sandbox runner end to end" || echo "nothing to commit"
```

---

## Self-Review (completed)

- **Spec coverage:** runner model (T2–T5), transient settings (T2,T4), env-var changes (T2,T7,T8), code-change table rows (T4–T9), deleted files (T11), template MSB3248 removal (T10), docs (T12), tests (T2,T3,T6), success criteria (T13). Network tradeoff handled via T1 gate + T2 default. ✓
- **Placeholders:** none — every code step shows full code; `streamClaude` reuses the existing body with three explicitly named changes. ✓
- **Type consistency:** `resolveRunner`/`resolveSandboxNet`/`buildSandboxSettings`/`buildClaudeArgs(…, settingsPath?)`/`streamClaude(argv, cwd, logPath, options)`/`printConfig(bin, workspaceDir, packageDir, opts)` names match across tasks; `runStage`'s 7-arg signature is preserved so `loop.ts`/`loop.test.ts` callers are unchanged. ✓
- **Open questions:** Task 1 gates the two version-dependent unknowns (`--settings` path acceptance, default-network behavior) before code is written. ✓
