# PRD: Multi-Version Node + .NET Runtime Support for ralph-sandbox

## Problem Statement

As a Ralph user, when I point `ralph-afk` or `ralph-ghafk` at a target repository, the sandbox container runs whatever Node and .NET versions happen to be baked into the image — currently Node 22 and .NET SDK 10. If my target repo needs Node 20 (because of a transitive dep that doesn't support 22) or .NET 8 (LTS) or any other combination, the iterations fail at `pnpm install` / `dotnet restore` time, or worse, succeed against the wrong runtime and produce code that breaks in CI.

I have many kinds of repos — different .NET LTS lines, different Node majors, different framework versions — and I want Ralph to "just work" against each without rebuilding the sandbox image or maintaining a private fork.

## Solution

The sandbox image will ship with multiple Node and .NET SDK versions side-by-side and a small detection layer that picks the right one based on the target repo's manifests.

From the user's perspective:

- Run `ralph-afk` against any supported repo. Ralph reads the repo's `.nvmrc` / `.tool-versions` / `package.json engines` / `global.json` / `.csproj` and activates the matching runtime inside the container.
- The first iteration emits a one-line message into the NDJSON log: `runtime: node 20.11.1 (.nvmrc), dotnet 8.0.404 (global.json)`. No interaction required.
- If the repo has no manifests, Ralph silently falls back to the baked default (latest LTS) and emits a warning.
- Pre-baked active-LTS versions (Node 20, 22; .NET 8, 9, 10) cost nothing extra at runtime. Rarer versions trigger a one-time lazy install via `mise` into a named docker volume that persists across runs.
- Framework CLIs (Angular, Next, Nest, React tooling) keep working through the target repo's own `package.json` and `pnpm dlx` / `npx`; Ralph doesn't try to globally manage them.

## User Stories

1. As a Ralph user with a Node 20 monorepo, I want the sandbox to detect `.nvmrc = 20` and run Node 20 inside the container, so that `pnpm install` succeeds without me overriding anything.
2. As a Ralph user with a .NET 8 LTS service, I want the sandbox to detect `global.json` (sdk.version 8.0.x) and use .NET SDK 8.0 inside the container, so that `dotnet build` succeeds against the same toolchain as my CI.
3. As a Ralph user with a `.tool-versions` file pinning both `node` and `dotnet`, I want both versions activated simultaneously, so that fullstack iterations work end-to-end.
4. As a Ralph user with a `.mise.toml` file, I want it to take precedence over my legacy `.nvmrc`, so that mise-native projects are detected correctly.
5. As a Ralph user with a `package.json engines.node = "^22"`, I want the sandbox to pick the highest baked Node satisfying that range, so that I don't pay an install-time cost for a perfectly-acceptable baked version.
6. As a Ralph user with a `package.json engines.node = ">=24"`, I want mise to lazy-install Node 24 on the first iteration and cache it across runs, so that subsequent iterations are fast.
7. As a Ralph user with a monorepo containing several `.csproj` files all targeting `net8.0`, I want the sandbox to activate .NET 8.0 once for the whole repo, so that all subprojects build.
8. As a Ralph user with a monorepo containing `.csproj` files targeting different TFMs, I want the sandbox to pick the highest TFM and emit a warning listing the divergence, so that I'm informed of the tradeoff without being blocked.
9. As a Ralph user pointing at a repo with no Node / .NET manifests at all, I want the sandbox to silently fall back to the baked default and continue, so that scripting-only or doc-only repos don't fail to launch.
10. As a Ralph user, I want the detected versions surfaced into the NDJSON iteration log, so that I can audit which runtime the agent actually ran against.
11. As a Ralph user, I want the published image to be multi-arch (amd64 + arm64), so that I can run Ralph on an Apple Silicon laptop without QEMU emulation.
12. As a Ralph user on a slow connection, I want the active-LTS versions pre-baked into the image, so that I don't re-download Node and .NET for every fresh container.
13. As a Ralph user, I want a docker named volume to cache mise-installed runtimes across `docker run --rm` invocations, so that the second iteration with an exotic Node version is instant.
14. As a Ralph maintainer, I want the v2 image published under a `:v2` tag first (not `:latest`), so that I can soak-test it before promoting and breaking existing users.
15. As a Ralph maintainer, I want detection logic isolated in a single pure module that can be unit-tested without Docker, so that I can iterate on manifest parsing confidently.
16. As a Ralph maintainer, I want the templates (`afk.md`, `ghafk.md`, `prompt.md`, etc.) to remain version-agnostic, so that I don't have to maintain N variants of each playbook.
17. As a Ralph user, I want an env-var escape hatch (`RALPH_NODE`, `RALPH_DOTNET`) to override detection, so that I can experiment without modifying the target repo.
18. As a Ralph user with a repo whose `engines.node` is `*` or absent, I want detection to gracefully fall through, so that overly-permissive manifests don't crash the iteration.
19. As a Ralph user, I want detection to run once per loop invocation, not once per iteration, so that the agent's mid-loop edits to manifests don't change the runtime under it.
20. As a Ralph user, I want a clear warning when my requested .NET version isn't baked into the image, so that I understand why the sandbox is falling back to a different SDK.

## Implementation Decisions

### Modules

- **`detect` module (new, deep)** — pure, side-effect-free version resolver. Reads manifests in precedence order and returns a structured result with detected versions, source manifest per detection, and human-readable warnings. No Docker, no process spawn, no network. The natural seam for unit testing.
  - Interface: `detectVersions(workspaceDir) -> { node?, dotnet?, sources, warnings }`
- **`loop` driver (modify, shallow glue)** — calls `detectVersions` once before the iteration loop. Passes the result down to `runStage`. Emits warnings via the same `[sandcastle]` stderr channel used elsewhere.
- **`runner` (modify, shallow glue)** — extends the docker invocation with a named-volume mount for the mise cache and two env vars (`RALPH_NODE`, `RALPH_DOTNET`) carrying the detected versions. No host-side `docker volume create` needed; Docker auto-creates named volumes on first use.
- **`Dockerfile` (modify, restructure)** — keeps `node:22-bookworm` base for the claude CLI and shim, adds mise with Node 20 + 22 pre-installed under a non-volume-shadowed path, installs `dotnet-sdk-8.0` + `9.0` + `10.0` side-by-side via the Microsoft apt feed, and registers a new entrypoint shim.
- **Entrypoint shim (new, ~25-line bash)** — reads `RALPH_NODE` / `RALPH_DOTNET`, activates the Node version via `mise use --global` (lazy-installing if not present), validates the .NET SDK is baked (warns and falls back otherwise — apt-only installs require root and are not safe at runtime), then `exec`s the claude CLI.
- **CI workflow (modify)** — re-introduce arm64 alongside amd64 via `buildx`'s multi-platform support (single invocation, not a job matrix). Add a `runtime_tag` workflow input so baked-version bumps can be tagged separately from CLI version bumps.
- **Templates (no changes)** — remain pure prompts. Version awareness flows entirely through env vars consumed by the shim.

### Detection precedence

Most specific wins. Evaluated top-down per language; first hit short-circuits.

- **Node**: `.tool-versions` → `.mise.toml` → `.nvmrc` → `.node-version` → `package.json` `engines.node`.
- **.NET**: `global.json` (`sdk.version`) → `.csproj` `<TargetFramework>` (scanned across the whole repo, excluding `node_modules` / `bin` / `obj`).

### Resolution rules

- `engines.node` semver ranges resolve to the highest baked major satisfying the range; if none baked, the lowest major the range allows, with a warning. Mise lazy-installs the rest.
- `global.json sdk.version` passes through unchanged; `rollForward` policy is honored by `dotnet` itself, not second-guessed.
- `<TargetFramework>` of the form `netN.M` maps to `N.M`; the shim globs `/usr/share/dotnet/sdk/N.M.*` to find the actual baked patch.
- Monorepos with divergent `<TargetFramework>` values pick the highest and emit a warning listing all observed TFMs.
- Unparseable manifest → warn, fall through to next precedence step. Total miss → baked default (Node 22, .NET 10), warning logged.

### Env var contract (host → container)

- `RALPH_NODE` — optional. Exact version, major, or alias (`"lts"`). Empty / unset means "use baked default."
- `RALPH_DOTNET` — optional. Exact version or `major.minor`. Empty / unset means "use baked default."
- `RALPH_MISE_VOLUME` — optional. Override the default `ralph-mise-cache` volume name for project-scoped isolation.

### Image strategy

- Single multi-arch image (`linux/amd64`, `linux/arm64`).
- Active-LTS pre-bake: Node 20 + 22 via mise (installed at build time to a non-volume-shadowed path); .NET 8 + 9 + 10 via apt.
- A named docker volume (`ralph-mise-cache` by default) caches lazy-installed Node versions at `/home/agent/.local/share/mise`. Survives `docker run --rm`.
- Estimated image size: ~4.5–5 GB (~3 × .NET SDK × ~700 MB plus mise plus 2 Node majors plus existing layers). Worth measuring before promoting to `:latest`.

### Distribution / rollout

- First publish lands as `:v2` only. Existing users on `:latest` are unaffected until promotion.
- A soak period of one CLI release cycle (or a week of personal use), then promote `:v2` to also tag `:latest`. Old `:v1` retained as escape hatch.
- README gets a "Runtime detection" section explaining the manifests honored and the env-var override knobs.
- `@daonhan/ralph-core` minor version bump on merge. `IMAGE_REF` default stays `:latest` and naturally inherits the promoted v2 image post-soak.

## Testing Decisions

### What makes a good test here

Tests target the **external behavior** of the detection module — the version it picks given a directory of manifest fixtures — never the parsing internals, never the order of intermediate calls. A test that asserts "given a directory with `.nvmrc` containing `20.11.1`, `detectVersions` returns `node: '20.11.1'`" survives any internal refactor; a test that asserts "the `.nvmrc` parser was called before the `engines.node` parser" does not.

### Module under test

`detect` is the only module worth testing here. It's pure, it has non-trivial internal logic (semver coercion, monorepo `.csproj` traversal, precedence chains, alias resolution), and its externals (filesystem reads against a temp dir) are trivial to set up. Runner, loop, and entrypoint shim are shallow glue best validated by manual smoke tests.

### Test framework

Add `vitest` to `packages/core` `devDependencies` and a `"test": "vitest run"` script. Vitest does not ship in the published `files` array, so the npm tarball is unaffected.

### Concrete test cases

- Each manifest type alone resolves correctly: `.tool-versions`, `.mise.toml`, `.nvmrc`, `.node-version`, `package.json engines.node`, `global.json`, single `.csproj`.
- Precedence chains: `.mise.toml` shadows `.nvmrc`; `.tool-versions` shadows everything; `global.json` shadows `.csproj`.
- Semver range coercion for `engines.node`: `^22` → 22, `>=20` → 22 (highest baked satisfying), `>=24` → 24 (lazy).
- Monorepo `.csproj` divergence emits a warning and picks the highest TFM.
- Unparseable manifest falls through gracefully.
- Total miss returns undefined node / dotnet with a "no manifest found" warning.
- Aliases (`lts`, `lts/iron`) pass through to mise unchanged.

### Prior art

None in this repo (no test suite exists today). The `detect` module is the inflection point that justifies introducing one — it's the first piece of logic in this codebase whose correctness can't be eyeballed from a diff.

### Out of scope for testing

Docker container behavior, mise install behavior, the entrypoint shim's bash, CI workflow YAML. Those get manual smoke tests: `docker run --rm -e RALPH_NODE=20 ralph-sandbox:v2 node --version` and similar.

## Out of Scope

- **Framework CLIs** (Angular, React, Next, Nest, etc.) — these live in the target repo's `package.json` and resolve via `pnpm dlx` / `npx`. No global installs into the image.
- **dotnet workloads** (`blazor`, `maui`, `wasm-tools`) — out of scope for v2. Easy follow-up if demand surfaces.
- **Other runtimes** — Python, Ruby, Go, Rust, JVM, etc. Stay off the table until a concrete need appears. mise supports them, so a follow-up PRD has cheap optionality.
- **Per-iteration re-detection** — detection runs once per `runLoop` invocation. If the agent edits a manifest mid-loop, the runtime does not flip under it. Acceptable per locked design.
- **A `ralph.config.json` for per-repo overrides** — not needed initially. Env vars cover the override case; if precedence rules need to be repo-overridable later, that's a separate PRD.
- **Removing or downgrading existing baked versions** — Node 22 + .NET 10 remain the defaults to preserve existing user behavior.
- **A `:slim` variant of the image** — possible future optimization if image size becomes a complaint.

## Further Notes

### Open risks the implementer should investigate

1. **mise volume vs baked versions** — a named volume mounted at `/home/agent/.local/share/mise` overlays whatever the image baked there. The implementer should verify mise's data layout and either (a) bake the pre-installed Node versions to `/opt/mise-baked` and have the shim seed the volume on first run if empty, or (b) accept that pre-baked versions are advisory and let mise re-download them on first run per user. Option (a) is the preferred design.
2. **Claude CLI under non-default Node** — the claude installer drops a wrapper that may hardcode a Node binary path. After mise switches Node, the wrapper must still resolve. Verify by inspecting the install script; may need to either re-run `claude install` after mise activation in the entrypoint, or pin the claude CLI to the base Node via absolute path.
3. **arm64 build time under qemu** — three .NET SDKs cross-built on a GitHub-hosted amd64 runner via qemu emulation may exceed the runner's time budget. Self-hosted arm64 may become necessary if CI runs balloon.
4. **Debian 12 glibc and older Node** — mise downloads prebuilt Node tarballs. Anything older than Node 18 may not run on Debian Bookworm's glibc. Document the supported range (Node ≥18) and decline older requests with a clear error.
5. **Image size jump** — current image is ~1.5 GB; new image is ~5 GB. Users on slow connections will feel the first pull. Tag with `:v2` first to soak before promoting to `:latest`.

### Files to touch

- `packages/core/src/detect.ts` (new — deep module)
- `packages/core/src/loop.ts` (insert one call before the iteration loop)
- `packages/core/src/runner.ts` (volume mount + env vars in docker args)
- `packages/core/Dockerfile` (restructure)
- `packages/core/scripts/entrypoint.sh` (new — activation shim)
- `packages/core/package.json` (add `vitest` devDep, `test` script, ensure `scripts/` ships in `files` array)
- `.github/workflows/publish-image.yml` (multi-arch, runtime tag input)
- `README.md` (new "Runtime detection" section)

### Verification

End-to-end smoke after merge:

1. `pnpm install && pnpm -r build && pnpm -r typecheck` — clean.
2. `pnpm --filter @daonhan/ralph-core test` — `detect.ts` unit tests green.
3. `docker build -t ralph-sandbox:dev -f packages/core/Dockerfile .` — builds locally.
4. `docker run --rm -e RALPH_NODE=20 ralph-sandbox:dev node --version` — prints `v20.x.x`.
5. `docker run --rm -e RALPH_DOTNET=8.0 ralph-sandbox:dev dotnet --list-sdks` — shows 8, 9, 10.
6. `ralph-afk --print-config` against a temp repo containing `.nvmrc = 20` and `global.json` (sdk 8.0.x) — prints detected versions and image ref.
7. Real iteration against a small .NET 8 + Node 20 repo. Verify NDJSON log emits the runtime line and iteration completes.
8. CI workflow dry-run via `workflow_dispatch` with `runtime_tag=2026.05`. Confirm multi-arch image lands on Docker Hub.
