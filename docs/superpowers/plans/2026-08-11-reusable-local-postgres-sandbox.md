# Reusable Local PostgreSQL Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt the target repository's existing NEV-specific local Ralph image into a reusable `ralph-postgres17:local` sandbox that starts a pristine PostgreSQL 17 database automatically for every Ralph stage.

**Architecture:** An ignored build profile at `D:\Workspaces\nevadventuretours.com\.local\ralph-postgres17` derives from Ralph's published sandbox, installs PostgreSQL 17, and bakes an empty `ralph`/`ralph_test` cluster into the image. A stderr-only fail-fast entrypoint starts that cluster before executing Ralph's unchanged provider command; two ignored target-local wrappers select the non-floating image tag.

**Tech Stack:** Docker BuildKit, Debian Bookworm/PGDG, PostgreSQL 17, Bash, PowerShell, Ralph CLI, npm/node:test.

## Global Constraints

- Work on target branch `codex/reusable-ralph-postgres17`; do not switch, stash, stage, or modify the dirty `feature/slice-26-confirmation-delivery` checkout.
- Preserve the user-owned contents of `ralph.Dockerfile`, `docs/ralph-sandbox.md`, `scripts/afk-local.ps1`, and `scripts/afk-local.sh` as migration inputs.
- Keep Ralph's host-CLI and per-stage-container architecture unchanged.
- Do not modify or publish `packages/core/templates/Dockerfile`.
- The image tag is exactly `ralph-postgres17:local`; never use a floating `:latest` tag.
- The image exports `PGDATA=/home/agent/pgdata`, `PGHOST=127.0.0.1`, `PGUSER=ralph`, `PGDATABASE=ralph_test`, and `DATABASE_URL=postgres://ralph@127.0.0.1:5432/ralph_test`.
- PostgreSQL listens only on container-local loopback and publishes no port.
- Entrypoint diagnostics go only to stderr; provider stdout remains NDJSON-only.
- PostgreSQL startup failure exits non-zero before Claude or Codex starts.
- The local profile and wrappers remain untracked via the target repository's `.git/info/exclude`.
- Do not alter the target repository's application code, current tracked work, npm dependencies, or project database configuration.

---

## File Structure

- Create: `.local/ralph-postgres17/Dockerfile` — reusable derivative image, PostgreSQL installation, build-time cluster, and inline runtime entrypoint.
- Create: `.local/ralph-postgres17/README.md` — canonical build, selection, reuse, troubleshooting, and removal commands.
- Modify: `scripts/afk-local.ps1` — select/validate the reusable tag and print the canonical absolute PowerShell build command.
- Modify: `scripts/afk-local.sh` — select/validate the reusable tag and print a repository-relative portable build command.
- Modify locally: `.git/info/exclude` — hide the profile and wrappers without changing tracked `.gitignore`.
- Remove after migration: `ralph.Dockerfile` and `docs/ralph-sandbox.md` — obsolete untracked NEV-specific locations.
- Reference only: `D:\Workspaces\ralph\docs\superpowers\specs\2026-08-11-local-postgres-sandbox-image-design.md` — approved design authority.

### Task 1: Create the isolated branch and migrate the local profile

**Files:**

- Create: `.local/ralph-postgres17/Dockerfile`
- Create: `.local/ralph-postgres17/README.md`
- Modify: `scripts/afk-local.ps1`
- Modify: `scripts/afk-local.sh`
- Modify locally: `.git/info/exclude`
- Remove: `ralph.Dockerfile`
- Remove: `docs/ralph-sandbox.md`

**Interfaces:**

- Consumes: the four existing untracked local-image files and the approved design spec.
- Produces: a Docker build context at `.local/ralph-postgres17`, image contract `ralph-postgres17:local`, and wrappers that delegate their arguments unchanged to `ralph-afk`.

Author Steps 4–6 in the isolated worktree first. Step 7 copies the reviewed local assets into the canonical original checkout, where the user's reusable build command expects them. Because these files are ignored, the branch is an isolation and verification boundary rather than a publication mechanism.

- [ ] **Step 1: Create an isolated target worktree and branch**

Use the `superpowers:using-git-worktrees` skill. Create branch `codex/reusable-ralph-postgres17` from the current target `HEAD` without switching or mutating the dirty checkout. The worktree must be outside the target checkout so its untracked local assets do not collide with worktree metadata.

Run in the original target checkout:

```powershell
git branch codex/reusable-ralph-postgres17 HEAD
git worktree add "D:\Workspaces\nevadventuretours.com-ralph-postgres17" codex/reusable-ralph-postgres17
```

Expected: the new worktree is clean on `codex/reusable-ralph-postgres17`; the original checkout remains on `feature/slice-26-confirmation-delivery` with byte-identical status.

- [ ] **Step 2: Preserve the existing local assets as migration input**

Record SHA-256 hashes before editing:

```powershell
Get-FileHash ralph.Dockerfile, docs/ralph-sandbox.md, scripts/afk-local.ps1, scripts/afk-local.sh -Algorithm SHA256
```

Expected: four hashes. Copy the four files into a uniquely named temporary directory created with `New-Item -ItemType Directory` under the system temporary path; never move or overwrite them in the dirty checkout before adapted replacements exist.

```powershell
$backupRoot = Join-Path ([IO.Path]::GetTempPath()) "ralph-postgres17-migration-$PID"
New-Item -ItemType Directory -Path (Join-Path $backupRoot 'docs'), (Join-Path $backupRoot 'scripts') -Force | Out-Null
Copy-Item -LiteralPath ralph.Dockerfile -Destination (Join-Path $backupRoot 'ralph.Dockerfile')
Copy-Item -LiteralPath docs/ralph-sandbox.md -Destination (Join-Path $backupRoot 'docs/ralph-sandbox.md')
Copy-Item -LiteralPath scripts/afk-local.ps1 -Destination (Join-Path $backupRoot 'scripts/afk-local.ps1')
Copy-Item -LiteralPath scripts/afk-local.sh -Destination (Join-Path $backupRoot 'scripts/afk-local.sh')
```

- [ ] **Step 3: Add local exclude rules**

Append these exact entries once to the target repository's common `.git/info/exclude`:

```gitignore
.local/ralph-postgres17/
scripts/afk-local.ps1
scripts/afk-local.sh
```

Verify:

```powershell
git check-ignore -v .local/ralph-postgres17/Dockerfile scripts/afk-local.ps1 scripts/afk-local.sh
```

Expected: each path resolves to `.git/info/exclude`. Do not add `ralph.Dockerfile` or `docs/ralph-sandbox.md`; those obsolete files will be removed after migration.

- [ ] **Step 4: Create the reusable Dockerfile**

Create `.local/ralph-postgres17/Dockerfile` with this implementation:

```dockerfile
# syntax=docker/dockerfile:1
FROM docker.io/daonhan/ralph-sandbox:latest

USER root

RUN curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/keyrings/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/keyrings/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-common \
  && sed -ri 's/#?(create_main_cluster)\s*=.*/\1 = false/' /etc/postgresql-common/createcluster.conf \
  && apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/lib/postgresql/17/bin:${PATH}"

COPY --chmod=755 <<"EOF" /usr/local/bin/with-db
#!/bin/bash
set -euo pipefail

if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  if ! pg_ctl -D "$PGDATA" -w -t 30 -l /tmp/postgres.log start >/dev/null 2>&1; then
    echo "with-db: PostgreSQL 17 failed to start; /tmp/postgres.log follows" >&2
    if [[ -f /tmp/postgres.log ]]; then
      tail -n 50 /tmp/postgres.log >&2
    fi
    exit 1
  fi
fi

if ! pg_isready -q -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"; then
  echo "with-db: PostgreSQL 17 did not become ready" >&2
  exit 1
fi

echo "with-db: PostgreSQL 17 ready on ${PGHOST}:5432 (${PGDATABASE})" >&2
exec "$@"
EOF

USER agent

ENV PGDATA=/home/agent/pgdata \
    PGHOST=127.0.0.1 \
    PGUSER=ralph \
    PGDATABASE=ralph_test \
    DATABASE_URL=postgres://ralph@127.0.0.1:5432/ralph_test

RUN initdb -D "$PGDATA" -U "$PGUSER" --auth=trust --encoding=UTF8 --locale=C.UTF-8 \
  && { \
       echo "listen_addresses = '127.0.0.1'"; \
       echo "unix_socket_directories = '/tmp'"; \
     } >> "$PGDATA/postgresql.conf" \
  && pg_ctl -D "$PGDATA" -w -l /tmp/initdb.log start \
  && createdb "$PGDATABASE" \
  && pg_ctl -D "$PGDATA" -w -m fast stop \
  && rm -f /tmp/initdb.log

WORKDIR /home/agent/workspace
ENTRYPOINT ["/usr/local/bin/with-db"]
CMD ["claude"]
```

- [ ] **Step 5: Create the local README**

Create `.local/ralph-postgres17/README.md` with:

````markdown
# Reusable local Ralph sandbox: PostgreSQL 17

Build or rebuild from any PowerShell directory:

```powershell
docker build --pull --tag ralph-postgres17:local "D:\Workspaces\nevadventuretours.com\.local\ralph-postgres17"
```

Select it for any compatible project:

```powershell
$env:RALPH_IMAGE = "ralph-postgres17:local"
$env:RALPH_WORKSPACE = "D:\Workspaces\your-project"
ralph-ghafk --print-config
```

The image supplies a fresh PostgreSQL 17 database per Ralph stage at
`postgres://ralph@127.0.0.1:5432/ralph_test`. A project is compatible when it
reads `DATABASE_URL`, accepts PostgreSQL 17 and an empty database, and requires
no state persistence between stages.

Remove the cached image with `docker image rm ralph-postgres17:local`. Nothing
is pushed to a registry.
````

- [ ] **Step 6: Adapt both wrappers**

Replace `scripts/afk-local.ps1` with:

```powershell
$repoRoot = Split-Path -Parent $PSScriptRoot
$buildContext = Join-Path $repoRoot '.local\ralph-postgres17'

if (-not $env:RALPH_IMAGE) { $env:RALPH_IMAGE = 'ralph-postgres17:local' }

docker image inspect $env:RALPH_IMAGE *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "afk-local: image $($env:RALPH_IMAGE) not found - build it first:"
    Write-Host ('  docker build --pull --tag {0} "{1}"' -f $env:RALPH_IMAGE, $buildContext)
    exit 1
}

Push-Location -LiteralPath $repoRoot
try {
    if (Get-Command ralph-afk -ErrorAction SilentlyContinue) {
        & ralph-afk @args
    } else {
        & npx -y "@daonhan/ralph" ralph-afk @args
    }
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $exitCode
```

Replace `scripts/afk-local.sh` with:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BUILD_CONTEXT="$REPO_ROOT/.local/ralph-postgres17"
export RALPH_IMAGE="${RALPH_IMAGE:-ralph-postgres17:local}"

if ! docker image inspect "$RALPH_IMAGE" >/dev/null 2>&1; then
  echo "afk-local: image $RALPH_IMAGE not found — build it first:" >&2
  echo "  docker build --pull --tag $RALPH_IMAGE \"$BUILD_CONTEXT\"" >&2
  exit 1
fi

cd "$REPO_ROOT"
if command -v ralph-afk >/dev/null 2>&1; then
  exec ralph-afk "$@"
fi
if [[ -x "./node_modules/.bin/ralph-afk" ]]; then
  exec ./node_modules/.bin/ralph-afk "$@"
fi
exec npx -y @daonhan/ralph ralph-afk "$@"
```

Both wrappers keep the existing image-existence guard and Ralph fallback behavior, and change to the target repository root before invoking Ralph so `RALPH_WORKSPACE` defaults to the intended project.

- [ ] **Step 7: Remove the obsolete untracked sources after comparison**

Compare the adapted Dockerfile, README, and wrappers against the saved originals to confirm all useful behavior survived: PGDG PostgreSQL 17, build-time cluster, stderr-only entrypoint, non-floating tag, image-existence guard, and Ralph fallback.

Resolve and print these exact absolute roots before copying:

```powershell
$sourceRoot = (Resolve-Path "D:\Workspaces\nevadventuretours.com-ralph-postgres17").Path
$targetRoot = (Resolve-Path "D:\Workspaces\nevadventuretours.com").Path
$sourceRoot
$targetRoot
```

Expected: two distinct directories below `D:\Workspaces`; neither is a filesystem root. Mechanically copy the reviewed `.local/ralph-postgres17` directory and both wrappers from `$sourceRoot` into the matching paths below `$targetRoot`. Compare each source/destination file hash after the copy.

```powershell
$sourceProfile = Join-Path $sourceRoot '.local\ralph-postgres17'
$targetProfile = Join-Path $targetRoot '.local\ralph-postgres17'
if (Test-Path -LiteralPath $targetProfile) {
    throw "Refusing to overwrite existing target profile: $targetProfile"
}
New-Item -ItemType Directory -Path $targetProfile -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceProfile 'Dockerfile') -Destination (Join-Path $targetProfile 'Dockerfile')
Copy-Item -LiteralPath (Join-Path $sourceProfile 'README.md') -Destination (Join-Path $targetProfile 'README.md')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts\afk-local.ps1') -Destination (Join-Path $targetRoot 'scripts\afk-local.ps1') -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts\afk-local.sh') -Destination (Join-Path $targetRoot 'scripts\afk-local.sh') -Force

$pairs = @(
    @((Join-Path $sourceProfile 'Dockerfile'), (Join-Path $targetProfile 'Dockerfile')),
    @((Join-Path $sourceProfile 'README.md'), (Join-Path $targetProfile 'README.md')),
    @((Join-Path $sourceRoot 'scripts\afk-local.ps1'), (Join-Path $targetRoot 'scripts\afk-local.ps1')),
    @((Join-Path $sourceRoot 'scripts\afk-local.sh'), (Join-Path $targetRoot 'scripts\afk-local.sh'))
)
foreach ($pair in $pairs) {
    $sourceHash = (Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) { throw "Copy verification failed: $($pair[1])" }
}
```

Only after those hashes match, remove these exact obsolete paths from the original target checkout:

```text
D:\Workspaces\nevadventuretours.com\ralph.Dockerfile
D:\Workspaces\nevadventuretours.com\docs\ralph-sandbox.md
```

Do not remove either wrapper. The adapted `.local` profile and wrapper hashes must already match the isolated worktree before deleting the two sources. Keep the temporary migration backup until final verification succeeds.

```powershell
Remove-Item -LiteralPath (Join-Path $targetRoot 'ralph.Dockerfile')
Remove-Item -LiteralPath (Join-Path $targetRoot 'docs\ralph-sandbox.md')
```

- [ ] **Step 8: Static verification**

Run:

```powershell
rg -n "ralph-sandbox-nev|ralph-nev|nev_booking|postgres://nev" .local/ralph-postgres17 scripts/afk-local.ps1 scripts/afk-local.sh
git status --short
```

Expected: the first command has no matches. `git status --short` shows none of the local profile/wrapper paths and preserves every unrelated tracked modification byte-for-byte.

No commit is created for Task 1 because every implementation artifact is intentionally local and ignored. The branch/worktree is an isolation boundary, not a publication mechanism.

### Task 2: Build and smoke-test the reusable image

**Files:**

- Read: `.local/ralph-postgres17/Dockerfile`
- Read: `.local/ralph-postgres17/README.md`

**Interfaces:**

- Consumes: the Task 1 build context.
- Produces: local Docker image `ralph-postgres17:local` with a ready database before any supplied command runs.

- [ ] **Step 1: Verify the old tag does not mask the result**

Run:

```powershell
docker image inspect ralph-postgres17:local
```

Record whether an older image exists. Do not delete it; the subsequent tagged build replaces the tag recoverably while old layers remain in Docker's cache.

- [ ] **Step 2: Build the image**

Run the canonical command:

```powershell
docker build --pull --tag ralph-postgres17:local "D:\Workspaces\nevadventuretours.com\.local\ralph-postgres17"
```

Expected: exit 0; PostgreSQL 17 packages install; `initdb`, `createdb`, and clean `pg_ctl stop` complete during the build.

- [ ] **Step 3: Verify image metadata**

Run:

```powershell
docker image inspect ralph-postgres17:local --format '{{json .Config.Env}}'
docker image inspect ralph-postgres17:local --format '{{json .Config.Entrypoint}}'
```

Expected: environment contains all five exact database values from Global Constraints; entrypoint is `["/usr/local/bin/with-db"]`.

- [ ] **Step 4: Smoke-test startup and generic identity**

Run:

```powershell
docker run --rm ralph-postgres17:local bash -lc 'pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" && psql -Atqc "select current_user, current_database(), current_setting(''server_version_num'')::int / 10000"'
```

Expected: stderr contains one `with-db: PostgreSQL 17 ready` line; stdout reports acceptance and `ralph|ralph_test|17`. Exit 0.

- [ ] **Step 5: Prove startup failure is fatal**

Run with an invalid data directory:

```powershell
docker run --rm -e PGDATA=/missing/pgdata ralph-postgres17:local true
```

Expected: non-zero exit and a stderr failure message; `true` never runs successfully through the entrypoint.

### Task 3: Verify the target database workflow

**Files:**

- Read: `package.json`
- Read: `tests/db/helpers.mjs`
- Read: `migrations/**`

**Interfaces:**

- Consumes: `ralph-postgres17:local` and the live mounted target workspace.
- Produces: evidence that the unchanged target migration and `test:db` commands run against the image-provided PostgreSQL 17 database.

- [ ] **Step 1: Snapshot target status**

Run in the original target checkout:

```powershell
git status --short
```

Save the exact output for the final comparison.

- [ ] **Step 2: Run migrations and database tests in the image**

Run:

```powershell
docker run --rm --mount "type=bind,source=D:\Workspaces\nevadventuretours.com,target=/home/agent/workspace" ralph-postgres17:local bash -lc 'npm run db:migrate && npm run test:db'
```

Expected: migration exit 0; every database suite passes with zero skips and zero failures; no PostgreSQL download/bootstrap occurs inside the running container.

- [ ] **Step 3: Confirm target files are unchanged**

Run `git status --short` again in the original checkout and compare it byte-for-byte with Step 1. Expected: identical output after accounting for the intentionally migrated/ignored local files.

### Task 4: Verify Ralph selection and both wrappers

**Files:**

- Read: `scripts/afk-local.ps1`
- Read: `scripts/afk-local.sh`

**Interfaces:**

- Consumes: built image and adapted wrappers.
- Produces: evidence that both host shells select the reusable image without launching an agent stage.

- [ ] **Step 1: Verify PowerShell wrapper configuration**

Run from outside the target repository:

```powershell
& "D:\Workspaces\nevadventuretours.com\scripts\afk-local.ps1" --print-config
```

Expected: resolved workspace is `D:\Workspaces\nevadventuretours.com`; image is `ralph-postgres17:local`; no Docker stage launches.

- [ ] **Step 2: Verify Bash wrapper configuration**

Run:

```powershell
bash "D:\Workspaces\nevadventuretours.com\scripts\afk-local.sh" --print-config
```

Expected: same workspace and image. If the installed Bash requires `/d/Workspaces/...` syntax, use that equivalent path and record it in the README only if users need it.

- [ ] **Step 3: Verify the GitHub-issue entrypoint directly**

Run:

```powershell
$env:RALPH_IMAGE = "ralph-postgres17:local"
$env:RALPH_WORKSPACE = "D:\Workspaces\nevadventuretours.com"
ralph-ghafk --print-config
```

Expected: same workspace and image; image status is present locally.

- [ ] **Step 4: Verify the missing-image guard message without deleting the image**

Temporarily set `RALPH_IMAGE=ralph-postgres17-does-not-exist:local` and run each wrapper with `--print-config`. Expected: each exits non-zero and prints the reusable build command. Restore/unset `RALPH_IMAGE` immediately afterward.

### Task 5: Final verification and handoff

**Files:**

- Read: all Task 1 local assets
- Read: both repository status outputs

**Interfaces:**

- Consumes: all prior task evidence.
- Produces: a reproducible local image, clean isolation report, and canonical rebuild command for the user.

- [ ] **Step 1: Invoke verification-before-completion**

Use `superpowers:verification-before-completion`. Re-run the canonical build only if the Dockerfile changed after Task 2; always re-run the image smoke, target database workflow, wrapper `--print-config`, and status comparisons.

- [ ] **Step 2: Confirm the branch and worktree state**

Run:

```powershell
git branch --show-current
git status --short
git -C "D:\Workspaces\nevadventuretours.com" branch --show-current
git -C "D:\Workspaces\nevadventuretours.com" status --short
```

Expected: isolated worktree branch is `codex/reusable-ralph-postgres17`; original checkout is still `feature/slice-26-confirmation-delivery`; unrelated original status is preserved. There may be no branch commit because all implementation artifacts are deliberately ignored.

- [ ] **Step 3: Report the reusable command**

End with this exact command:

```powershell
docker build --pull --tag ralph-postgres17:local "D:\Workspaces\nevadventuretours.com\.local\ralph-postgres17"
```

Also report the image ID, PostgreSQL version, `test:db` pass/fail counts, wrapper/config results, local asset paths, original dirty-checkout preservation, and whether any commit was created.
