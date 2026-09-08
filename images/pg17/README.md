# ralph-sandbox:pg17 — sandbox + PostgreSQL 17 (+ PostGIS), project-neutral

One image for every repo that wants a throwaway Postgres inside the Ralph sandbox.
Per-project differences live in the **workspace**, not in the image.

## Build

```powershell
docker build --pull --tag ralph-sandbox:pg17 "D:\Workspaces\ralph\images\pg17"
```

Or let Ralph build it on first use — set both and run any `ralph-*` command:

```powershell
$env:RALPH_IMAGE = 'ralph-sandbox:pg17'
$env:RALPH_DOCKER_CONTEXT = 'D:\Workspaces\ralph\images\pg17'   # docker build fallback when the tag is missing
```

A repo that always wants this image (its tests need a database) pins the same two
lines in a versioned `<repo>/.ralph/host.env`; the slice-cycle skill's handoff block
loads that file, and repos without it run on ralph's default image.

## Isolation model

Each Ralph stage is `docker run --rm` → its own copy of `PGDATA` → an empty
server per stage. Two workspaces running Ralph at the same time each talk to
their own `127.0.0.1:5432` (separate container network namespaces). Nothing is
shared across stages, workspaces, or projects; nothing persists.

## Defaults (no config needed)

| Variable       | Value                                        |
| -------------- | -------------------------------------------- |
| `PGHOST`       | `127.0.0.1` (trust auth, loopback only)      |
| `PGUSER`       | `ralph`                                      |
| `PGDATABASE`   | `ralph_test`                                 |
| `DATABASE_URL` | `postgres://ralph@127.0.0.1:5432/ralph_test` |

## Per-project overrides — `<workspace>/.ralph/db.env`

Plain `KEY=VALUE` lines (parsed, never sourced). Read by the entrypoint at
container start; the file lives in the repo, so the choice is versioned with the
project.

| Key           | Meaning                                                   | Default        |
| ------------- | --------------------------------------------------------- | -------------- |
| `PGDATABASE`  | database created for the run                              | `ralph_test`   |
| `DB_URL_VARS` | space-separated env names that receive the connection URL | `DATABASE_URL` |
| `DB_INIT_SQL` | one SQL statement run once on that database               | _(none)_       |

Examples:

```dotenv
# Payload CMS project reading DATABASE_URI, needing PostGIS
PGDATABASE=gioqua
DB_URL_VARS=DATABASE_URI
DB_INIT_SQL=CREATE EXTENSION IF NOT EXISTS postgis
```

```dotenv
# Plain DATABASE_URL project that wants its usual database name
PGDATABASE=nev_booking
```

A project that does not want Postgres in the sandbox (SQLite dev default, for
example) simply has no `.ralph/db.env` and reads none of the exported names —
the idle server costs nothing.

`RALPH_DB_ENV=/path` overrides the file location (rarely needed).

## Publishing (later)

Same shape as the base image: `docker.io/daonhan/ralph-sandbox:pg17`. Once
pushed, machines set `RALPH_IMAGE=docker.io/daonhan/ralph-sandbox:pg17` and skip
the local build.
