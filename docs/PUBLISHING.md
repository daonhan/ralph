# Publishing `@daonhan/ralph-core` to npm

Guide for packing, publishing, and automating npm releases via GitHub Actions.

## Prerequisites

- npm account with publish rights to the `@daonhan` scope
- Node 20+, pnpm 9+
- Repo admin access (to add GitHub secrets)

## 1. First-time manual publish

Verify the package builds and publishes cleanly before wiring CI.

```powershell
# Login (one-time per machine)
npm login

# From repo root: install + build
pnpm install
pnpm -r run build

# Inspect tarball contents before publishing
cd packages/core
npm pack --dry-run

# Real publish (scoped package requires --access public)
pnpm publish --access public --no-git-checks
```

Verify on `https://www.npmjs.com/package/@daonhan/ralph-core`.

## 2. Create npm automation token

Used by GitHub Actions. Bypasses 2FA.

1. npmjs.com → Avatar → **Access Tokens** → **Generate New Token**
2. Choose **Granular Access Token** (preferred) or **Classic → Automation**
3. Granular settings:
   - Expiration: 1 year (calendar reminder for rotation)
   - Packages: `@daonhan/ralph-core` → **Read and write**
4. Copy token immediately — shown only once

## 3. Add GitHub secret

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

- Name: `NPM_TOKEN`
- Value: paste token from step 2

## 4. CI workflow

File: `.github/workflows/publish-npm.yml` (already created).

Trigger: push to `main` touching `packages/core/**`, or manual `workflow_dispatch`.

Behavior:
- Installs deps, builds.
- `JS-DevTools/npm-publish` diffs `package.json` version vs npm registry.
- Same version → skip (no-op, no error).
- New version → publish with provenance attestation.

## 5. Release cycle

```powershell
# Bump version (patch | minor | major)
cd packages/core
npm version patch

# Commit + push
cd ../..
git add packages/core/package.json
git commit -m "release: ralph-core v0.1.1"
git push origin main
```

GitHub Actions fires → publishes if version differs from registry.

## Version bump rules (SemVer)

| Change                            | Bump  |
| --------------------------------- | ----- |
| Bug fix, no API change            | patch |
| New feature, backward compatible  | minor |
| Breaking change, removed API      | major |

Pre-1.0: minor bump may include breaking changes — call out in commit message.

## Provenance

Workflow includes `id-token: write` + `provenance: true` → green "Built and signed on GitHub Actions" badge on npm page.

Requirements:
- Public repo, OR
- GitHub paid plan (Team/Enterprise)

If private repo on free plan: remove both lines from workflow.

## Troubleshooting

| Symptom                                          | Cause / Fix                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `403 Forbidden` on publish                       | Token lacks write scope, or `--access public` missing on scoped package    |
| `EPUBLISHCONFLICT` / `cannot publish over...`    | Version already published. Bump version.                                   |
| `pnpm install --frozen-lockfile` fails in CI     | Run `pnpm install` locally, commit `pnpm-lock.yaml`                        |
| Workflow runs but skips publish                  | Version unchanged. Expected behavior.                                      |
| Provenance step fails on private repo            | Remove `id-token: write` + `provenance: true` from workflow                |
| `prepublishOnly` runs build twice                | Harmless. Remove from `package.json` if want single build.                 |

## Files involved

- `packages/core/package.json` — version, `files`, `exports`, `publishConfig.access`
- `packages/core/tsconfig.json` — emits `dist/`
- `.github/workflows/publish-npm.yml` — CI publish
- `pnpm-lock.yaml` — required for `--frozen-lockfile`

## Manual emergency publish

If CI broken and need urgent release:

```powershell
cd packages/core
npm version patch
pnpm publish --access public --no-git-checks
git push origin main --follow-tags
```

## Future: Changesets

When monorepo grows to multiple packages, migrate to `@changesets/cli`:
- PR-based version bumps via changeset markdown files
- Auto-generated CHANGELOG
- Coordinated releases across packages

Skip until needed.
