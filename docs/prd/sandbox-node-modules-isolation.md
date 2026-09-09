# PRD: Isolate the sandbox's `node_modules` from the bind-mounted workspace

> Tracks GitHub issue #128, **option 1** (isolate). Option 2 (detect and warn) shipped as [`sandbox-install-warning.md`](sandbox-install-warning.md); its `host-check.ts` detector is this slice's regression oracle — after a run with isolation on, `detectSandboxInstall(workspace)` must return `[]`.

## Problem Statement

Every stage bind-mounts the whole target workspace at `/home/agent/workspace`, `node_modules/` included. When the agent installs dependencies inside the container — which it does whenever the repo's verification command needs a toolchain the host tree cannot provide — the install writes a **Linux** tree into the host's `node_modules/`: `node_modules/.modules.yaml` gets `storeDir: /home/agent/workspace/.pnpm-store/v3`, a `.pnpm-store/` appears at the workspace root, and the workspace packages' `node_modules/` fill with Linux symlinks.

Both paths are gitignored, so the host tree looks clean to `git status` while the first host `pnpm` / `tsc` / `vitest` command dies with an unrelated-looking error (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, unresolvable bins, `EPERM` on symlinks). The only repair is to move the tree aside and reinstall on the host.

#128 recorded it on this repository after each of three `ralph-ghafk` runs on 2026-09-08 (PRs #107, #116, #125); it has fired on every ralph cycle since. Ralph today only **warns** about the damage at loop end — the tracer. The damage is still done, and the harness that drives Ralph's own development carries a hand-written repair step for it.

The direction is Windows-first because the primary host is Windows with Docker Desktop, where a Linux install tree and a Windows one can never coexist. macOS has the same mismatch. A Linux host is the case where sharing the tree with the container is at least plausible today.

## Solution

When isolation is on, `runStage` gives the container its **own** `node_modules` at every package directory in the workspace, backed by Docker volumes that persist across stages and runs, and points the package-manager store at a shared volume so the container never falls back to a store inside the bind mount.

Concretely, the `docker run` line gains, for a workspace whose package directories are `.`, `apps/cli`, `packages/core`:

```
-v ralph-nm-d9e04dc2647ebe63:/home/agent/workspace/node_modules
-v ralph-nm-e6d76d4bae2b0c9b:/home/agent/workspace/apps/cli/node_modules
-v ralph-nm-aad9576ffb588f74:/home/agent/workspace/packages/core/node_modules
-v ralph-pm-store:/home/agent/.pm-store
-e npm_config_store_dir=/home/agent/.pm-store/pnpm
-e npm_config_cache=/home/agent/.pm-store/npm
```

A volume mounted at a path inside the bind mount shadows the host directory: the container sees its own tree, and nothing the container writes there reaches the host. The volumes are created once per workspace and **kept**, so the second stage — and the next run — starts with the install the first one performed.

**Default.** On when the host is **not** Linux (`win32`, `darwin`: the host tree can never be the container's), off on Linux (where sharing works today and nothing has reported the defect). `RALPH_ISOLATE_NODE_MODULES=1` forces it on, `=0` forces it off, on any platform.

**Cost.** The container's first install for a workspace is a cold one. It is then cached in the volume, and the shared store volume makes even a cold install a local extraction rather than a download.

**Where the host still changes.** Docker creates the mountpoint when the host has no `node_modules` at that path yet, so an **empty** `node_modules/` directory can appear on the host. It is gitignored, and it stays empty.

## User Stories

1. As a Windows Ralph user, I want a sandbox install to leave my host `node_modules/` exactly as it was, so that my next host `pnpm` / `tsc` / `vitest` command works without a repair.
2. As that user, I want no `.pnpm-store/` to appear at my workspace root, so that the second fingerprint the loop-end check warns about never fires either.
3. As that user, I want the second stage of a run — and the next run on the same workspace — to reuse the install the first one did, so that isolation does not cost an install per stage.
4. As a Ralph user on a monorepo, I want every workspace package's `node_modules/`, not just the root's, to be container-local, so that Linux symlinks never land in the packages either.
5. As a Ralph user on Linux, I want today's behavior unchanged unless I ask for isolation, so that a working shared tree is not taken away by an upgrade.
6. As a Ralph user who wants the old behavior back, I want one environment variable to turn isolation off, so that a rollback needs no reinstall.
7. As a Ralph user on a workspace with no `package.json` at all (a Python or .NET repo), I want no volumes, no extra docker calls and no changed `docker run` line, so that the feature costs nothing where it does not apply.
8. As a Ralph user diagnosing a run, I want `ralph-ghafk --print-config` to tell me whether `node_modules` is isolated and how many volumes that means, so that I can see the mode without reading the source.
9. As a Ralph user reclaiming disk, I want the volumes labelled with their kind and their workspace, so that I can list and remove exactly the ones belonging to a repository I no longer use.
10. As a Ralph maintainer, I want the enumeration, the volume naming and the `docker run` arguments in one pure module with its own tests, so that the docker-touching part stays small and the rest is unit-testable.
11. As a Ralph maintainer, I want the loop-end sandbox-install check to keep reporting nothing after an isolated run, so that the tracer that shipped for option 2 becomes this option's regression oracle.

## Implementation Decisions

- **Isolation module.** A new `packages/core/src/sandbox-volumes.ts`, pure `node:crypto` + `node:fs` + `node:path`, no docker and no shell — the shape `host-check.ts` established. It exports:
  - `isolationEnabled(platform?): boolean` — `RALPH_ISOLATE_NODE_MODULES` trimmed: `"0"` → false, `"1"` → true, anything else (including unset) → `platform !== "linux"`, defaulting to `process.platform`.
  - `resolveSandboxVolumes(workspaceDir): SandboxVolume[]` — `[]` when isolation is off or no package directory exists; otherwise one entry per package directory plus the store volume last, each carrying its name, container path and labels.
  - `sandboxRunArgs(volumes): string[]` — the `-v` / `-e` arguments above, `[]` for an empty input.
  - `missingVolumes(existing, volumes): SandboxVolume[]` — the set difference the runner feeds to `docker volume create`.
- **Enumeration.** A directory is a package directory when it holds a `package.json`. The walk starts at `workspaceDir`, descends at most **4** levels, and skips `node_modules`, `.git` and every entry whose name starts with `.`. On this repository it yields `.`, `apps/cli`, `packages/core` — the three `node_modules` a pnpm install writes. Enumerating _package directories_ rather than _existing `node_modules` directories_ is deliberate: a package whose `node_modules/` the host has not created yet is exactly the one an install would write into the bind mount.
- **Volume naming.** `ralph-nm-<first 16 hex of sha256(workspaceDir + "\0" + relPath)>`. Opaque on purpose: a name derived from the path would need sanitising for Docker's name grammar and could collide across two different paths that sanitise alike. Human-readable provenance lives in labels instead: `ralph.kind=node-modules`, `ralph.workspace=<absolute workspace path>`, `ralph.path=<relative package path>`. The store volume is the single shared `ralph-pm-store`, labelled `ralph.kind=pm-store`.
- **Ownership — the reason a plain volume does not work.** A fresh Docker volume mounted at a path the image does not contain is created `root:root 0755`, and the sandbox runs as `agent` (UID 1000). The agent cannot write into it, so the volumes must be chowned once, by a container that runs as root. Ralph therefore, on the first stage of a run:
  1. reads the existing managed volumes in one call — `docker volume ls --filter label=ralph.kind --format {{.Name}}`;
  2. `docker volume create --label …` for each missing one;
  3. runs **one** `docker run --rm --user 0:0 -v <each missing volume>:/mnt/<i> <IMAGE_REF> chown 1000:1000 /mnt/0 /mnt/1 …`.

  With every volume already present — the second stage, and every later run — step 1 is the only docker call and steps 2–3 do nothing. The result is memoised per process, so only the first stage pays even step 1.

- **Store volume.** Without it the fix is incomplete: pnpm places its store next to the modules directory it is linking into, and with `node_modules` on a volume it still chooses `<workspace>/.pnpm-store` — inside the bind mount. `npm_config_store_dir` and `npm_config_cache` are the npm-config environment spellings both pnpm and npm honour, and setting them removes the heuristic. Both point inside the one `ralph-pm-store` volume, shared across workspaces because a package store is a cache and pnpm's store is safe for concurrent readers.
- **Failure.** A docker error while preparing the volumes aborts the stage with a message naming `RALPH_ISOLATE_NODE_MODULES=0`. Continuing without the mounts would silently reintroduce the defect; continuing with root-owned mounts would fail every install inside the container with a confusing error.
- **`--print-config`.** One line beside the existing `docker.sock` line: the mode, the volume count, and the variable that changes it.
- **No CLI flag.** Environment variable only, like `RALPH_DOCKER_SOCK`. Rollback is `RALPH_ISOLATE_NODE_MODULES=0`, or a revert of the feature commits.
- **Documentation.** README gets the behavior, the knob and the volume-cleanup commands; `docs/ARCHITECTURE.md` gets the env-var row, the mount description and the `docker run` argv shape; `CONTEXT.md`'s existing sandbox-install gotcha is amended to say it is now prevented by default off Linux; `CLAUDE.md` / `AGENTS.md` are edited identically.

## Testing Decisions

- **What makes a good test here.** The module's contract is a list of volumes and a list of docker arguments for a given directory layout and environment; both are pure, so tests build a layout in a temporary directory, set the variable, and assert on the returned arrays. The docker side — volume creation, the chown, the shadowing itself — is not unit-testable without a daemon and is verified once by the review session's probe.
- **Modules under test.** `sandbox-volumes.ts` (new suite `sandbox-volumes.test.ts`) and `cli-help.ts` (the `--print-config` line, in its existing suite).
- **Cases, isolation switch.** `RALPH_ISOLATE_NODE_MODULES` unset → follows the platform; `"0"` → off; `"1"` → on; `" 1 "` → on; `"yes"` → the platform default (unrecognised values do not silently disable).
- **Cases, enumeration.** Root `package.json` only → one volume at `node_modules`; root plus `packages/a` and `packages/b` → three, root first; a `package.json` inside `node_modules/` or inside a dot-directory → ignored; a workspace with no `package.json` → `[]`; a `package.json` five levels deep → ignored (depth cap).
- **Cases, naming.** Two different relative paths under the same workspace get different volume names; the same workspace and path give the same name twice (stable); the name matches `/^ralph-nm-[0-9a-f]{16}$/`.
- **Cases, arguments.** For a two-volume input the returned array contains a `-v <name>:<container path>` pair per volume, the `-v ralph-pm-store:/home/agent/.pm-store` mount, and both `-e npm_config_*` assignments; for `[]` it is empty (so a non-JavaScript workspace changes no argument).
- **Cases, `--print-config`.** Isolation off → the line names the variable and says the host tree is shared; isolation on → the line carries the volume count.
- **Prior art.** `host-check.test.ts`'s temporary-workspace pattern; `runner.test.ts`'s `resolveAgentRuntimeArgs` argument assertions; `cli-help.test.ts` for the printed line.
- **Assigned to the review session** (the sandbox cannot run this): the end-to-end probe — a scratch pnpm workspace, the branch's own `resolveSandboxVolumes` / `sandboxRunArgs` output fed to `docker run`, a real `pnpm install` inside, then `detectSandboxInstall(scratch)` returning `[]` and the scratch tree holding no `.pnpm-store/` and no populated `node_modules/`.

## Out of Scope

- Repairing or removing an already-damaged host tree, and removing the volumes Ralph creates (documented commands only, no new subcommand).
- A `--isolate` / `--no-isolate` CLI flag.
- Isolating anything else the container writes into the bind mount (`.venv/`, `obj/`, `bin/`, `target/`).
- Package managers beyond pnpm and npm — #128's own wording — so no `YARN_CACHE_FOLDER` and no bun equivalent.
- Changing the agent playbooks (`prompt.md`, `ghprompt.md`) to tell the agent about the empty tree; the agent installs when a toolchain is missing, as it does today.
- The `images/pg17/` variant and the published sandbox image: this slice adds no Dockerfile change.
- Making the loop-end `host-check` warning conditional on the isolation mode; it stays exactly as it is and becomes the oracle.

## Further Notes

Mechanism evidence, measured on this host (Docker Desktop, server `linux/amd64` 29.7.2, image `docker.io/daonhan/ralph-sandbox:latest`) on 2026-09-09, against scratch workspaces — never this repository:

1. **Shadowing and host safety.** A workspace with `HOST_MARKER` files in three `node_modules` directories, mounted with an anonymous volume, a named volume and a host-directory bind over them: inside the container all three read empty; afterwards every `HOST_MARKER` was still on the host and no container-written file had reached it.
2. **Ownership.** In that same run the anonymous and the named volume both mounted `root:root 0755` and `touch` failed with `Permission denied` for UID 1000; only the host-directory bind (which Docker Desktop surfaces `0777`) was writable. After `docker volume create` plus one `docker run --rm --user 0:0 … chown 1000:1000 /mnt/target`, the named volume mounted `agent:node 0755` and was writable.
3. **Persistence.** A file written into a chowned volume by one container was read back by the next container — the cached-install claim.
4. **Missing mountpoint.** A volume mounted at `packages/fresh/node_modules`, which the host did not have, left an **empty** `node_modules/` directory on the host. Both paths are covered by this repository's `node_modules/` gitignore entry.
5. **The store is load-bearing.** A scratch pnpm workspace (`is-odd@3.0.1` in one package) installed with the `node_modules` volumes but **no** store setting: the install succeeded, and the host workspace root gained `.pnpm-store/v3` with ten file buckets; the container's `.modules.yaml` read `storeDir: /home/agent/workspace/.pnpm-store/v3`.
6. **The full arrangement.** The same workspace with the store volume and both `npm_config_*` variables: the container read `storeDir: /home/agent/.pm-store/pnpm/v3`, `require.resolve("is-odd")` resolved through `/home/agent/workspace/node_modules/.pnpm/is-odd@3.0.1/…`, and the host afterwards held only `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/a/package.json` and two empty `node_modules/` directories — no `.pnpm-store/`, so `detectSandboxInstall` returns `[]`.

Other notes:

- `pnpm-lock.yaml` is written to the bind mount and must stay that way: it is repository content the host and git need to see. Only `node_modules/` and the store move.
- The container user is UID 1000, GID 1000, named `agent:node` after the Dockerfile's `usermod` rename — hence `chown 1000:1000` rather than `chown agent:agent`.
- Stress-test & provoke:
  - Killer assumption: [solution] a volume over a path inside a bind mount isolates the writes → probed above, and the store probe showed the naive version of the same solution still leaking.
  - Other assumptions: [feasibility] one chown container per workspace lifetime is acceptable; [user] a cold first install is an acceptable price for an intact host tree; [problem] Linux hosts are not affected enough to change their default.
  - Strongest counter: the agent could simply be told not to install — option 3 in #128, already rejected there because an agent that needs a missing dependency ignores it.
  - Would be unnecessary if: the workspace were copied into the container instead of bind-mounted — but the loop's whole contract is that commits and logs land in the host tree.
