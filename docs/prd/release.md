# PRD: Release management

## Problem Statement

Ralph ships three independent artifacts: the `@daonhan/ralph-core` npm package, the `@daonhan/ralph` CLI npm package, and the `docker.io/daonhan/ralph-sandbox` image. Today, releasing any of them is partly manual and partly accidental:

- `packages/core` auto-publishes on any push to `main` that touches `packages/core/**` — but only if the maintainer remembers to bump `version` in the package.json by hand.
- `apps/cli` does **not** publish at all from CI. There is no workflow trigger for it, so the CLI version (currently `0.1.0`) lags `ralph-core` (`0.1.1`) silently.
- The sandbox image only ships when a maintainer pushes an `image-v*` tag manually, or fires the workflow_dispatch by hand. Dockerfile or template changes on `main` do not propagate to a new image.
- There is no CHANGELOG. To learn what changed in a version, a user must read `git log` and correlate commit dates to package.json bumps.
- There are no GitHub Releases. The only tag in the repo is `image-v0.1.1`; no release notes, no attached artifacts, no SBOM.
- There is no single document a maintainer (or new contributor) can read to learn how releases work, when to bump versions, what version policy is in force, or how to roll back a bad release.

The maintainer wants a coherent, mostly-automated release system that covers all three artifacts, surfaces what is published where, and gives users (and operators of the AFK loop) a reliable signal of what version they are running.

## Solution

Adopt **release-please** as the release driver. It reads conventional-commit history on `main`, opens a per-component "Release PR" that bumps versions and amends `CHANGELOG.md`, and on merge creates a Git tag plus a GitHub Release per component. Three CI workflows hang off those tags:

1. **release-please.yml** — opens / updates the release PRs and creates tags + GH Releases.
2. **publish-npm.yml** (rewritten) — triggered by tags `ralph-core-v*` and `ralph-v*`. Publishes the matching package to npm. Closes the current CLI publish gap.
3. **publish-image.yml** (rewritten) — triggered by tag `ralph-sandbox-v*`. Builds the image, pushes to Docker Hub, captures the digest, writes it back into the GH Release notes.

Every GH Release is enriched with: the `.tgz` from `pnpm pack` (for npm releases), an SBOM (via `syft`), a sigstore attestation (via `cosign`), and — for the image — the immutable `sha256:…` digest in the release body.

A single root-level **`RELEASING.md`** documents the procedure end-to-end: a status table of currently-published versions (auto-updated by the release-please PR), conventional-commit conventions, the 0.x-as-stable version policy, rollback runbooks for npm and Docker, and a compatibility matrix tying CLI versions to core versions and image tags.

The result: a contributor writes `feat:` / `fix:` commits as they already do, a release-please PR appears on `main`, the maintainer merges it, and three things publish themselves with a paper trail.

## User Stories

1. As a maintainer, I want a release-please PR to appear automatically when there are unreleased commits, so that I never have to remember to bump a version manually.
2. As a maintainer, I want to see one Release PR per component (core / cli / image), so that I can ship them independently and not couple unrelated changes.
3. As a maintainer, I want the release-please PR to include the proposed `CHANGELOG.md` diff, so that I can review the user-facing release notes before they go out.
4. As a maintainer, I want merging the release PR to be the single action that creates the tag and triggers publishing, so that I do not have to run any local commands to ship.
5. As a maintainer, I want `apps/cli` to publish on its own tag, so that the CLI no longer lags `ralph-core` silently.
6. As a maintainer, I want the sandbox image to bump and republish when `packages/core/Dockerfile` or `packages/core/templates/**` changes on `main`, so that users do not pull a stale image with old playbooks.
7. As a maintainer, I want a status table in `RELEASING.md` showing the currently-published version of each component, the release date, and the tag link, so that I can verify state at a glance.
8. As a maintainer, I want the status table to be auto-updated by the release-please PR, so that I never have to keep it in sync by hand.
9. As a maintainer, I want a `RELEASING.md` runbook that documents how a release is cut, so that a future contributor or LLM agent can ship without paging me.
10. As a user of `@daonhan/ralph`, I want a `CHANGELOG.md` entry per release explaining what changed, so that I can decide whether to upgrade.
11. As a user of `@daonhan/ralph`, I want the changelog grouped by `feat:` / `fix:` / `chore:` headings, so that I can scan for breaking changes quickly.
12. As an operator running the AFK loop in production, I want every published image to have an immutable `sha256:…` digest documented in the GH Release, so that I can pin my deployments reproducibly.
13. As an operator, I want a compatibility matrix in `RELEASING.md`, so that I know which CLI version works with which core version and which image tag.
14. As a security-conscious user, I want each published artifact to have an SBOM attached to the GH Release, so that I can audit my supply chain.
15. As a security-conscious user, I want each published artifact to be sigstore-attested, so that I can verify provenance.
16. As a maintainer who shipped a bad release, I want a rollback procedure documented in `RELEASING.md`, so that I can act fast and not invent a process during an incident.
17. As a maintainer rolling back, I want clear steps for `npm deprecate` per affected version, so that downstream installs see the warning.
18. As a maintainer rolling back, I want clear steps for removing or repointing a bad image tag, so that `:latest` no longer serves the broken build.
19. As a maintainer, I want the release policy to declare that 0.x is treated as a stable contract (breaking change forces a 1.0), so that there is no ambiguity for downstream users on a pre-1.0 codebase.
20. As a maintainer, I want a tag-naming convention (`ralph-core-vX.Y.Z`, `ralph-vX.Y.Z`, `ralph-sandbox-vX.Y.Z`), so that each workflow can match its own component without false fires.
21. As a maintainer, I want the existing `image-v0.1.1` tag and the existing 0.x npm versions preserved, so that already-published artifacts do not disappear or get re-released.
22. As a contributor, I want clear commit-message rules (Conventional Commits) documented in `RELEASING.md`, so that my commits land in the right CHANGELOG section.
23. As a contributor, I want to be able to write a `release-as:` footer on a commit when an exceptional version is needed, so that I can override the auto-computed bump.
24. As a CI operator, I do not want the release-please workflow to race with the existing publish workflows, so that concurrency groups must be set sensibly.
25. As a future maintainer, I want a single-page status view of "what is the current version of everything", so that onboarding is one document not three workflows + three package.json files.

## Implementation Decisions

### Release driver

- Adopt **release-please** (Google) via the official GitHub Action. Chosen over Changesets to avoid imposing a per-PR contributor ritual (`pnpm changeset`) on a small repo, and over hand-rolled scripts to avoid maintenance burden. release-please's monorepo / multi-component manifest mode supports independent versioning natively.
- Configuration lives in `release-please-config.json` and `.release-please-manifest.json` at the repo root. The manifest is the source of truth for "what version was last released" per component.
- Three components are declared: `packages/core` (component `ralph-core`), `apps/cli` (component `ralph`), and a synthetic component `ralph-sandbox` rooted at `packages/core` but path-scoped to `packages/core/Dockerfile` and `packages/core/templates/**`. The synthetic component lets the image bump on Dockerfile/template changes without dragging `ralph-core` along.
- Tag schema: `ralph-core-vX.Y.Z`, `ralph-vX.Y.Z`, `ralph-sandbox-vX.Y.Z`. The existing `image-v0.1.1` tag is left in place; the manifest is seeded so the first `ralph-sandbox` release starts at the next appropriate semver.

### Versioning policy

- Independent versions per component. No lockstep.
- 0.x is treated as a **stable contract**: any breaking change forces a bump to `1.0.0`. This is stricter than the semver spec's "0.x = anything goes" allowance and is stated explicitly in `RELEASING.md`.
- Pre-release tags (`-rc.N`, `-next.N`) are permitted but not enabled by default. release-please's `prerelease-type` is documented in `RELEASING.md` so a maintainer can opt in per release via `release-as:` footer.

### CHANGELOG

- Single root `CHANGELOG.md`. release-please writes per-component sections to it via the manifest config (each component points at the same `changelog-path`). This trades the ability to ship the changelog inside the npm tarball (the per-package option) for one-stop scanning, which the maintainer prioritized.
- Sections are auto-grouped by Conventional Commit type (`feat`, `fix`, `perf`, `deps`, `chore`). Conventional-commit type taxonomy is documented in `RELEASING.md`.

### Workflows

- **`.github/workflows/release-please.yml`** — runs on `push` to `main`. Uses `googleapis/release-please-action@v4`. Outputs the set of `released` flags and per-component tag names for downstream conditional steps. Single concurrency group `release-please-${{ github.ref }}`.
- **`.github/workflows/publish-npm.yml`** — rewritten. Trigger is `push: tags: ['ralph-core-v*', 'ralph-v*']`. A single job inspects `${GITHUB_REF_NAME}` to decide whether to publish `packages/core` or `apps/cli`. Existing path-based push trigger is removed (release-please owns the "when to release" decision). `pnpm install --frozen-lockfile` + `pnpm -r build` + `JS-DevTools/npm-publish` continue to power the actual publish step.
- **`.github/workflows/publish-image.yml`** — rewritten. Trigger is `push: tags: ['ralph-sandbox-v*']` (the existing `image-v*` trigger is retained for one release as a compatibility shim, then removed in a follow-up). `workflow_dispatch` retained for emergency rebuilds. After push, the workflow reads the image digest from the buildx output and calls `gh release edit` to append `Image: docker.io/daonhan/ralph-sandbox@sha256:…` to the release body.
- **`.github/workflows/release-artifacts.yml`** (new, optional consolidation) — triggered after a publish workflow succeeds via `workflow_run`. Runs `pnpm pack`, uploads the `.tgz` to the GH Release, runs `syft` to produce an SBOM, calls `cosign` to attest. May be folded into the publish workflows directly if the `workflow_run` indirection complicates failures; final placement is an implementation-time call.

### Status table

- `RELEASING.md` contains a `<!-- status-table:start -->` / `<!-- status-table:end -->` HTML-comment block.
- A small Node script `scripts/update-status-table.mjs` reads `.release-please-manifest.json`, the latest tag per component (via `git for-each-ref` or the GH API), and the publish timestamps, and rewrites the block.
- The script runs inside the release-please PR (release-please supports an `extra-files` hook), so the maintainer reviews the new table as part of the release PR diff. The script is also runnable locally for manual refresh.

### RELEASING.md sections

1. Status table (auto-updated)
2. How to cut a release (the maintainer flow: review release PR, merge, watch workflows)
3. Conventional Commit guide (which prefix → which bump → which section)
4. Version policy (independent + 0.x-as-stable)
5. Pre-release tags (opt-in via `release-as:` footer)
6. Rollback runbook (npm deprecate, docker tag removal, GH Release re-issue)
7. Compatibility matrix (table: CLI version → required core version → tested image tag)
8. Tag naming and the synthetic `ralph-sandbox` component

### Migration

- Existing artifacts (`@daonhan/ralph-core@0.1.1`, `@daonhan/ralph@0.1.0`, `image-v0.1.1`) are preserved. The manifest is seeded with those versions so release-please's first PR proposes bumps from those baselines.
- `docs/PUBLISHING.md` is superseded by `RELEASING.md`. The old file is replaced with a one-line pointer to the new doc to avoid breaking external links.

## Testing Decisions

A good test for this system exercises external behavior — what artifacts land where, what files end up rewritten, what release notes are produced — not the internals of release-please. The bulk of "is this working" is verified by running the system end-to-end against a throwaway tag once the workflows are wired.

Two pieces are pure enough to deserve unit tests:

- **`scripts/update-status-table.mjs`** — pure function `renderStatusTable(manifest, tagInfo) → markdown`. Tested with a small fixture: a manifest with three components, a tag-info object with mixed release dates, and a snapshot of the expected markdown block. This is a deep module: a stable signature (manifest in, markdown out), no side effects in the rendering core, easy to exercise without touching git or GitHub.
- **`release-please-config.json` validation** — a contract test that runs `release-please --dry-run` (or its programmatic equivalent) against a synthetic commit history fixture and asserts the proposed manifest update matches expectation. This catches config drift (wrong path, wrong component name) at PR time rather than at release time.

There is no existing test suite in the repo, so these two tests establish the prior art. The test runner choice (`node --test` built-in vs `vitest`) is deferred to implementation but `node --test` is preferred to avoid adding a dependency for two tests.

Manual verification covers the rest:

- Cut a no-op release-please PR by pushing a `chore:` commit; verify the PR opens, the proposed CHANGELOG diff is sensible, and the status table updates.
- Merge the PR; verify the per-component tag is created, the corresponding publish workflow fires, the npm package appears under the new version, and the GH Release exists with the `.tgz` attached.
- Make a Dockerfile change; verify only the `ralph-sandbox` component bumps, the image publishes, and the digest is appended to the release notes.

## Out of Scope

- **Signing the npm packages themselves with a maintainer GPG key.** Sigstore/cosign attestation on the GH Release artifact is in scope; OIDC-based npm provenance was previously enabled and was dropped in commit `b23e770` — re-enabling it is a separate decision and not bundled here.
- **Replacing `JS-DevTools/npm-publish` with a different publish action.** Current action works; PRD only changes its trigger.
- **Multi-arch images.** `b23e770` dropped arm64 deliberately. This PRD does not re-enable it.
- **Automatically opening upgrade PRs in downstream consumer repos** when a new ralph version ships. Out of scope.
- **A web-hosted release dashboard.** The `RELEASING.md` status table is the dashboard.
- **Per-package CHANGELOG files inside the npm tarball.** Explicitly chosen against in favor of the root-level CHANGELOG.
- **Migrating to Changesets** or any other release tool.

## Further Notes

- The synthetic `ralph-sandbox` component is the most novel part of the release-please config and the most likely place for misconfiguration. The dry-run contract test exists specifically to catch this.
- `RELEASING.md` is at the repo root, not under `docs/`, on the theory that release-please's `extra-files` resolution and the status-table updater script benefit from a predictable, top-level path, and because users browsing the repo expect a top-level release doc next to `README.md`.
- The "0.x as stable" policy is a maintainer preference, not a semver-spec rule. Documenting it loudly is more important than the policy itself — downstream users only get hurt when the policy is implicit.
- The conventional-commits convention is already in use (`feat:`, `fix:`, `ci:`, `refactor:` all visible in `git log`). Adopting release-please does not require a contributor behavior change; it just starts honoring those commits.
- The image-publish workflow's `workflow_dispatch` input for an arbitrary tag is retained as an escape hatch for emergency rebuilds (e.g., base-image CVE) that do not warrant a semver bump.
