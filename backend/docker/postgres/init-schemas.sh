#!/bin/sh
# BankSphere database-per-service initialiser. Runs on an empty data directory (docker-entrypoint-initdb.d),
# and again on every deployment from the one-shot `db-bootstrap` job (over TCP, PGHOST set), so services
# added later get their schema and roles on existing databases too. Every statement is idempotent.
#
# For every service two roles are created:
#   <svc>_owner  owns the schema; used ONLY by the migration job (DDL)
#   <svc>_app    used by the running service; may only SELECT/INSERT/UPDATE/DELETE rows in its own
#                schema (no TRUNCATE, ALTER, DROP or trigger changes). Migrations further revoke
#                UPDATE/DELETE on append-only tables such as ledger_entries and audit logs.
# A compromised service therefore cannot touch another service's data, rewrite history or disable
# the ledger's integrity triggers. Passwords come from the environment; nothing secret is in this file.
set -eu

psql_admin() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
}

# Refuse unreplaced .env.example placeholders (a CHANGE_ME password is a known password). Initialisation
# stops here: fix .env, then remove the postgres_data volume and start again.
refuse_placeholder() {
  case "$2" in
    *[Cc][Hh][Aa][Nn][Gg][Ee]_[Mm][Ee]*)
      echo "$1 is still the CHANGE_ME placeholder from .env.example; refusing to initialise the database" >&2
      exit 1 ;;
  esac
}
refuse_placeholder POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-}"

# All timestamps are stored and compared in UTC; nobody may create objects in the public schema
psql_admin \
  -c "ALTER DATABASE \"$POSTGRES_DB\" SET timezone TO 'UTC'" \
  -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC" \
  -c "REVOKE ALL ON DATABASE \"$POSTGRES_DB\" FROM PUBLIC"

create_service_roles() {
  schema="$1"; prefix="$2"; owner_password="$3"; app_password="$4"
  if [ -z "$owner_password" ] || [ -z "$app_password" ]; then
    echo "Missing owner/app password for ${prefix}" >&2
    exit 1
  fi
  refuse_placeholder "The ${prefix}_owner password" "$owner_password"
  refuse_placeholder "The ${prefix}_app password" "$app_password"
  psql_admin -v schema="$schema" -v owner="${prefix}_owner" -v app="${prefix}_app" \
    -v owner_password="$owner_password" -v app_password="$app_password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'owner') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \gexec
SELECT format('CREATE ROLE %I LOGIN', :'app') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'owner', :'owner_password') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 100', :'app', :'app_password') \gexec

SELECT format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', :'schema', :'owner') \gexec
SELECT format('ALTER SCHEMA %I OWNER TO %I', :'schema', :'owner') \gexec
SELECT format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', :'schema') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), :'owner', :'app') \gexec

-- Runtime role: row-level DML only, on tables the owner creates (now or in future migrations)
SELECT format('GRANT USAGE ON SCHEMA %I TO %I', :'schema', :'app') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', :'schema', :'app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'owner', :'schema', :'app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', :'owner', :'schema', :'app') \gexec

-- Session defaults: own schema only, UTC, and no runaway statements or abandoned transactions
SELECT format('ALTER ROLE %I SET search_path = %I', r, :'schema') FROM unnest(ARRAY[:'owner', :'app']) AS r \gexec
SELECT format('ALTER ROLE %I SET timezone = %L', r, 'UTC') FROM unnest(ARRAY[:'owner', :'app']) AS r \gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'app', '30s') \gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'app', '60s') \gexec
SQL
  echo "Provisioned schema ${schema}: ${prefix}_owner (migrations) and ${prefix}_app (runtime)"
}

create_service_roles auth_schema         auth         "${AUTH_DB_OWNER_PASSWORD:-}"         "${AUTH_DB_APP_PASSWORD:-}"
create_service_roles customer_schema     customer     "${CUSTOMER_DB_OWNER_PASSWORD:-}"     "${CUSTOMER_DB_APP_PASSWORD:-}"
create_service_roles account_schema      account      "${ACCOUNT_DB_OWNER_PASSWORD:-}"      "${ACCOUNT_DB_APP_PASSWORD:-}"
create_service_roles ledger_schema       ledger       "${LEDGER_DB_OWNER_PASSWORD:-}"       "${LEDGER_DB_APP_PASSWORD:-}"
create_service_roles notification_schema notification "${NOTIFICATION_DB_OWNER_PASSWORD:-}" "${NOTIFICATION_DB_APP_PASSWORD:-}"
create_service_roles fraud_schema        fraud        "${FRAUD_DB_OWNER_PASSWORD:-}"        "${FRAUD_DB_APP_PASSWORD:-}"
create_service_roles payment_schema      payment      "${PAYMENT_DB_OWNER_PASSWORD:-}"      "${PAYMENT_DB_APP_PASSWORD:-}"
create_service_roles assistant_schema    assistant    "${ASSISTANT_DB_OWNER_PASSWORD:-}"    "${ASSISTANT_DB_APP_PASSWORD:-}"

# Optional monitoring role for postgres-exporter (observability overlay): pg_monitor reads statistics and
# settings, never table data. Created only when MONITORING_DB_PASSWORD is set.
if [ -n "${MONITORING_DB_PASSWORD:-}" ]; then
  refuse_placeholder MONITORING_DB_PASSWORD "$MONITORING_DB_PASSWORD"
  psql_admin -v password="$MONITORING_DB_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE metrics_reader LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrics_reader') \gexec
SELECT format('ALTER ROLE metrics_reader WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5', :'password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO metrics_reader', current_database()) \gexec
GRANT pg_monitor TO metrics_reader;
SQL
  echo "Provisioned metrics_reader (pg_monitor) for postgres-exporter"
fi

# Query statistics for the slow-query dashboards (the library is preloaded by the server's command line).
# Only the superuser and monitoring roles can read other roles' query texts.
psql_admin -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" || echo "pg_stat_statements not preloaded; skipping"
