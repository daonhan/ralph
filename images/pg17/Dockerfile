# syntax=docker/dockerfile:1
# ralph-sandbox + PostgreSQL 17 (+ PostGIS) — project-neutral variant.
#
# Every `docker run --rm` gets its own copy of PGDATA, so each Ralph stage starts
# from an empty server: nothing is shared between stages, workspaces or projects.
# Per-project settings come from the workspace, not from this image — see README.md
# (`<workspace>/.ralph/db.env`: PGDATABASE, DB_URL_VARS, DB_INIT_SQL).
FROM docker.io/daonhan/ralph-sandbox:latest

USER root

RUN curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/keyrings/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/keyrings/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-common \
  && sed -ri 's/#?(create_main_cluster)\s*=.*/\1 = false/' /etc/postgresql-common/createcluster.conf \
  && apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17 postgresql-17-postgis-3 \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/lib/postgresql/17/bin:${PATH}"

COPY --chmod=755 <<"EOF" /usr/local/bin/with-db
#!/bin/bash
# Start the container-local PostgreSQL, apply the workspace's optional
# .ralph/db.env, export the connection URL under the names the project reads,
# then exec the agent command.
set -euo pipefail

cfg="${RALPH_DB_ENV:-$PWD/.ralph/db.env}"
if [[ -f "$cfg" ]]; then
  # KEY=VALUE lines only; never sourced as shell.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
  done < "$cfg"
  echo "with-db: applied $cfg" >&2
fi
: "${PGDATABASE:=ralph_test}"
: "${DB_URL_VARS:=DATABASE_URL}"
export PGDATABASE   # so bare psql/createdb/pg_dump in the sandbox hit the same database

if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  if ! pg_ctl -D "$PGDATA" -w -t 30 -l /tmp/postgres.log start >/dev/null 2>&1; then
    echo "with-db: PostgreSQL 17 failed to start; /tmp/postgres.log follows" >&2
    [[ -f /tmp/postgres.log ]] && tail -n 50 /tmp/postgres.log >&2
    exit 1
  fi
fi

if ! pg_isready -q -h "$PGHOST" -U "$PGUSER" -d postgres; then
  echo "with-db: PostgreSQL 17 did not become ready" >&2
  exit 1
fi

if [[ "$(psql -h "$PGHOST" -U "$PGUSER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$PGDATABASE'")" != "1" ]]; then
  createdb -h "$PGHOST" -U "$PGUSER" "$PGDATABASE"
fi
if [[ -n "${DB_INIT_SQL:-}" ]]; then
  psql -v ON_ERROR_STOP=1 -q -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -c "$DB_INIT_SQL"
fi

url="postgres://${PGUSER}@${PGHOST}:5432/${PGDATABASE}"
for name in $DB_URL_VARS; do export "$name=$url"; done

echo "with-db: PostgreSQL 17 ready — ${DB_URL_VARS// /, } = ${url}" >&2
exec "$@"
EOF

USER agent

ENV PGDATA=/home/agent/pgdata \
    PGHOST=127.0.0.1 \
    PGUSER=ralph

RUN initdb -D "$PGDATA" -U "$PGUSER" --auth=trust --encoding=UTF8 --locale=C.UTF-8 \
  && { \
       echo "listen_addresses = '127.0.0.1'"; \
       echo "unix_socket_directories = '/tmp'"; \
     } >> "$PGDATA/postgresql.conf"

WORKDIR /home/agent/workspace
ENTRYPOINT ["/usr/local/bin/with-db"]
CMD ["claude"]
