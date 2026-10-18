#!/bin/sh
# BankSphere database-per-service initialiser (runs once, on an empty data directory).
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
