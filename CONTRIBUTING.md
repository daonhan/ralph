# Contributing to Ralph

This guide is for **maintainers and contributors hacking on the monorepo itself** —
the loop driver, docker runner, template renderer, CLI bins, and release pipeline.
If you just want to _run_ Ralph against your own repo, see [`./README.md`](./README.md)
(and [`./QUICKSTART.md`](./QUICKSTART.md) for the short path). For the runtime model
(loop topology, stages, the docker run line), read [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Prerequisites

| Tool   | Version | Why                                                           |
| ------ | ------- | ------------------------------------------------------------- |
| Node   | ≥ 20    | ESM, `node --test`, `tsc`.                                    |
| pnpm   | ≥ 9     | Workspace linking. Root pins `packageManager: pnpm@9.12.0`.   |
| Docker | any     | Running the loop and the image / `ensure-image` smoke checks. |

`corepack enable` will activate the pinned pnpm automatically.

## Workspace setup

Clone, then install once. This links the two workspace packages and hoists the
shared devDependencies. The root `prepare` script installs prek hooks when prek
is available and skips hook setup in CI. If prek is missing, install it and run
`pnpm hooks:install`; see [Pre-push hook with prek](#pre-push-hook-with-prek).
Both [pre-commit](#pre-commit-hook-with-prek) and pre-push use prek.

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

Run inexpensive checks first and stop when a command fails. The required local
verification for runtime, tooling, or agent-behavior changes is:

```bash
git diff --check             # whitespace errors before compiler/test work
pnpm -r typecheck             # tsc --noEmit across the workspace
pnpm -r build                 # the .mjs scripts import from packages/core/dist
pnpm -r test                  # per-package tests (vitest in core; cli has none)
pnpm test                     # ROOT: node --test over scripts/*.test.mjs
node scripts/smoke-render.mjs
node scripts/smoke-templates.mjs
node scripts/smoke-spill-size.mjs
node scripts/smoke-spill-large.mjs
node scripts/ensure-image-integration.mjs   # needs Docker + the real CLI
```

```powershell
git diff --check
pnpm -r typecheck
pnpm -r build
pnpm -r test
pnpm test
node scripts/smoke-render.mjs
node scripts/smoke-templates.mjs
node scripts/smoke-spill-size.mjs
node scripts/smoke-spill-large.mjs
node scripts/ensure-image-integration.mjs
```

The first five commands are the pre-push gate. The offline smoke checks also run
in CI for changes that require validation. Run the Docker integration smoke when
image-resolution behavior changes; it is not part of the ordinary CI gate.
Build before root tests and smoke scripts so they cannot test stale `dist/` output.

Agents must run Node tests in the background without opening visible terminal
windows, capture the results, and distinguish **pending**, **passed**, **failed**
and **skipped** checks. State the reason for every skipped check and the limits of
any partial validation. A hook or configuration check does not prove a hosted
workflow or a live publish succeeded.

Note the layered meaning of "test" in this monorepo:

- **`pnpm -r test`** — recursive, runs each package's `test` script.
  `packages/core` → `vitest run`; `apps/cli` has no `test` script (skipped).
- **`pnpm test`** (root) → `node --test`, which discovers `scripts/*.test.mjs`.

The full sandbox-image smoke is intentionally not part of these ordinary test
commands because it builds an image and, by default, reaches PyPI. Run it explicitly
for image changes as described in [Verify sandbox image changes](#verify-sandbox-image-changes).

### What each test covers

Vitest unit tests, `packages/core/src/__tests__/` (pure logic, mocked I/O):

| File                        | Covers                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `agents.test.ts`            | Provider selection, Claude/Codex command construction, credential mounts, and model/config precedence.         |
| `agent-decoders.test.ts`    | Claude and Codex JSONL decoding, normalized events, completion, and failure contracts.                         |
| `loop.test.ts`              | `runLoop` iteration walk, the gate sentinel, wake-lock acquire/release, per-stage retry, SIGINT/SIGTERM abort. |
| `run-log.test.ts`           | Run event log writer and reducer, pid liveness, the claim (`findLiveRun`, `findRunContainer`), `pruneRunLogs`. |
| `runner.test.ts`            | `parseGraceMs` (post-completion grace timer env parsing).                                                      |
| `runner-stream.test.ts`     | Selected-provider streaming, credential isolation, completion, and process-exit behavior.                      |
| `runner-containers.test.ts` | `parseRunContainers` / `runningRunContainers`: the claim's `docker ps` label probe; no docker reads as none.   |
| `stream-render.test.ts`     | Console rendering of normalized provider events.                                                               |
| `run-bin.test.ts`           | CLI provider selection, agent wiring into the loop, `EXIT_CODES` (`failed` → 1, `refused` → 75, else 0).       |
| `cli-help.test.ts`          | `--agent`, `--codex-user-config`, help, and resolved config output.                                            |
| `retry.test.ts`             | `withRetries` / `backoffFor` (per-stage retry policy).                                                         |
| `detach.test.ts`            | `stripDetachFlags` / `detachAndExit` (`--detach` flag handling).                                               |
| `keepalive.test.ts`         | `acquire` (host wake-lock spawning).                                                                           |
| `notify.test.ts`            | `notify` (`--notify` completion hook spawning).                                                                |
| `template-contract.test.ts` | Shipped playbook, reviewer, history-injection and skill contracts.                                             |

Root `node --test`, `scripts/*.test.mjs` (contract + pure-render tests):

| File                             | Covers                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `release-please-config.test.mjs` | Reproduces release-please path attribution; catches component-scoping drift.              |
| `runner-floating-ref.test.mjs`   | `isFloatingRef` — when `ensureImage` must re-pull vs. short-circuit.                      |
| `smoke-image.test.mjs`           | Image-smoke argument parsing, Docker command construction, and failures; no Docker calls. |
| `update-status-table.test.mjs`   | `renderStatusTable` / `replaceBlock` for the RELEASING.md status block.                   |
| `check-changes.test.mjs`         | Docs-only gating, behavior-controlling prose, mixed changes and deleted/renamed paths.    |

Smoke scripts in `scripts/` (import the built `dist/`, so run after `pnpm -r build`):

| Script                         | Checks                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `smoke-render.mjs`             | Include, spill, try-shell and input substitution on a synthetic template.                 |
| `smoke-templates.mjs`          | The real shipped `afk.md` / `ghafk.md` / `review.md` render and stay small.               |
| `smoke-spill-size.mjs`         | Heavy `@spill` output lands in the spill file, not the prompt.                            |
| `smoke-spill-large.mjs`        | A ~200 KB `@spill` payload spills while the prompt keeps only a short ref path.           |
| `ensure-image-integration.mjs` | `ensureImage` against the real `docker` CLI (re-pull / fallback / pinned).                |
| `smoke-image.mjs`              | Builds or accepts a sandbox image, then checks the external Python/user/tooling contract. |

### Verify sandbox image changes

Every change to the sandbox image must pass this maintainer smoke before its
`ralph-sandbox` Release PR is merged and the image is published:

```bash
pnpm smoke:image
```

The default command builds `ralph-sandbox:smoke` from
`packages/core/templates/Dockerfile` with the repository root as its Docker build
context, then checks the default `agent` user, `python`, `python3`, venv creation,
pip inside the venv, recognizable `uv --version` and `uvx --version` output, the
pinned Codex binary and its required `exec --json --ephemeral`,
`--dangerously-bypass-approvals-and-sandbox`, and `--ignore-user-config`
automation flags, and an `uv` install of the pure-Python `six` package from PyPI.

To smoke an already-built release candidate without rebuilding it, pass its tag:

```bash
pnpm smoke:image -- --image ralph-sandbox:python-tooling
```

The package-install check requires network access and the command announces when it
runs. For an offline diagnostic only, skip that check explicitly with
`--skip-network` (or `RALPH_SMOKE_SKIP_NETWORK=1`):

```bash
pnpm smoke:image -- --image ralph-sandbox:python-tooling --skip-network
```

`RALPH_SMOKE_IMAGE=<tag>` is the environment-variable equivalent of `--image`.
The final pre-publish verification must run the network check; a skipped run is not
sufficient to release the image.

## Pre-commit hook with prek

The pre-commit hooks in [prek.toml](./prek.toml) run in this order and stop on the
first failure:

```bash
pnpm exec lint-staged    # prettier --ignore-unknown --write on staged files
pnpm typecheck           # tsc --noEmit across the workspace
```

lint-staged config is [`.lintstagedrc`](./.lintstagedrc): `{ "*": "prettier
--ignore-unknown --write" }`. A type error blocks the commit — fix it, don't
bypass. If hooks didn't install (e.g. you cloned without `pnpm install`), run
`pnpm hooks:install` after installing prek. The root `prepare` command,
`node scripts/install-hooks.mjs --if-available`, performs a best-effort install
when prek is present and skips installation in CI; it does not install prek.

[`.prettierignore`](./.prettierignore) excludes the generated `pnpm-lock.yaml`
layout so the formatter does not rewrite pnpm's output. Validate lockfile
consistency with `pnpm install --frozen-lockfile`, as CI does, rather than treating
the lockfile as a Prettier-managed source file.

## Pre-push hook with prek

[prek](https://prek.j178.dev/) ≥0.5.4 runs the repository's local pre-push validation
without adding a Node dependency. Install prek using its
[installation instructions](https://prek.j178.dev/installation/), then run:

```bash
uv tool install prek       # if prek is not already on PATH and uv is available
pnpm hooks:install
```

The installer installs both the pre-commit and pre-push hooks with prek.
prek must already be on `PATH`; the installer does not install tools or change
project dependencies. [scripts/install-hooks.mjs](./scripts/install-hooks.mjs)
removes the former repository-local Husky `core.hooksPath` only when it points to
`.husky` or `.husky/_`, then lets prek install into the effective Git hooks
directory. An unrelated custom `core.hooksPath` is honored rather than replaced.
The configuration is [prek.toml](./prek.toml); its system-local hook runs
[scripts/pre-push.mjs](./scripts/pre-push.mjs). Checks use the project's existing
commands, sequentially: `git diff --check`, `pnpm -r typecheck`, `pnpm -r build`,
`pnpm -r test`, then root `pnpm test`. The first failure blocks the push and stops
later checks. It neither installs packages nor starts Docker during a push.

The installed Git pre-push shim runs
[scripts/prek-pre-push.mjs](./scripts/prek-pre-push.mjs), which captures every raw
Git ref record in `RALPH_PUSH_REFS` and forwards the original input and arguments
to prek. Validation therefore handles every range in a multi-ref push, including
a docs-only first ref followed by a code ref; refs do not need separate pushes.
It runs the inexpensive whitespace check per range, then typecheck, build and
both test layers once. Direct runs of the pre-push stage through `prek run` use
prek's supplied single range (`PRE_COMMIT_FROM_REF` / `PRE_COMMIT_TO_REF`), or
conservatively check `HEAD` when no range is supplied.

The change classifier examines the outgoing Git refs, including added, modified,
renamed and deleted paths. Only a narrow allowlist of ordinary documentation
skips the compiler/test sequence; it is not a blanket `*.md` exclusion. Templates
under `packages/core/templates/`, any `AGENT.md`, `AGENTS.md`, `CLAUDE.md` or `SKILL.md`, and
content in any `skills/`, `.codex/`, `.claude/` or `.agents/` directory anywhere in
the path always require validation because prose there controls agent behavior.
Mixed code-and-doc changes and deleted code still run checks. Unknown paths
require checks; an unavailable ref comparison
fails closed and blocks the push rather than silently skipping validation.

## Documentation and review

When a change affects architecture, interfaces, or invariants, update the relevant docs before finishing. Delegate the docs pass to a sub-agent.

The primary agent must review the delegate's documentation diff for accuracy,
scope and links before declaring completion. This is a docs-only delegation:
the implementer keeps red → green implementation ownership, and the reviewer
keeps refactoring and defect-review ownership. Existing workflow authorization
still governs committing or publishing; a documentation pass grants neither.

Use the existing source of truth: README for user-visible behavior, ARCHITECTURE
for runtime contracts, SECURITY for trust boundaries and RELEASING for publishing.
Update CONTRIBUTING for developer setup or validation changes. Keep the two root
agent guides identical. Ordinary docs changes still need a link and final-diff
review even when expensive checks are skipped.

In a PR, describe the concrete behavior change and why it is needed, include a
before/after example when useful, list validation commands and their status,
identify documentation updates or explain why none apply, and state remaining
limitations. Use [the practical review checklist](./docs/REVIEW_CHECKLIST.md) and
[the PR template](./.github/PULL_REQUEST_TEMPLATE.md). Keep unrelated edits out of
the change; do not commit, push, merge or publish without the user's authorization.

## CI coverage and runner usage

[CI](./.github/workflows/ci.yml) retains an automatic verification status on every
PR and push to `main`. An inexpensive change classification runs even for
ordinary docs-only changes so a required status cannot remain pending due to
workflow path filters. Runtime, tooling and agent-behavior changes retain
typechecking, build, both test layers and all four offline smoke scripts on
Ubuntu with Node 20. Superseded verification runs are canceled.

Use the same workflow's `workflow_dispatch` inputs, `runner` and `node-version`,
to choose Ubuntu, Windows or macOS and Node 20, 22 or 24 for a full verification
run, including docs-only revisions. These broader checks are
manual: the automatic gate does not prove every operating-system/Node pairing.
Docker/image integration and network smoke remain explicit maintainer checks;
release and publish workflows are not canceled midway.

This public repository's standard GitHub-hosted runners are free under
[GitHub's Actions billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Larger runners and external services have separate charging rules. These changes
reduce runner work and duplicate publications, without promising a bill reduction
or changing account budgets.

Sampled recent CI verification jobs took about 30 seconds; docs-only classification
avoids most of that work, with checkout/classification overhead remaining. In the
2026-09-23 sandbox release, a
[tag-triggered job](https://github.com/daonhan/ralph/actions/runs/35873587756) used
6m23s and a redundant
[manual-dispatch job](https://github.com/daonhan/ralph/actions/runs/35873608682)
used another 3m12s. Keeping tag publishing and dispatching automatically only for
the `GITHUB_TOKEN` fallback would save that duplicate 3m12s (about one third of
the combined runner time) for a comparable release. Future runtime savings
depend on change mix, cache state and superseded runs; no fixed savings are
guaranteed. QEMU setup is unnecessary for the existing native `linux/amd64` image
and is removed without reducing image architecture coverage.

## Repo layout

```
packages/core/          @daonhan/ralph-core (library; the only built package)
  src/                  TS modules + __tests__/  (see docs/ARCHITECTURE.md)
    agents/             types.ts, claude.ts, codex.ts, index.ts
  templates/            prompt.md, ghprompt.md, afk.md, ghafk.md, review.md, Dockerfile
  dist/                 tsc output (gitignored)
apps/cli/               @daonhan/ralph (hand-written JS bins; no build)
  bin/                  ralph-afk.js, ralph-ghafk.js
scripts/                *.test.mjs + smoke-*.mjs + update-status-table.mjs
.github/workflows/      ci.yml, release-please.yml, publish-npm.yml, publish-image.yml
prek.toml               system-local pre-commit and pre-push hook configuration
RELEASING.md            release/publish source of truth
```

`packages/core/src/` modules, in reading order:
[`main.ts`](./packages/core/src/main.ts) / [`gh-main.ts`](./packages/core/src/gh-main.ts)
(bin entrypoints), [`loop.ts`](./packages/core/src/loop.ts),
[`render.ts`](./packages/core/src/render.ts), [`runner.ts`](./packages/core/src/runner.ts),
[`stages.ts`](./packages/core/src/stages.ts), [`index.ts`](./packages/core/src/index.ts)
(public surface), provider adapters under `agents/` (`types`, `claude`, `codex`, `index`),
plus internals `cli-help`, `retry`, `keepalive`, `detach`, `notify`.
See [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full runtime model.

## Adding a coding-agent provider

A provider implements the adapter contracts in `agents/types.ts`: command construction,
selected-provider credential mounts and environment, the named volumes it keeps across
containers (`volumeMounts`; `[]` when it needs none), the reasoning-effort levels its CLI
accepts (`effortLevels`, checked before any stage runs), and a JSONL decoder that emits
normalized events plus one terminal completion or failure. Register it in `agents/index.ts`;
do not branch the loop or renderer by provider. `RALPH_<AGENT>_MODEL` and
`RALPH_<AGENT>_EFFORT` come for free: `resolveAgentTuning` derives both names from the agent
name, and `SHARED_EFFORT_LEVELS` — what the agent-agnostic `RALPH_EFFORT` accepts — is the
intersection of every registered adapter's `effortLevels`, so a narrow new list narrows it.
`runLoop` remains provider-neutral and continues to gate only on the first stage's returned
completion text.

## Adding a pipeline stage

Three steps:

1. **Extend `STAGES`** in [`packages/core/src/stages.ts`](./packages/core/src/stages.ts).
2. **Add the template** as a new `*.md` under `packages/core/templates/`.
3. **Wire it into a chain** in [`main.ts`](./packages/core/src/main.ts) (the
   `ralph-afk` chain) and/or [`gh-main.ts`](./packages/core/src/gh-main.ts) (the
   `ralph-ghafk` chain), via the `stages:` array passed to `runLoop`.

Hard invariants:

- **`permissionMode` must be `"bypassPermissions"`** — never `acceptEdits`. It
  supplies Claude's no-approval mode; Codex uses its own no-approval flag. With
  the Docker socket disabled, persistent host writes still include the workspace
  and selected provider's read-write credential store; GitHub CLI config is
  read-only.
- **The first stage of a chain is the gate.** Only index 0 is sentinel-checked for
  the exact literal `<promise>NO MORE TASKS</promise>` on a line of its own; the
  reviewer never gates. Place any gating stage at index 0.

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
  plus the task-priority ladder, feedback loops (incl. the dotnet MSB3248 workaround), commit
  rules, and final rules.
- [`packages/core/templates/ghprompt.md`](./packages/core/templates/ghprompt.md) — the
  `ralph-ghafk` (GitHub-issue) playbook: issue triage + close/comment the issue, plus the same
  shared task ladder / feedback loops / commit rules / final rules.

The iteration templates `afk.md` / `ghafk.md` each `@include` their respective playbook;
`review.md` is standalone. Edit a playbook to change task priority, feedback loops, or
loop-specific behavior. The renderer's `@include` is single-pass (a file pulled in by
`@include` is not re-scanned for further `@include`s), so the include lives at the top level of
`afk.md` / `ghafk.md` — don't nest an `@include` inside `prompt.md` / `ghprompt.md`. After
editing, run `node scripts/smoke-templates.mjs` to confirm it still renders.

## Adding a shipped skill

Ralph ships its own [Agent Skills](https://code.claude.com/docs/en/skills) inside
`@daonhan/ralph-core`, so a playbook can reference one on any host without the user
installing anything. Today there is one: `ralph-tdd`.

1. **Create the directory** `packages/core/templates/skills/<name>/` with a `SKILL.md`.
   Reference files (`tests.md`, `mocking.md`, …) sit beside it and are read on demand;
   vendored content keeps its upstream `LICENSE` and stays byte-identical to a pinned
   commit so upstream changes stay diffable.
2. **Frontmatter rules.** `name` must equal the directory name and start with `ralph-`;
   `description` is one line, under 1024 characters (Codex's cap), and phrased for catalog
   matching ("Use when …"). Quote any description containing `": "` — an unquoted plain
   scalar with that sequence is not valid YAML and the skill silently never loads.
3. **The `ralph-` prefix is required.** On macOS/Linux a user's own `~/.claude/skills/tdd`
   resolves inside the container, and Codex injects a skill only when exactly one enabled
   skill carries the mentioned name — the prefix keeps a playbook reference deterministic.
4. **Where each provider sees it.** `runStage` mounts the whole `templates/skills`
   directory read-only: Claude at `/home/agent/ralph-skills/.claude/skills` (with
   `--add-dir /home/agent/ralph-skills` in the argv), Codex at `/home/agent/.agents/skills`.
   Both come from the adapter's `skillsMount`, so a new skill needs **no** runner or adapter
   change.
5. **Reference it from a playbook.** `prompt.md` / `ghprompt.md` name the skill in prose
   (``use the `ralph-tdd` skill``); the skill body is never `@include`d — the agent loads
   it on demand.
6. **Extend the tests.** Add cases to the `describe("shipped skills", …)` block in
   [`packages/core/src/__tests__/template-contract.test.ts`](./packages/core/src/__tests__/template-contract.test.ts)
   (frontmatter, no interactive phrasing, reference files present), then run
   `node scripts/smoke-templates.mjs` to confirm the templates still render.

Skill files live under `packages/core/templates`, so a skill-only change bumps the
`ralph-sandbox` release component, the same as a playbook edit.

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

The repo ships three independently versioned components: `@daonhan/ralph-core`,
`@daonhan/ralph`, and the synthetic `ralph-sandbox` Docker image. Current versions
live in [RELEASING.md](./RELEASING.md#1-current-versions). Flow:

1. Land Conventional-Commit work on `main` (see [Conventions](#conventions-to-preserve)).
2. `release-please.yml` opens **one combined Release PR** for every component with
   unreleased commits (separate per-component PRs conflicted on the shared manifest).
3. Merging the Release PR cuts one tag (`<component>-vX.Y.Z`) + GitHub Release per
   bumped component.
4. The tag triggers publishing:
   - `ralph-core-v*` / `ralph-v*` → `publish-npm.yml` (publishes to npm; rewrites the
     CLI's `workspace:^` to the concrete core version; attaches `.tgz` + SBOM + cosign
     attestation to the Release).
   - `ralph-sandbox-v*` (plus a legacy `image-v*` shim) → `publish-image.yml` (builds a
     **single-arch `linux/amd64`** image, pushes to Docker Hub, pins the `sha256:` digest
     - SBOM + attestation into the Release).

Required secrets: `RELEASE_PLEASE_TOKEN` (a PAT — a tag made with the default
`GITHUB_TOKEN` will **not** trigger the downstream publish workflows), `NPM_TOKEN`,
`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

With the default-token fallback, release-please dispatches sandbox-image
publishing after creating its release tag; npm publishing still needs a manual
dispatch. With the PAT, the tag is the only automatic image-publish trigger so
the same release is not built and pushed twice.

See [`./RELEASING.md`](./RELEASING.md) for the version policy, `Release-As:`
overrides, the rollback runbook, and the compatibility matrix.

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`; relative imports in
  `packages/core/src/` end in `.js` (compiled extension, required by
  `moduleResolution: NodeNext`).
- **No TS / no build in `apps/cli`.** Keep the bin layer flat hand-written JS.
- **First stage is the gate.** Gating stages go at index 0; sentinel is the exact
  literal `<promise>NO MORE TASKS</promise>` on a line of its own.
- **`bypassPermissions` for every sandbox stage.** Never `acceptEdits`; this is
  Claude's stage setting, while Codex uses its provider-specific no-approval flag.
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
  read by the agent inside the container, never re-shelled on the host. Breaking this
  invariant is direct host RCE — see [`./SECURITY.md`](./SECURITY.md).
