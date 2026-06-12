# Plan: Public launch readiness

> Source PRD: [docs/prd/public-launch-readiness.md](../prd/public-launch-readiness.md)

## Architectural decisions

Durable decisions that apply across all phases:

- **Reconciliation strategy**: roll the half-completed 0.6.3 release **forward** (publish the lagging registries to match git/GitHub), never roll back. GitHub already holds the 0.6.3/0.2.3 tags and Releases.
- **Tag schema** (unchanged, source of truth for what to publish): `ralph-core-vX.Y.Z` → `@daonhan/ralph-core`, `ralph-vX.Y.Z` → `@daonhan/ralph`, `ralph-sandbox-vX.Y.Z` → the sandbox image (`tag=vX.Y.Z`).
- **Publish mechanism**: use the **existing `workflow_dispatch` escape hatches** on `publish-npm.yml` (`tag` input) and `publish-image.yml` (`tag` / `also_latest` / `release_tag` inputs). No workflow logic is rewritten in this plan; only action `uses:` versions change, and only in Phase 4.
- **release-please ownership**: `.release-please-manifest.json` and the per-package `version` fields are owned by release-please and are **never hand-edited**. (The phantom-version churn traces to a manual bump.)
- **Ownership split**: two actions require the maintainer and cannot be done by the agent — creating the `RELEASE_PLEASE_TOKEN` PAT (Phase 1) and flipping repository visibility (Phase 6). All other phases are agent-executable with a go-ahead.
- **Sequencing**: Phases 1–5 can overlap; only Phase 6 strictly depends on the others. Phase 3 is the sole non-launch-blocker (future-proofing).
- **Already-satisfied stories** (no phase): security warning prominence (US 18), unpinned install commands (US 19), keeping `docs/plans` + `docs/prd` public (US 20), and capturing the episode as a PRD (US 22).

---

## Phase 1: Root-cause fix — add `RELEASE_PLEASE_TOKEN`

**User stories**: 6, 7, 8

### What to build

Eliminate the defect that makes every release half-complete. Create a repo-scoped Personal Access Token and store it as the `RELEASE_PLEASE_TOKEN` repository secret so release-please-created tags raise `push: tags` events and trigger the publish workflows. Maintainer action — the agent prepares exact steps and verifies the secret is present, but cannot mint the token. Pair it with the standing rule that release-please owns the manifest and version fields.

### Acceptance criteria

- [ ] A PAT exists with `repo` scope (classic) or contents + actions + pull-requests write (fine-grained).
- [ ] `gh secret list` shows `RELEASE_PLEASE_TOKEN` alongside the existing `NPM_TOKEN` / `DOCKERHUB_*`.
- [ ] The "never hand-edit `.release-please-manifest.json` / `package.json` versions" rule is recorded where future contributors will see it (RELEASING.md / memory).
- [ ] No change is made to manifest or version fields as part of this phase.

---

## Phase 2: Roll forward the 0.6.3 release

**User stories**: 3, 4, 5, 9, 21

### What to build

Make the registries match what git/GitHub already assert. Dispatch the existing publish workflows against the already-created tags so npm reaches 0.6.3 and the sandbox image reaches 0.2.3, enriching the existing GitHub Releases with their `.tgz` / SBOM / cosign artifacts. Runs on the current (v4) actions — does not wait on Phase 4. Outward-facing publish; requires explicit maintainer go before dispatch.

### Acceptance criteria

- [ ] `publish-npm.yml` dispatched for `ralph-core-v0.6.3` and for `ralph-v0.6.3`; both runs succeed.
- [ ] `publish-image.yml` dispatched with `tag=v0.2.3`, `also_latest=true`, `release_tag=ralph-sandbox-v0.2.3`; run succeeds.
- [ ] `npm view @daonhan/ralph version` and `npm view @daonhan/ralph-core version` both return `0.6.3`.
- [ ] `docker.io/daonhan/ralph-sandbox:0.2.3` exists and `:latest` resolves to it.
- [ ] The 0.6.3 / 0.2.3 GitHub Releases carry their `.tgz`, SBOM, and cosign attestation.

---

## Phase 3: "Registries not behind git" guard test

**User stories**: 7 (regression guard)

### What to build

The one automatable invariant from the PRD: a check that the latest component tag is not ahead of the published artifact. A pure function takes tags + registry versions and returns the list of lagging components; live lookups (`git`, `npm view`, image registry) are injected at the edge so the core is testable without network. Lands as a `node --test` script in the existing `scripts/*.test.mjs` family. Not a launch blocker — it future-proofs against the next half-completed release.

### Acceptance criteria

- [ ] A pure comparison function exists: (per-component latest tag, per-component published version) → list of lagging components.
- [ ] A `node --test` spec covers: all-in-sync → empty; npm behind tag → flagged; image behind tag → flagged; registry ahead → not flagged.
- [ ] The test is wired into the root `pnpm test` script alongside the existing `scripts/*.test.mjs`.
- [ ] The comparison core runs with no network access (live lookups injected).

---

## Phase 4: CI action modernization

**User stories**: 10, 11, 12

### What to build

Beat the June 16 Node-24 forced cutover. Bump the Node-20 actions to current majors across all four workflow files, as its own PR so a breaking action major cannot affect the Phase 2 publish. Kept separate and proven green in CI before merge.

Bumps: `actions/checkout` v4→v5, `actions/setup-node` v4→v6, `pnpm/action-setup` v4→v6, `docker/login-action` v3→v4, `JS-DevTools/npm-publish` v3→v4. Already-current actions are left untouched.

### Acceptance criteria

- [x] The five actions are bumped across `ci.yml`, `publish-npm.yml`, `publish-image.yml`, `release-please.yml` (only where each appears). (checkout v4→v5, setup-node v4→v6, pnpm/action-setup v4→v6, login-action v3→v4, npm-publish v3→v4 — 11 `uses:` lines)
- [ ] The change is a standalone PR, not bundled with the roll-forward. (Landed as an isolated commit touching only the 4 workflow files; PR still to be opened by the maintainer.)
- [ ] CI on the PR is green before merge. (Local feedback loops green: `pnpm -r typecheck`, 59 core + 25 root tests; GitHub Actions CI verification pending the PR.)
- [x] No remaining `uses:` pins on the deprecated Node-20 action majors.

---

## Phase 5: Repo hygiene

**User stories**: 13, 14, 15, 16, 17

### What to build

Tidy the surface that goes public. Delete merged and stale branches and close the red dependabot PR so a visitor sees only live work. No code change to `main`.

### Acceptance criteria

- [ ] Merged branches deleted: `feat/global-cli-install`, `fix/ghafk-silent-issue-fetch-failure`, `fix/release-please-manifest-anchor`, `fix/result-grace-timer`, `release/release-v0.6.2`.
- [ ] Stale `feature/release` branch deleted.
- [ ] Stale closed-PR dependabot branches deleted; the branch for any still-open PR is left intact.
- [ ] PR #66 closed.
- [ ] Remote branch list shows only `main` plus any genuinely live branch.

---

## Phase 6: Flip repository public

**User stories**: 1, 2

### What to build

The final, gating step. Confirm the pre-flip safety gate (clean secret-scan of full history) still holds, then change repository visibility to public. Maintainer action — the agent confirms readiness but does not toggle visibility.

### Acceptance criteria

- [ ] Full-history secret scan re-confirmed clean immediately before flipping.
- [ ] Phases 1–5 complete (PAT set, registries at 0.6.3/0.2.3, actions bumped, branches/PR cleaned).
- [ ] Repository visibility is `public`.
- [ ] Post-flip spot check: README badges, install commands, and the security warning render correctly on the public page.
