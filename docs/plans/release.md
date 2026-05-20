# Plan: Release management

> Source PRD: `docs/prd/release.md`

## Architectural decisions

Durable decisions that apply across all phases. Do not relitigate these inside a phase.

- **Release driver**: `release-please` (Google) via the `googleapis/release-please-action@v4` GitHub Action. Manifest mode, monorepo multi-component.
- **Config files at repo root**: `release-please-config.json` (component declarations) and `.release-please-manifest.json` (last-released versions, source of truth).
- **Components** (three, independently versioned, never lockstep):
  - `ralph-core` rooted at `packages/core`
  - `ralph` rooted at `apps/cli`
  - `ralph-sandbox` rooted at `packages/core`, path-scoped to `packages/core/Dockerfile` and `packages/core/templates/**` (synthetic image component)
- **Tag schema**: `ralph-core-vX.Y.Z`, `ralph-vX.Y.Z`, `ralph-sandbox-vX.Y.Z`. Each publish workflow filters on its own tag prefix.
- **Bootstrap seeds**: `ralph-core@0.1.1`, `ralph@0.1.0`, `ralph-sandbox@0.1.1` (matches the existing `image-v0.1.1` tag). First release PR proposes patch bumps from these baselines based on commits since the last release.
- **CHANGELOG location**: single root `CHANGELOG.md`. All three components write per-section entries into it. The npm tarball does not ship the CHANGELOG.
- **Release doc location**: root `RELEASING.md`. Supersedes `docs/PUBLISHING.md`.
- **Status-table contract**: HTML-comment markers `<!-- status-table:start -->` and `<!-- status-table:end -->` inside `RELEASING.md`. The renderer is the only thing that may overwrite content between those markers.
- **Versioning policy**: independent per component. 0.x is treated as a stable contract — breaking change forces `1.0.0`. Pre-release tags (`-rc.N`, `-next.N`) are opt-in via the `release-as:` commit footer.
- **Conventional Commits**: existing convention (`feat:`, `fix:`, `chore:`, `ci:`, `refactor:`, `perf:`, `deps:`) drives both the bump type and the CHANGELOG section. No contributor behavior change required.
- **Concurrency**: release-please uses concurrency group `release-please-${{ github.ref }}`. Publish workflows use existing per-workflow groups. No global lock.
- **Permission model on publish stays `bypassPermissions`** is unrelated; this is the Claude AFK loop's concern, not the release loop's.
- **Existing artifacts are preserved**: `@daonhan/ralph-core@0.1.1`, `@daonhan/ralph@0.1.0`, and the `image-v0.1.1` Git tag remain. Nothing is re-published or moved.

---

## Phase 1: Bootstrap release-please + rewire `ralph-core` publish

**User stories**: 1, 2, 3, 4, 10, 11, 19, 20, 21, 22, 24

### What to build

Adopt release-please for `ralph-core` only as the first vertical slice. End-to-end this means: a maintainer pushes a `feat:` or `fix:` commit to `main`, release-please opens a Release PR proposing the next `ralph-core` version and the `CHANGELOG.md` diff, the maintainer merges the PR, a `ralph-core-vX.Y.Z` tag is created, and the rewired npm publish workflow fires and publishes `@daonhan/ralph-core` to the registry.

The slice cuts through every layer: config (manifest + release-please-config), CI (new `release-please.yml` + rewritten `publish-npm.yml`), docs (stub `RELEASING.md` with the policy section and an empty status-table block), and verification (cut a real release through the new path).

The CLI and image components do not participate yet. The old path-based trigger in `publish-npm.yml` is removed in this phase so there is one source of truth for "when does core publish".

### Acceptance criteria

- [ ] `release-please-config.json` and `.release-please-manifest.json` exist at repo root, declaring `ralph-core` only, seeded at `0.1.1`
- [ ] `.github/workflows/release-please.yml` runs on push to `main` and opens / updates a release PR when there are unreleased commits
- [ ] `.github/workflows/publish-npm.yml` is rewritten to trigger on `push: tags: ['ralph-core-v*']` and publishes `packages/core` based on the tag prefix
- [ ] The old path-filter-based trigger on `publish-npm.yml` is removed
- [ ] A no-op release PR can be opened by pushing a `chore:` commit, and the maintainer can verify the proposed CHANGELOG diff before merging
- [ ] Merging the release PR creates a `ralph-core-vX.Y.Z` tag, the publish workflow fires, and `@daonhan/ralph-core@X.Y.Z` appears on the npm registry
- [ ] Root `CHANGELOG.md` is created and contains the first release entry grouped by Conventional Commit type
- [ ] Stub `RELEASING.md` at repo root exists with: the policy section (independent + 0.x-as-stable), the empty `<!-- status-table -->` block, and a TODO list for the sections that arrive in later phases

---

## Phase 2: Add `ralph` CLI as second release-please component

**User stories**: 5

### What to build

Extend release-please to manage `apps/cli`. The CLI currently lags `ralph-core` silently because no CI path publishes it. After this slice, a commit that touches `apps/cli/**` triggers its own Release PR section and tag, and merging it publishes `@daonhan/ralph` to npm via the same workflow used for core.

End-to-end: the existing `publish-npm.yml` learns to route by tag prefix (`ralph-core-v*` → `packages/core`, `ralph-v*` → `apps/cli`). Manifest seeds `ralph@0.1.0`. Release-please config gains the second component declaration. The CHANGELOG starts receiving CLI entries in its own subsection.

This slice is small on purpose. It validates that the multi-component pattern works before adding the more unusual image component.

### Acceptance criteria

- [ ] `release-please-config.json` declares `ralph` rooted at `apps/cli`
- [ ] `.release-please-manifest.json` seeds `ralph@0.1.0`
- [ ] `publish-npm.yml` triggers on both `ralph-core-v*` and `ralph-v*` and routes the publish step to the correct package directory based on `${GITHUB_REF_NAME}`
- [ ] A commit touching only `apps/cli/**` causes release-please to propose a bump for `ralph` and not `ralph-core`
- [ ] Merging a `ralph` release PR creates a `ralph-vX.Y.Z` tag and publishes `@daonhan/ralph@X.Y.Z` to npm
- [ ] CHANGELOG entries for the CLI appear under a clearly distinct subsection

---

## Phase 3: Add `ralph-sandbox` synthetic image component

**User stories**: 6, 12

### What to build

Introduce the third release-please component: a synthetic `ralph-sandbox` rooted at `packages/core` but path-scoped to `packages/core/Dockerfile` and `packages/core/templates/**`. This is the novel piece of the configuration: it lets a Dockerfile or template change bump the image version without dragging `ralph-core` along, and vice versa.

End-to-end: a Dockerfile or template change on `main` causes release-please to open (or update) a `ralph-sandbox` release PR. Merging it creates a `ralph-sandbox-vX.Y.Z` tag. The rewritten `publish-image.yml` triggers on that tag, builds the image, pushes to Docker Hub, captures the `sha256:…` digest emitted by buildx, and appends `Image: docker.io/daonhan/ralph-sandbox@sha256:…` to the GH Release body via `gh release edit`.

The previous `image-v*` push trigger is kept as a compatibility shim alongside the new trigger; removal happens in a follow-up after one good release through the new path. `workflow_dispatch` is retained for emergency rebuilds (CVE in base image, etc.) that don't warrant a semver bump.

### Acceptance criteria

- [ ] `release-please-config.json` declares `ralph-sandbox` rooted at `packages/core` with the path scope restricted to `Dockerfile` and `templates/**`
- [ ] `.release-please-manifest.json` seeds `ralph-sandbox@0.1.1`
- [ ] A commit touching `packages/core/src/**` does **not** open a `ralph-sandbox` release PR
- [ ] A commit touching `packages/core/Dockerfile` or `packages/core/templates/**` **does** open a `ralph-sandbox` release PR
- [ ] `publish-image.yml` triggers on `ralph-sandbox-v*` tags, builds + pushes the image, and is the new primary path
- [ ] After push, the workflow appends the image digest to the corresponding GH Release body in the form `Image: docker.io/daonhan/ralph-sandbox@sha256:…`
- [ ] `image-v*` trigger remains in the workflow for one release as a fallback; `workflow_dispatch` remains available

---

## Phase 4: GH Release artifact enrichment

**User stories**: 14, 15

### What to build

Every published release produces a discoverable, auditable GH Release. This slice attaches `.tgz` tarballs from `pnpm pack`, generates an SBOM via `syft`, and produces a sigstore attestation via `cosign` for each artifact. For the image, the digest already lives in the release body (Phase 3); this phase adds the SBOM + attestation for the image as separate artifacts.

End-to-end: the existing publish workflows gain inline post-publish steps that pack, SBOM, attest, and `gh release upload` the resulting files. The separate `release-artifacts.yml` from the PRD draft is **not** created — the inline approach is preferred over the `workflow_run` indirection because it keeps publish + attest atomic and failure-correlatable in one workflow run.

### Acceptance criteria

- [ ] After a successful `@daonhan/ralph-core` publish, the corresponding GH Release contains the `.tgz` produced by `pnpm pack`, an SBOM file, and a cosign attestation
- [ ] After a successful `@daonhan/ralph` publish, the corresponding GH Release contains the same three artifacts
- [ ] After a successful image publish, the corresponding GH Release contains an SBOM and a cosign attestation for the image, in addition to the digest in the body
- [ ] Failure to produce an SBOM or attestation fails the workflow loudly; it does not silently skip
- [ ] Artifact filenames follow a predictable convention so users can fetch them programmatically

---

## Phase 5: Status table + updater script (with unit test)

**User stories**: 7, 8, 25

### What to build

A maintainer should be able to read `RELEASING.md` and learn the currently-published version of every component, the date it shipped, and a link to the tag, without leaving the document. This slice introduces a Node script that reads `.release-please-manifest.json` plus tag metadata and rewrites the `<!-- status-table:start -->` / `<!-- status-table:end -->` block in `RELEASING.md`.

End-to-end: the script lives at `scripts/update-status-table.mjs`. It exports a pure rendering function `renderStatusTable(manifest, tagInfo) → markdown`, which is the deep module — stable signature, no side effects, easy to test. The script's outer shell wires in git/GH calls. The script is registered with release-please as an `extra-files` hook so it runs as part of the release PR; the maintainer reviews the refreshed table in the PR diff. The script is also runnable locally for manual refresh.

A unit test using `node --test` exercises `renderStatusTable` against a fixture manifest and a fixture tag-info object, snapshotting the expected markdown block. `node --test` is preferred over adding `vitest` for two tests; this decision can be revisited if the test surface grows.

### Acceptance criteria

- [ ] `scripts/update-status-table.mjs` exists and exports `renderStatusTable(manifest, tagInfo)` as a pure function
- [ ] Running the script locally regenerates the status-table block in `RELEASING.md` deterministically
- [ ] release-please's `extra-files` hook (or equivalent) invokes the script as part of the release PR, so the refreshed table appears in the PR diff
- [ ] A `node --test` fixture exists for `renderStatusTable` and runs as part of `pnpm test` (a new top-level script that gets added in this phase or earlier)
- [ ] The table includes, per component: name, current version, release date, link to the corresponding Git tag
- [ ] Manual edits anywhere outside the marker block are preserved by the script

---

## Phase 6: Complete `RELEASING.md` + retire `docs/PUBLISHING.md`

**User stories**: 9, 13, 16, 17, 18, 22, 23

### What to build

Fill out the rest of `RELEASING.md` so a new contributor (or LLM agent) can ship a release end-to-end without paging the maintainer. The status table and policy section already exist (Phases 1 and 5). This slice adds the remaining sections and migrates `docs/PUBLISHING.md`.

End-to-end: `RELEASING.md` becomes the single source of truth, covering the maintainer flow, commit conventions, the pre-release opt-in mechanism, a rollback runbook with concrete commands for both npm (`npm deprecate`) and Docker (tag removal / repointing), a compatibility matrix mapping CLI versions to required core versions and tested image tags, and the tag-naming conventions tied to the synthetic component. `docs/PUBLISHING.md` is replaced with a one-line pointer to `RELEASING.md` to avoid breaking external links.

### Acceptance criteria

- [ ] `RELEASING.md` contains all eight sections from the PRD: status table, how to cut a release, Conventional Commit guide, version policy, pre-release opt-in, rollback runbook, compatibility matrix, tag naming
- [ ] The rollback runbook contains concrete commands for `npm deprecate` (per affected version) and for removing or repointing a bad image tag on Docker Hub
- [ ] The compatibility matrix lists known-good combinations of `@daonhan/ralph` × `@daonhan/ralph-core` × `ralph-sandbox` image tag, with at least the current set populated
- [ ] The `release-as:` commit-footer override is documented with at least one example
- [ ] `docs/PUBLISHING.md` is reduced to a single line pointing at `RELEASING.md` and the prior content lives in `RELEASING.md`
- [ ] No section of `RELEASING.md` requires external context that is not also in the document or in a clearly named referenced file

---

## Phase 7: release-please config dry-run contract test

**User stories**: implicit (testing decision in the PRD)

### What to build

The `ralph-sandbox` synthetic component is the most novel and most easily mis-configured piece of `release-please-config.json`. A small contract test runs `release-please --dry-run` (or its programmatic equivalent) against a synthetic commit-history fixture and asserts the proposed manifest update matches expectation. The fixture covers three cases: a `feat:` commit touching only `packages/core/src/**` (must bump `ralph-core` only), a commit touching `packages/core/Dockerfile` (must bump `ralph-sandbox` only), and a commit touching `apps/cli/**` (must bump `ralph` only).

End-to-end: the test lives next to the Phase 5 unit test and runs under the same `pnpm test` script. It catches config drift at PR time rather than at release time, which protects the synthetic component's path scoping from accidental regression.

### Acceptance criteria

- [ ] A test file exists that runs release-please against a controlled fixture (synthetic git history or stubbed commit list)
- [ ] The test asserts that a `feat:` commit touching only `packages/core/src/**` bumps `ralph-core` and not `ralph-sandbox`
- [ ] The test asserts that a `feat:` commit touching only `packages/core/Dockerfile` bumps `ralph-sandbox` and not `ralph-core`
- [ ] The test asserts that a `feat:` commit touching only `apps/cli/**` bumps `ralph` and not the others
- [ ] The test runs under `pnpm test` alongside the Phase 5 unit test
- [ ] Test failures clearly identify which component the drift affected
