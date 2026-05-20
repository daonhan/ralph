# Plan: Multi-Version Node + .NET Runtime Support

> Source PRD: [`docs/prd/multi-version-runtime-support.md`](../prd/multi-version-runtime-support.md)

## Architectural decisions

Durable decisions that apply across all phases. Touch these only with a follow-up PRD.

- **Image tag scheme**: `:v2-alpha` during phases 1–4 (no `:latest` impact). Promotion to `:v2` then `:latest` happens only in phase 5. Old `:v1` retained indefinitely as the escape hatch.
- **Multi-arch**: `linux/amd64` + `linux/arm64`, both published from a single `docker buildx build --platform=...` invocation in `.github/workflows/publish-image.yml`. No job matrix.
- **Baked runtimes**: Node 20 + 22 (via mise, installed at image-build time to a non-volume path); .NET SDK 8 + 9 + 10 (via the Microsoft apt feed, side-by-side under `/usr/share/dotnet/sdk/`).
- **Mise cache volume**: named docker volume `ralph-mise-cache` mounted at `/home/agent/.local/share/mise`. Auto-created on first `docker run -v`. User-overridable via `RALPH_MISE_VOLUME`.
- **Mise baked-seed path**: baked Node versions live at `/opt/mise-baked` (outside the volume mount). Entrypoint shim seeds the volume from this on first run if the volume is empty. Resolves the volume-overlay-shadows-bake risk in the PRD.
- **Env var contract (host → container)**:
  - `RALPH_NODE` — optional. Exact version, major, or alias (`"lts"`). Unset means use baked default.
  - `RALPH_DOTNET` — optional. Exact version or `major.minor`. Unset means use baked default.
  - `RALPH_MISE_VOLUME` — optional. Override the cache volume name.
- **Detection module contract**: `detectVersions(workspaceDir: string) → { node?: string; dotnet?: string; sources: { node?: ManifestSource; dotnet?: ManifestSource }; warnings: string[] }`. Pure, no spawn, no network. Lives in `@daonhan/ralph-core`. Called exactly once per `runLoop` invocation, before the iteration loop.
- **Detection precedence** (most specific wins; first hit short-circuits):
  - Node: `.tool-versions` → `.mise.toml` → `.nvmrc` → `.node-version` → `package.json` `engines.node`
  - .NET: `global.json` (`sdk.version`) → `.csproj` `<TargetFramework>` (whole-repo scan, excluding `node_modules`, `bin`, `obj`)
- **Fallback on detection miss**: silent fallback to baked default (Node 22, .NET 10). Emit a warning to NDJSON via the existing `[sandcastle]` stderr channel. Never crash.
- **Templates remain version-agnostic**: `afk.md`, `ghafk.md`, `prompt.md`, `ghprompt.md`, `review.md` are unchanged by this work. Version awareness flows entirely through env vars consumed by the entrypoint shim.
- **Test framework**: vitest, in `packages/core` only. Scope of testing is the `detect` module's external behavior. Vitest stays out of the published `files` array.

---

## Phase 1: Image rebuild + env-var pipe (tracer)

**User stories**: 11, 12, 17, partial 20

### What to build

A thin end-to-end slice that proves the new runtime activation path works, before any detection logic exists. The Dockerfile is rebuilt around mise + multi-version dotnet, an entrypoint shim activates whatever the env vars request, the runner forwards those env vars from the host, and CI publishes the result as a multi-arch image under a non-default tag.

No host-side detection yet — the user supplies `RALPH_NODE` / `RALPH_DOTNET` manually. This proves the whole pipeline (image → shim → activation) end-to-end without coupling it to the parser work in phases 2–3.

### Acceptance criteria

- [ ] New Dockerfile bakes mise + Node 20 + Node 22 to `/opt/mise-baked`, plus .NET SDK 8, 9, 10 via apt. Builds clean locally on amd64.
- [ ] Entrypoint shim reads `RALPH_NODE` / `RALPH_DOTNET`, activates Node via mise (using the baked path), validates the requested dotnet SDK is present (warns and falls back otherwise), then `exec`s the claude CLI.
- [ ] Runner.ts forwards `RALPH_NODE` / `RALPH_DOTNET` from `process.env` into the container when set. No volume mount yet.
- [ ] CI workflow publishes a multi-arch (`linux/amd64,linux/arm64`) image as `:v2-alpha` on `workflow_dispatch`. `:latest` is untouched.
- [ ] Manual smoke: `docker run --rm -e RALPH_NODE=20 daonhan/ralph-sandbox:v2-alpha node --version` prints `v20.x.x`.
- [ ] Manual smoke: `docker run --rm -e RALPH_DOTNET=8.0 daonhan/ralph-sandbox:v2-alpha dotnet --list-sdks` lists 8.0, 9.0, 10.0.
- [ ] Manual smoke: `RALPH_NODE=20 RALPH_IMAGE=daonhan/ralph-sandbox:v2-alpha ralph-afk --print-config` shows the correct image ref; a real iteration against a Node-20 toy repo completes one round.
- [ ] Claude CLI still launches successfully when mise activates a non-base Node (open risk #2 in the PRD — verify and pin if necessary).
- [ ] `pnpm -r build && pnpm -r typecheck` clean.

---

## Phase 2: Detection MVP — `.nvmrc` + `global.json`

**User stories**: 1, 2, 9, 10, 15

### What to build

Introduce the `detect` module with the two most common manifest types: `.nvmrc` (Node) and `global.json` (.NET). Wire it into the loop driver so detected versions flow through the env-var pipe built in phase 1. Set up vitest in `packages/core` and lock the module's behavior with the first batch of tests.

This phase is intentionally narrow on parsers but full-breadth on plumbing: the integration into `loop.ts`, the warning emission, the NDJSON line, and the test harness all land here so phase 3 only needs to add parsers.

### Acceptance criteria

- [ ] `detect` module exists in `@daonhan/ralph-core` with the interface defined in Architectural Decisions. Implemented parsers: `.nvmrc` and `global.json`. All other manifest sources return undefined.
- [ ] `runLoop` calls `detectVersions(workspaceDir)` once before the iteration loop. Result is threaded through `LoopOptions` (or equivalent) into `runStage`, which sets the env vars.
- [ ] On detection success, the first iteration's NDJSON stream contains a line of shape `runtime: node <ver> (.nvmrc), dotnet <ver> (global.json)` (or partial when only one detected).
- [ ] On total miss, a `[sandcastle] warning: no runtime manifest found, falling back to baked default` line is emitted to stderr. Iteration continues normally.
- [ ] vitest is added to `packages/core` devDependencies; `pnpm --filter @daonhan/ralph-core test` runs and passes. Vitest is excluded from the npm tarball's `files` array.
- [ ] Test cases: `.nvmrc` containing `20.11.1`, `v20.11.1`, `20`, and a blank file; `global.json` with valid `sdk.version`, with malformed JSON, with missing `sdk.version`; total-miss directory.
- [ ] Manual smoke: a temp repo with `.nvmrc=20` and no other manifests, run via `:v2-alpha`, produces a container with Node 20 active.
- [ ] Manual smoke: a temp repo with `global.json` pinning `sdk.version: "8.0.404"` activates .NET 8 in-container.
- [ ] `pnpm -r typecheck` clean.

---

## Phase 3: Full manifest precedence + edge cases

**User stories**: 3, 4, 5, 7, 8, 16, 18, 19

### What to build

Extend the `detect` module with the remaining manifest parsers and the precedence resolver, plus the resolution rules for semver ranges and divergent monorepo `.csproj` files. The module's external contract is unchanged; only its internals grow.

This phase is detection-heavy and parser-heavy. No runner, loop, image, or CI changes. Templates remain untouched.

### Acceptance criteria

- [ ] Parsers added: `.tool-versions`, `.mise.toml` (TOML, read `tools.node` and `tools.dotnet`), `.node-version`, `package.json` `engines.node`, `.csproj` `<TargetFramework>` (recursive glob, excluding `node_modules`, `bin`, `obj`).
- [ ] Precedence resolver enforces the orderings defined in Architectural Decisions. First hit per language short-circuits.
- [ ] `engines.node` semver-range resolution: highest baked major satisfying the range when one exists; otherwise the lowest major the range allows, with a warning. Mise lazy-install (added in phase 4) picks up the rest.
- [ ] Multi-`.csproj` repos: collect unique `<TargetFramework>` values, pick the highest, emit a warning listing all observed TFMs when they diverge.
- [ ] Unparseable manifests do not crash detection — they emit a warning and fall through to the next precedence step.
- [ ] Aliases (`lts`, `lts/iron`) pass through unchanged for mise to resolve.
- [ ] Detection runs exactly once per `runLoop` invocation; manifest edits during the loop do not re-trigger detection. (Verified by code review, not a runtime test.)
- [ ] vitest cases: each parser in isolation; every precedence chain (e.g., `.mise.toml` shadowing `.nvmrc`, `.tool-versions` shadowing everything, `global.json` shadowing `.csproj`); semver coercion (`^22`, `>=20`, `>=24`, `*`); monorepo divergence; unparseable fallthrough; alias passthrough; total miss.
- [ ] Manual smoke: a repo with `.tool-versions` pinning both `node` and `dotnet` activates both correctly.
- [ ] Manual smoke: a repo with `.mise.toml` and a stale `.nvmrc` activates from `.mise.toml`.
- [ ] `pnpm -r typecheck` clean.

---

## Phase 4: Lazy install + volume cache

**User stories**: 6, 13

### What to build

Make non-baked Node versions usable without a full image rebuild. The entrypoint shim grows a lazy-install path via `mise install node@<ver>`, and the runner mounts the named cache volume so installs persist across `docker run --rm` invocations. Also resolves the open-risk volume-overlay issue from the PRD by seeding the volume from `/opt/mise-baked` on first run when empty.

### Acceptance criteria

- [ ] Runner.ts mounts `${RALPH_MISE_VOLUME ?? "ralph-mise-cache"}:/home/agent/.local/share/mise` on every stage invocation. No volume is mounted when both `RALPH_NODE` and `RALPH_DOTNET` are unset (optional optimization — acceptable to always mount).
- [ ] Entrypoint shim, on each run: if the volume mountpoint is empty, copy/seed from `/opt/mise-baked`. Then activate `RALPH_NODE`; if not present, `mise install node@$RALPH_NODE && mise use --global node@$RALPH_NODE`. Failures surface to stderr and exit non-zero.
- [ ] `RALPH_DOTNET` continues to require a baked SDK; no lazy install for .NET (apt-only, root-required). The shim's existing warn-and-fall-back behavior from phase 1 is preserved.
- [ ] Manual smoke: `RALPH_NODE=24 ralph-afk` (no `.nvmrc`, no manifest) on a clean machine — first iteration lazy-installs Node 24 inside the volume, second iteration is fast (no re-install).
- [ ] Manual smoke: `docker volume rm ralph-mise-cache && ralph-afk` works — seed-from-bake path triggers; Node 20 / 22 still available without download.
- [ ] Manual smoke: `RALPH_MISE_VOLUME=my-proj ralph-afk` uses a project-scoped volume; the default volume is unaffected.
- [ ] `pnpm -r typecheck` clean.

---

## Phase 5: Promotion + docs

**User stories**: 14

### What to build

Operationalize the rollout. After a soak period on `:v2-alpha`, retag to `:v2`, then promote `:v2` to also tag `:latest`. Expose a `runtime_tag` workflow input so baked-version bumps can be cut independently of CLI version bumps. Document the runtime-detection behavior in the README. Bump `@daonhan/ralph-core` minor version.

### Acceptance criteria

- [ ] `.github/workflows/publish-image.yml` accepts a `runtime_tag` `workflow_dispatch` input. When provided, the image is also tagged with that string (e.g., `runtime-2026.05`).
- [ ] At least one soak iteration of `:v2-alpha` against a real target repo per stack (Node-only, .NET-only, fullstack) confirms parity with `:v1`. Soak period: one week of personal use or one CLI release cycle, whichever is shorter.
- [ ] `:v2-alpha` is retagged to `:v2` via the publish workflow.
- [ ] `:v2` is promoted: a subsequent workflow run also tags it `:latest`. `:v1` remains on Docker Hub as the escape hatch.
- [ ] README gains a "Runtime detection" section explaining the supported manifests, the precedence rules, the env-var override knobs, and the lazy-install behavior.
- [ ] `@daonhan/ralph-core` `package.json` minor version bumped. CLI package `package.json` updated to depend on the new core version. `pnpm publish-all` dry-run is clean.
- [ ] `docs/PUBLISHING.md` updated with the new runtime-tag input and the soak-then-promote flow.
- [ ] No code change to `IMAGE_REF` default needed — `:latest` naturally inherits the promoted image.
