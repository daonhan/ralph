# Plan: Isolate the sandbox's `node_modules` from the bind-mounted workspace

> Source PRD: [docs/prd/sandbox-node-modules-isolation.md](../prd/sandbox-node-modules-isolation.md) · tracks #128 (option 1, isolate)

## Architectural decisions

Durable decisions that apply across all phases:

- **One pure module, one docker caller.** `packages/core/src/sandbox-volumes.ts` is pure `node:crypto` + `node:fs` + `node:path` — the shape `host-check.ts` established. Every docker call lives in `runner.ts`, which already owns `runDockerCommand` and `spawnSync`. The module never spawns anything.
- **Public surface of the module:**

  ```ts
  export const CONTAINER_WORKSPACE = "/home/agent/workspace";
  export const STORE_VOLUME = "ralph-pm-store";
  export const STORE_PATH = "/home/agent/.pm-store";

  export type SandboxVolume = {
    name: string; // docker volume name
    containerPath: string; // where it mounts inside the sandbox
    labels: string[]; // ["ralph.kind=…", "ralph.workspace=…", "ralph.path=…"]
  };

  export function isolationEnabled(platform?: string): boolean;
  export function resolveSandboxVolumes(workspaceDir: string): SandboxVolume[];
  export function sandboxRunArgs(volumes: SandboxVolume[]): string[];
  export function missingVolumes(
    existing: string[],
    volumes: SandboxVolume[]
  ): SandboxVolume[];
  ```

  `isolationEnabled` takes the platform as an optional parameter — defaulting to `process.platform` — so the platform-default branch is testable without redefining a read-only global.

- **The switch.** `RALPH_ISOLATE_NODE_MODULES`, trimmed: `"0"` → off, `"1"` → on, anything else including unset → `platform !== "linux"`. An unrecognised value never silently disables isolation.
- **Enumeration.** A package directory is one holding a `package.json`. Walk from `workspaceDir`, at most **4** levels deep, skipping `node_modules`, `.git` and every entry whose name starts with `.`. Output order is deterministic: the workspace root (`relPath` `"."`) first, then the rest sorted lexicographically by relative path.
- **Volume naming.** `ralph-nm-` + the first 16 hex characters of `sha256(workspaceDir + "\0" + relPath)`. Opaque by design; provenance lives in the labels `ralph.kind=node-modules`, `ralph.workspace=<absolute workspace dir>`, `ralph.path=<relative package dir>`. The store volume is the single shared `STORE_VOLUME`, `containerPath` `STORE_PATH`, labels `["ralph.kind=pm-store"]`, and is the **last** entry of `resolveSandboxVolumes` whenever the list is non-empty.
- **`resolveSandboxVolumes` returns `[]`** when isolation is off, and when the walk finds no package directory — so a workspace with no `package.json` produces no volume, no docker call and a byte-identical `docker run` line.
- **`sandboxRunArgs`** is `[]` for an empty input; otherwise `-v <name>:<containerPath>` per volume (store included) followed by `-e npm_config_store_dir=<STORE_PATH>/pnpm` and `-e npm_config_cache=<STORE_PATH>/npm`. Length is therefore `2 × volumes.length + 4`.
- **Volume preparation** (`runner.ts`, memoised per process so only the first stage of a run pays it):
  1. `docker volume ls --filter label=ralph.kind --format {{.Name}}` — one `spawnSync` read, the shape `ensureImageSync` uses for `image inspect`.
  2. `missingVolumes(existingNames, volumes)` → for each, `docker volume create --label <l1> --label <l2> … <name>`.
  3. When anything was missing, **one** `docker run --rm --user 0:0 -v <m1>:/mnt/0 -v <m2>:/mnt/1 … <IMAGE_REF> chown 1000:1000 /mnt/0 /mnt/1 …`, through the existing async `runDockerCommand` so `--` an abort signal still cancels it. A fresh volume mounts `root:root 0755` and the sandbox runs as UID 1000; without this chown every install inside the container fails with `Permission denied`.

  Any docker failure here rejects the stage with a message that names `RALPH_ISOLATE_NODE_MODULES=0`.

- **`CONTAINER_WORKSPACE` has one home.** `runner.ts` today writes the literal `/home/agent/workspace` twice (the bind mount spec and `-w`); both become the imported constant, so the module and the runner cannot drift.
- **No knob beyond the one variable, no CLI flag, no Dockerfile change.** Rollback is `RALPH_ISOLATE_NODE_MODULES=0` or a revert of the feature commits.
- **Verification**: per phase, the targeted suite by file path plus the core typecheck. The whole-repo gate (`pnpm -r typecheck && pnpm -r test && pnpm test`) is the review session's job, not a per-phase criterion.
- **Assigned to the review session** (BUILD's sandbox cannot run it): the end-to-end docker probe described in Phase 2's "handed to REVIEW" note.

---

## Phase 1: The module decides which volumes a workspace needs

**User stories**: 4, 5, 6, 7, 9, 10

### What to build

Add `packages/core/src/sandbox-volumes.ts` with the surface above, and a new suite `packages/core/src/__tests__/sandbox-volumes.test.ts` building each layout in a temporary directory (`mkdtempSync` under `os.tmpdir()`, the pattern `host-check.test.ts` uses) with `RALPH_ISOLATE_NODE_MODULES` set per case and restored afterwards. Nothing else changes; the module is not yet wired.

### Acceptance criteria

- [ ] `isolationEnabled("linux")` with the variable unset → `false`; `isolationEnabled("win32")` and `isolationEnabled("darwin")` → `true`.
- [ ] With `RALPH_ISOLATE_NODE_MODULES="0"` → `isolationEnabled("win32")` is `false`; with `"1"` → `isolationEnabled("linux")` is `true`; with `" 1 "` → `true`; with `"yes"` → the platform default (`false` for `"linux"`, `true` for `"win32"`).
- [ ] Isolation on, temp workspace with a root `package.json` only → `resolveSandboxVolumes(dir)` has length 2: entry 0 has `containerPath` `/home/agent/workspace/node_modules`, `name` matching `/^ralph-nm-[0-9a-f]{16}$/` and labels `["ralph.kind=node-modules", "ralph.workspace=" + dir, "ralph.path=."]`; entry 1 is exactly `{ name: "ralph-pm-store", containerPath: "/home/agent/.pm-store", labels: ["ralph.kind=pm-store"] }`.
- [ ] Isolation on, temp workspace with `package.json` at the root, `packages/a` and `packages/b` → four entries; the `containerPath` list is exactly `["/home/agent/workspace/node_modules", "/home/agent/workspace/packages/a/node_modules", "/home/agent/workspace/packages/b/node_modules", "/home/agent/.pm-store"]` (root first, then lexicographic, store last).
- [ ] Isolation on, a `package.json` inside `node_modules/`, inside `.hidden/`, and one five directories below the root → none of the three produces a volume (the layout's only volumes are the root's and the store's).
- [ ] Isolation on, temp workspace with no `package.json` anywhere → `resolveSandboxVolumes(dir)` is `[]` (no store volume either).
- [ ] Isolation off (`RALPH_ISOLATE_NODE_MODULES="0"`) with a root `package.json` present → `[]`.
- [ ] Naming: the same `(workspaceDir, relPath)` pair produces the same `name` on two calls; the root and `packages/a` of one workspace get different names; the same `packages/a` under two different workspace directories gets different names.
- [ ] `sandboxRunArgs([])` → `[]`. For the three-volume list of a root-plus-`packages/a` workspace, `sandboxRunArgs(volumes)` equals exactly `["-v", "<root name>:/home/agent/workspace/node_modules", "-v", "<a name>:/home/agent/workspace/packages/a/node_modules", "-v", "ralph-pm-store:/home/agent/.pm-store", "-e", "npm_config_store_dir=/home/agent/.pm-store/pnpm", "-e", "npm_config_cache=/home/agent/.pm-store/npm"]` — a full-equality assertion against a literal list built from the returned names, length 10.
- [ ] `missingVolumes([], volumes)` returns every entry in order; `missingVolumes(volumes.map(v => v.name), volumes)` returns `[]`; `missingVolumes([volumes[0].name], volumes)` returns the remaining entries only.
- [ ] `grep -o 'from "node:[a-z]*"' packages/core/src/sandbox-volumes.ts | sort -u` prints exactly the three lines `from "node:crypto"`, `from "node:fs"`, `from "node:path"` (the module spawns nothing).
- [ ] `grep -o "export function isolationEnabled\|export function resolveSandboxVolumes\|export function sandboxRunArgs\|export function missingVolumes" packages/core/src/sandbox-volumes.ts | wc -l` reads 4 (the file does not exist today, so every count above starts from nothing).
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/sandbox-volumes.test.ts` green (new suite, at least ten tests) and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Phase 2: The runner mounts the volumes and prepares them once

**User stories**: 1, 2, 3, 8

### What to build

In `runner.ts`:

- import `CONTAINER_WORKSPACE`, `resolveSandboxVolumes`, `sandboxRunArgs`, `missingVolumes` and `STORE_VOLUME` from `./sandbox-volumes.js`, and replace the two inline `/home/agent/workspace` literals with the constant;
- add a module-level `Set<string>` memo and an `ensureSandboxVolumes(volumes, options)` performing the three steps in "Volume preparation" above, rejecting with `` `failed to prepare sandbox node_modules volumes: ${message}. Disable with RALPH_ISOLATE_NODE_MODULES=0.` `` on any docker failure;
- in `runStage`, compute `const volumes = resolveSandboxVolumes(workspaceDir)`, `await ensureSandboxVolumes(volumes, options)` when it is non-empty, and push `...sandboxRunArgs(volumes)` into the `docker run` args beside the existing mounts.

In `cli-help.ts`, add one line to `printConfig`, after the `RALPH_DOCKER_SOCK` line, in the same label column:

```
  node_modules          isolated in <n> container volumes (RALPH_ISOLATE_NODE_MODULES=0 to share the host tree)
  node_modules          shared with the host bind mount (RALPH_ISOLATE_NODE_MODULES=0)
  node_modules          shared with the host bind mount (linux default; RALPH_ISOLATE_NODE_MODULES=1 to isolate)
```

— the first when isolation is on (`<n>` counts the `node-modules` volumes, i.e. `resolveSandboxVolumes(workspaceDir).length - 1`), the second when the variable turned it off, the third when the platform default did. Pin the three in `cli-help.test.ts` with the existing `printConfig` stdout-spy test's pattern.

### Acceptance criteria

- [ ] `grep -o "sandbox-volumes.js" packages/core/src/runner.ts | wc -l` reads 1 (today 0); `grep -o "resolveSandboxVolumes\|sandboxRunArgs\|ensureSandboxVolumes" packages/core/src/runner.ts | wc -l` reads ≥ 5 (import line plus call sites; today 0).
- [ ] The bind mount is built from the constant: `grep -o '\${workspaceDir}:\${CONTAINER_WORKSPACE}' packages/core/src/runner.ts | wc -l` reads 1 (today the same grep against the literal form, `'\${workspaceDir}:/home/agent/workspace'`, reads 1 and this one reads 0), and `grep -o "CONTAINER_WORKSPACE" packages/core/src/runner.ts | wc -l` reads ≥ 3 (import plus the two former literals). Stated as a positive because a docblock in `runner.ts` may legitimately keep writing the path in prose.
- [ ] `grep -o "chown" packages/core/src/runner.ts | wc -l` reads ≥ 1 and `grep -o -- "--user" packages/core/src/runner.ts | wc -l` reads ≥ 1 (today 0 each): the chown container exists.
- [ ] `grep -o "RALPH_ISOLATE_NODE_MODULES=0" packages/core/src/runner.ts | wc -l` reads ≥ 1 — the failure message names the escape hatch.
- [ ] `printConfig` with `RALPH_ISOLATE_NODE_MODULES` unset on a Linux platform value → the captured stdout contains `node_modules          shared with the host bind mount (linux default; RALPH_ISOLATE_NODE_MODULES=1 to isolate)`.
- [ ] `printConfig` with `RALPH_ISOLATE_NODE_MODULES="0"` → stdout contains `shared with the host bind mount (RALPH_ISOLATE_NODE_MODULES=0)` and does **not** contain `isolated in`.
- [ ] `printConfig` with `RALPH_ISOLATE_NODE_MODULES="1"` against a temp workspace holding one `package.json` → stdout contains `isolated in 1 container volumes`.
- [ ] The existing `printConfig` test and every other case in `cli-help.test.ts` keep passing unchanged, and the existing `runner.test.ts` cases (`parseGraceMs`, `resolveModelArgs`, `buildClaudeArgs`, `resolveAgentRuntimeArgs`) keep passing unchanged.
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/runner.test.ts src/__tests__/cli-help.test.ts src/__tests__/sandbox-volumes.test.ts` green (today `runner.test.ts` and `cli-help.test.ts` are part of a 16-file / 216-test core suite; this phase adds at least three cases to `cli-help.test.ts`) and `pnpm --filter @daonhan/ralph-core typecheck` green.

### Handed to REVIEW (not runnable in BUILD's sandbox)

The end-to-end probe, run once on the host after the branch is built:

1. Create a scratch pnpm workspace outside this repository — a root `package.json` with `packageManager` pinned and a `pnpm-workspace.yaml`, plus `packages/a/package.json` depending on one tiny package.
2. Take `resolveSandboxVolumes(scratch)` and `sandboxRunArgs(...)` from the **branch's built `dist/`**, run the chown preparation, then `docker run` the sandbox image with those arguments and `corepack pnpm install` inside.
3. Assert: the install succeeds and the dependency resolves through `/home/agent/workspace/node_modules/.pnpm/…`; on the host the scratch tree gained **no** `.pnpm-store/`, its `node_modules` directories are empty, and `detectSandboxInstall(scratch)` returns `[]`.
4. Remove the probe volumes afterwards (`docker volume rm`), and confirm `docker volume ls --filter label=ralph.kind --format {{.Name}}` lists none of them.

The PRD's "Further Notes" records the same probe run against the pre-change mounts; step 3's `[]` is the reading this slice must reproduce through the code path rather than by hand.

---

## Phase 3: Docs name the isolation, the knob and the cleanup

**User stories**: 5, 6, 8, 9

### What to build

- **README** — one troubleshooting/behavior entry: the sandbox gets container-local `node_modules` volumes, on by default on Windows and macOS and off on Linux; the first install per workspace is cold and then cached; `RALPH_ISOLATE_NODE_MODULES=0` / `=1` flips it; an empty `node_modules/` directory may appear on the host and is gitignored; and the cleanup commands:

  ```bash
  docker volume ls --filter label=ralph.kind=node-modules --format '{{.Name}}  {{.Label "ralph.workspace"}}  {{.Label "ralph.path"}}'
  docker volume rm <name>…
  ```

  plus the note that a plain `docker volume prune` removes them too, costing only the cache.

- **`docs/ARCHITECTURE.md`** — a row in the environment-variable table for `RALPH_ISOLATE_NODE_MODULES` (default: on except Linux), a sentence in the mounts description naming the volumes, the labels and the one-off root `chown`, and the extra `-v` / `-e` arguments in the `docker run` argv shape.
- **`CONTEXT.md`** — the existing sandbox-install gotcha bullet is amended to say the rewrite is now prevented by default off Linux (the warning stays as the backstop), and the "Key knobs" table gains a `RALPH_ISOLATE_NODE_MODULES` row.
- **`CLAUDE.md` and `AGENTS.md`** (twins, edited identically): the "Env knobs" paragraph gains the variable, and the `runner.ts` entry of the architecture list gains a clause naming `sandbox-volumes.ts` and the container-local `node_modules` volumes. No new numbered item — the list's numbering stays 1–10.

### Acceptance criteria

- [ ] `grep -o "RALPH_ISOLATE_NODE_MODULES" README.md docs/ARCHITECTURE.md CONTEXT.md CLAUDE.md AGENTS.md | wc -l` reads ≥ 5 with at least one hit in each of the five files (today 0 across all of them).
- [ ] `grep -o "sandbox-volumes.ts" docs/ARCHITECTURE.md CLAUDE.md AGENTS.md | wc -l` reads ≥ 3 (today 0).
- [ ] `grep -o "label=ralph.kind=node-modules" README.md | wc -l` reads ≥ 1 and `grep -o "docker volume rm" README.md | wc -l` reads ≥ 1 (today 0 each).
- [ ] `grep -c "RALPH_ISOLATE_NODE_MODULES" docs/ARCHITECTURE.md` counts the env-table row and the mounts sentence: the table region itself carries it — `awk '/^\| `RALPH_WORKSPACE`/,/^$/' docs/ARCHITECTURE.md | grep -o "RALPH_ISOLATE_NODE_MODULES" | wc -l` reads 1, so the row is in the table and not only in prose.
- [ ] `diff <(grep -n "RALPH_ISOLATE_NODE_MODULES" CLAUDE.md | cut -d: -f2-) <(grep -n "RALPH_ISOLATE_NODE_MODULES" AGENTS.md | cut -d: -f2-)` is empty and `diff <(grep -n "sandbox-volumes.ts" CLAUDE.md | cut -d: -f2-) <(grep -n "sandbox-volumes.ts" AGENTS.md | cut -d: -f2-)` is empty (the twins stay identical on the new lines).
- [ ] `grep -o "^[0-9]\+\. \*\*" CLAUDE.md | wc -l` still reads 10 — the architecture list gains no numbered item (the same count in `AGENTS.md`).
- [ ] `grep -o "warning: sandbox-install" CONTEXT.md | wc -l` still reads 1: the loop-end warning stays documented as the backstop, not replaced.
- [ ] Verification: `pnpm exec prettier --check README.md docs/ARCHITECTURE.md CONTEXT.md CLAUDE.md AGENTS.md` green and `pnpm test` at the root green (docs-only phase, nothing else moves).

---

## Slice mapping

One pull request; one issue per phase, in dependency order: Phase 1 → Phase 2 → Phase 3 (Phase 3 documents Phases 1–2, so it lands last). Issue #128 is **closed** by this slice — it is the tracker for option 1, and option 2 already shipped.

| Phase | Issue                  |
| ----- | ---------------------- |
| 1     | #142                   |
| 2     | #143 (blocked by #142) |
| 3     | #144 (blocked by #143) |
