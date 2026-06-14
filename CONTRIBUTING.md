# Contributing to Ralph

This guide is for **maintainers and contributors hacking on the monorepo itself** —
the loop driver, host runner, template renderer, CLI bins, and release pipeline.
If you just want to _run_ Ralph against your own repo, see [`./README.md`](./README.md)
(and [`./QUICKSTART.md`](./QUICKSTART.md) for the short path). For the runtime model
(loop topology, stages, the claude run line), read [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Prerequisites

| Tool   | Version | Why                                                           |
| ------ | ------- | ------------------------------------------------------------- |
| Node   | ≥ 20    | ESM, `node --test`, `tsc`.                                    |
| pnpm   | ≥ 9     | Workspace linking. Root pins `packageManager: pnpm@9.12.0`.   |
| claude | latest  | Running the loop on the host (logged in via `claude /login`). |

`corepack enable` will activate the pinned pnpm automatically.

## Workspace setup

Clone, then install once. This links the two workspace packages and hoists the
shared devDependencies, and runs the root `prepare` script (which installs the
husky git hooks — see [Pre-commit hook](#pre-commit-hook)).

```bash
pnpm install
```

```powershell
pnpm install
```

## Build

Only `packages/core` has a build step (`tsc -p tsconfig.json` → `dist/`).
`apps/cli` has **no build** — its bins are hand-written ESM JS that import
`@daonhan/ralph-core`.

```bash
pnpm -r build                 # compile packages/core/dist
pnpm --filter @daonhan/ralph-core build   # core only
pnpm -r clean                 # wipe dist/ + tsconfig.tsbuildinfo
```

```powershell
pnpm -r build
pnpm --filter @daonhan/ralph-core build
pnpm -r clean
```

## Verify

There **is** a test suite and a linter — older docs that said "no test suite, no
linter" were wrong. The full local verification is:

```bash
pnpm -r typecheck             # tsc --noEmit across the workspace
pnpm -r build                 # the .mjs scripts import from packages/core/dist
pnpm -r test                  # per-package tests (vitest in core; cli has none)
pnpm test                     # ROOT: node --test over scripts/*.test.mjs
node scripts/smoke-render.mjs
node scripts/smoke-templates.mjs
node scripts/smoke-spill-size.mjs
node scripts/smoke-spill-large.mjs
```

Note the layered meaning of "test" in this monorepo:

- **`pnpm -r test`** — recursive, runs each package's `test` script.
  `packages/core` → `vitest run`; `apps/cli` has no `test` script (skipped).
- **`pnpm test`** (root) → `node --test`, which discovers `scripts/*.test.mjs`.

### What each test covers

Vitest unit tests, `packages/core/src/__tests__/` (pure logic, mocked I/O):

| File                | Covers                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `loop.test.ts`      | `runLoop` iteration walk, the gate sentinel, wake-lock acquire/release, per-stage retry, SIGINT/SIGTERM abort. |
| `runner.test.ts`    | `parseGraceMs` (post-result grace timer env parsing).                                                          |
| `retry.test.ts`     | `withRetries` / `backoffFor` (per-stage retry policy).                                                         |
| `detach.test.ts`    | `stripDetachFlags` / `detachAndExit` (`--detach` flag handling).                                               |
| `keepalive.test.ts` | `acquire` (host wake-lock spawning).                                                                           |
| `notify.test.ts`    | `notify` (`--notify` completion hook spawning).                                                                |

Root `node --test`, `scripts/*.test.mjs` (contract + pure-render tests):

| File                                 | Covers                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `release-please-config.test.mjs`     | Reproduces release-please path attribution; catches component-scoping drift. |
| `registries-not-behind-git.test.mjs` | Guards that published npm versions don't lag their git release tags.         |
| `update-status-table.test.mjs`       | `renderStatusTable` / `replaceBlock` for the RELEASING.md status block.      |

Smoke scripts in `scripts/` (import the built `dist/`, so run after `pnpm -r build`):

| Script                  | Checks                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `smoke-render.mjs`      | Four of the five `renderTemplate` tag forms (`@include`, `@spill`, `!?`, `{{ INPUTS }}`) on a synthetic template. |
| `smoke-templates.mjs`   | The real shipped `afk.md` / `ghafk.md` / `review.md` render and stay small.                                       |
| `smoke-spill-size.mjs`  | Heavy `@spill` output lands in the spill file, not the prompt.                                                    |
| `smoke-spill-large.mjs` | A ~200 KB `@spill` payload spills while the prompt keeps only a short ref path.                                   |

## Pre-commit hook

`pnpm install` runs the root `"prepare": "husky || git config core.hooksPath .husky"`
script, which installs the git hooks or falls back to setting `core.hooksPath`.
On commit, [`.husky/pre-commit`](./.husky/pre-commit) runs:

```bash
pnpm exec lint-staged    # prettier --ignore-unknown --write on staged files
pnpm typecheck           # tsc --noEmit across the workspace
```

lint-staged config is [`.lintstagedrc`](./.lintstagedrc): `{ "*": "prettier
--ignore-unknown --write" }`. A type error blocks the commit — fix it, don't
bypass. If hooks didn't install (e.g. you cloned without `pnpm install`), run
`pnpm install` again.

## Repo layout

```
packages/core/          @daonhan/ralph-core (library; the only built package)
  src/                  12 TS modules + __tests__/  (see docs/ARCHITECTURE.md)
  templates/            prompt.md, ghprompt.md, afk.md, ghafk.md, review.md
  dist/                 tsc output (gitignored)
apps/cli/               @daonhan/ralph (hand-written JS bins; no build)
  bin/                  ralph-afk.js, ralph-ghafk.js
scripts/                *.test.mjs + smoke-*.mjs + update-status-table.mjs
.github/workflows/      release-please.yml, publish-npm.yml
RELEASING.md            release/publish source of truth
```

`packages/core/src/` modules, in reading order:
[`main.ts`](./packages/core/src/main.ts) / [`gh-main.ts`](./packages/core/src/gh-main.ts)
(bin entrypoints), [`loop.ts`](./packages/core/src/loop.ts),
[`render.ts`](./packages/core/src/render.ts), [`runner.ts`](./packages/core/src/runner.ts),
[`stages.ts`](./packages/core/src/stages.ts), [`index.ts`](./packages/core/src/index.ts)
(public surface), plus internals `cli-help`, `retry`, `keepalive`, `detach`, `notify`.
See [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full runtime model.

## Adding a pipeline stage

Three steps:

1. **Extend `STAGES`** in [`packages/core/src/stages.ts`](./packages/core/src/stages.ts).
2. **Add the template** as a new `*.md` under `packages/core/templates/`.
3. **Wire it into a chain** in [`main.ts`](./packages/core/src/main.ts) (the
   `ralph-afk` chain) and/or [`gh-main.ts`](./packages/core/src/gh-main.ts) (the
   `ralph-ghafk` chain), via the `stages:` array passed to `runLoop`.

Hard invariants:

- **`permissionMode` must be `"bypassPermissions"`** — never `acceptEdits`. AFK
  requires non-interactive bash/edit approval; under the default `sandbox` runner
  the blast radius is bounded to the workspace tree and is git-recoverable.
- **The first stage of a chain is the gate.** Only index 0 is sentinel-checked for
  the exact literal `<promise>NO MORE TASKS</promise>`; the reviewer never gates.
  Place any gating stage at index 0.

```ts
// packages/core/src/stages.ts
export const STAGES = {
  // ...
  myStage: {
    name: "my-stage",
    template: "my-stage.md",
    permissionMode: "bypassPermissions", // required for sandbox stages
  } satisfies Stage,
};
```

```ts
// packages/core/src/main.ts — gate must be index 0
await runLoop({
  stages: [STAGES.implementer, STAGES.myStage, STAGES.reviewer],
  // ...
});
```

## Customizing prompts

The agent playbooks are plain Markdown, each self-contained:

- [`packages/core/templates/prompt.md`](./packages/core/templates/prompt.md) — the
  `ralph-afk` (plan/PRD) playbook: where the work comes from (`<inputs>`) + progress recording,
  plus the task-priority ladder, feedback loops, commit rules, and final rules.
- [`packages/core/templates/ghprompt.md`](./packages/core/templates/ghprompt.md) — the
  `ralph-ghafk` (GitHub-issue) playbook: issue triage + close/comment the issue, plus the same
  shared task ladder / feedback loops / commit rules / final rules.

The iteration templates `afk.md` / `ghafk.md` each `@include` their respective playbook;
`review.md` is standalone. Edit a playbook to change task priority, feedback loops, or
loop-specific behavior. The renderer's `@include` is single-pass (a file pulled in by
`@include` is not re-scanned for further `@include`s), so the include lives at the top level of
`afk.md` / `ghafk.md` — don't nest an `@include` inside `prompt.md` / `ghprompt.md`. After
editing, run `node scripts/smoke-templates.mjs` to confirm it still renders.

## Smoke-test published artifacts

Verify the _published shape_ before cutting a release with the pack-then-install
path. `pnpm link --global` is brittle here (pnpm 9 rewrites the dependent's
manifest), so don't use it. The `*.tgz` globs below are version-agnostic.

```bash
pnpm -r build
(cd packages/core && pnpm pack --pack-destination /tmp/ralph-packs)
(cd apps/cli      && pnpm pack --pack-destination /tmp/ralph-packs)
npm i -g /tmp/ralph-packs/daonhan-ralph-core-*.tgz \
         /tmp/ralph-packs/daonhan-ralph-*.tgz
ralph-afk          # → prints usage
```

```powershell
pnpm -r build
pnpm --filter @daonhan/ralph-core pack --pack-destination $env:TEMP\ralph-packs
pnpm --filter @daonhan/ralph      pack --pack-destination $env:TEMP\ralph-packs
npm i -g (Get-ChildItem $env:TEMP\ralph-packs\daonhan-ralph-core-*.tgz).FullName `
         (Get-ChildItem $env:TEMP\ralph-packs\daonhan-ralph-*.tgz).FullName
ralph-afk          # -> prints usage
```

`pnpm pack` rewrites the CLI's `workspace:^` core dependency to a concrete spec in
the tarball, so the installed `@daonhan/ralph` resolves a real `@daonhan/ralph-core`.

## Releasing

Releasing is **automated** — you do not bump versions or publish by hand.
[`./RELEASING.md`](./RELEASING.md) is the single source of truth (it supersedes the
`docs/PUBLISHING.md` stub); this section is just the shape of the flow.

The repo ships two independently versioned npm components: `@daonhan/ralph-core`
and `@daonhan/ralph`. Flow:

1. Land Conventional-Commit work on `main` (see [Conventions](#conventions-to-preserve)).
2. `release-please.yml` opens **one Release PR per component** with unreleased commits.
3. Merging a Release PR cuts the component tag (`<component>-vX.Y.Z`) + GitHub Release.
4. The tag triggers publishing:
   - `ralph-core-v*` / `ralph-v*` → `publish-npm.yml` (publishes to npm; rewrites the
     CLI's `workspace:^` to the concrete core version; attaches `.tgz` + SBOM + cosign
     attestation to the Release).

Required secrets: `RELEASE_PLEASE_TOKEN` (a PAT — a tag made with the default
`GITHUB_TOKEN` will **not** trigger the downstream publish workflows), `NPM_TOKEN`.

See [`./RELEASING.md`](./RELEASING.md) for the version policy, `Release-As:`
overrides, the rollback runbook, and the compatibility matrix.

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`; relative imports in
  `packages/core/src/` end in `.js` (compiled extension, required by
  `moduleResolution: NodeNext`).
- **No TS / no build in `apps/cli`.** Keep the bin layer flat hand-written JS.
- **First stage is the gate.** Gating stages go at index 0; sentinel is the exact
  literal `<promise>NO MORE TASKS</promise>`.
- **`bypassPermissions` for every sandbox stage.** Never `acceptEdits`.
- **Templates ship in the core tarball** (`@daonhan/ralph-core` `files: ["dist",
"templates", "README.md"]`). A new stage means a new `templates/*.md` plus the
  `STAGES` + chain wiring.
- **Conventional-commit messages drive release-please.** The commit type sets the
  bump and CHANGELOG section, and the path decides the component — see
  [`./RELEASING.md`](./RELEASING.md) section 3.
- **Template shell tags must stay static.** The `` !`cmd` ``, `` !?`cmd` ``, and
  `@spill` tags run their command body on the **host shell**. Only ever put static
  command strings in a tag body — never interpolate runtime or untrusted data (INPUTS,
  issue/commit text, branch names) into one. `{{ INPUTS }}` is substituted last and is
  read by the agent from the prompt file, never re-shelled on the host. Breaking this
  invariant is direct host RCE — see [`./SECURITY.md`](./SECURITY.md).
