# Local PostgreSQL Sandbox Image Design

**Date:** 2026-08-11
**Status:** Approved for implementation planning

## Goal

Provide a local-only Ralph sandbox image that lets the coding agent run the
database verification path in `D:\Workspaces\nevadventuretours.com` without
installing PostgreSQL during every stage. The required target command is:

```text
npm run db:migrate && npm run test:db
```

Ralph's execution model remains unchanged: the CLI runs on the host and starts
an ephemeral Docker container for every implementer and reviewer stage.

## Current gap

The target repository already supplies the `test:db` npm script and its Node
dependencies through the bind-mounted workspace. `test:db` is not a binary that
belongs in the sandbox image. Recent Ralph logs show that the missing runtime is
PostgreSQL 17: commands such as `initdb`, `postgres`, `pg_ctl`, and `pg_isready`
are absent, so agents repeatedly download and unpack PostgreSQL before the suite
can run.

The published sandbox intentionally remains general-purpose. This design adds
the project-specific runtime only to a derivative image on this machine.

## Chosen design

### Local build context

Create a local build context under `.local/ralph-nev/` in the Ralph checkout and
exclude that directory through `.git/info/exclude`. Its Dockerfile derives from:

```text
docker.io/daonhan/ralph-sandbox:latest
```

The local Dockerfile and entrypoint are not tracked, packaged, published, or
added to `packages/core/templates/Dockerfile`. The resulting image is tagged:

```text
ralph-nev:local
```

The non-floating `:local` tag matters: once the image exists, Ralph's existing
image resolution accepts the local image instead of attempting a registry pull.

### Image additions

The derivative Dockerfile temporarily switches from the inherited `agent` user
to `root`, configures the PostgreSQL apt repository for Debian Bookworm, and
installs PostgreSQL 17 server and client packages. It adds
`/usr/lib/postgresql/17/bin` to `PATH`, installs one startup entrypoint, and then
returns to the inherited `agent` user (UID 1000).

No project `node_modules`, source files, credentials, or database data are copied
into the image. Ralph continues to bind-mount the live target workspace and the
selected provider credentials exactly as it does today.

### Automatic database startup

The local entrypoint runs as `agent` before the provider command supplied by
Ralph. For every stage it:

1. initializes an agent-owned PostgreSQL cluster below `/tmp` with local trust
   authentication;
2. starts PostgreSQL 17 on a Unix-domain socket below `/tmp`, with TCP disabled;
3. creates the `nev_booking` database under the `nev` role;
4. exports `PGHOST`, `PGUSER`, `PGDATABASE`, and
   `DATABASE_URL=postgres://nev@localhost/nev_booking?host=<socket-dir>`; and
5. executes Ralph's original Claude or Codex command without changing its
   arguments or exit status.

The database is deliberately ephemeral. Implementer and reviewer stages each
receive a clean cluster, and Docker removes it with the stage container. The
target's migrations create the schema, while the database tests reset it as
they already do in CI.

Bootstrap failure is fatal: if cluster initialization, server readiness, or
database creation fails, the entrypoint exits non-zero before starting the
coding agent. It does not silently run a database suite that would skip because
`DATABASE_URL` is absent.

## Selection and operation

After building the image locally, the existing Ralph configuration selects it:

```powershell
$env:RALPH_IMAGE = "ralph-nev:local"
$env:RALPH_WORKSPACE = "D:\Workspaces\nevadventuretours.com"
ralph-ghafk --print-config
ralph-ghafk <iterations>
```

No new Ralph flag or environment variable is introduced. Unsetting
`RALPH_IMAGE` restores the published default image. Rebuilding the local image
is the explicit update mechanism when the base sandbox or PostgreSQL layer must
change.

## Security and lifecycle

- PostgreSQL accepts connections only through its container-local Unix socket;
  it exposes no host port.
- Trust authentication is acceptable only because the cluster is private to a
  disposable sandbox and contains synthetic test data.
- The database directory is not mounted and cannot persist across stages.
- Provider credential mounts, Docker-socket behavior, permission bypasses, and
  workspace write access remain Ralph's existing behavior.
- The image stays local and is never pushed to a registry.

## Alternatives considered

### Install PostgreSQL without automatic startup

This changes fewer container behaviors, but every agent must rediscover the
cluster initialization, role, database, socket, and environment setup. It keeps
the repeated work that prompted this customization and makes verification depend
on agent judgment, so it was rejected.

### Install Docker CLI and use the target's Compose service

This reuses `docker-compose.yml`, but a sandbox-created sibling container adds
Docker-socket permissions, host-versus-container address translation, and
published-port networking. A private PostgreSQL process inside the existing
sandbox is smaller and matches the test suite's needs, so Compose was rejected.

### Modify the published Ralph sandbox

Adding PostgreSQL 17 to `packages/core/templates/Dockerfile` would increase the
image for every Ralph user and turn a project-specific runtime into a published
contract. The request is local-only, so the published image remains untouched.

## Verification

Implementation is complete when all of the following pass:

1. Build `ralph-nev:local` from the local build context.
2. Run a disposable container and verify PostgreSQL reports ready on the Unix
   socket before the supplied command executes.
3. Bind-mount `D:\Workspaces\nevadventuretours.com` at
   `/home/agent/workspace` and run `npm run db:migrate && npm run test:db` with
   no manual PostgreSQL installation or environment export.
4. Run `ralph-ghafk --print-config` with `RALPH_IMAGE=ralph-nev:local` and verify
   that Ralph resolves the local tag and the intended target workspace.
5. Confirm `git status --short` in both repositories has no changes caused by
   the local image assets or verification run, apart from the target repository's
   pre-existing work in progress.

## Non-goals

- Changing Ralph's host-CLI and per-stage-container architecture.
- Publishing or supporting the derivative image for other users.
- Baking target npm dependencies or source code into the image.
- Persisting the test database between stages.
- Adding Docker Compose, a database volume, or host port forwarding.
- Adding unrelated runtimes such as Playwright system dependencies before a
  verified target command requires them.
