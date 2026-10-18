#!/bin/sh
# BankSphere database-per-service initialiser (runs once, on an empty data directory).
#
# Each service gets its own login role that owns only its own schema, so a compromised service
# cannot read or modify another service's data (e.g. the ledger). Passwords come from the
# environment; nothing secret is stored in this file.
set -eu

create_service_role() {
  schema="$1"; role="$2"; password="$3"
  if [ -z "$password" ]; then
    echo "Missing password for role $role" >&2
    exit 1
  fi
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v schema="$schema" -v role="$role" -v password="$password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'role', :'password') \gexec
SELECT format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', :'schema', :'role') \gexec
SELECT format('ALTER SCHEMA %I OWNER TO %I', :'schema', :'role') \gexec
SELECT format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', :'schema') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'role') \gexec
SELECT format('ALTER ROLE %I SET search_path = %I', :'role', :'schema') \gexec
SQL
  echo "Provisioned schema $schema for role $role"
}

# Nobody gets to create objects in the shared public schema
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC" \
  -c "REVOKE ALL ON DATABASE \"$POSTGRES_DB\" FROM PUBLIC"

create_service_role auth_schema         auth_svc         "${AUTH_DB_PASSWORD:-}"
create_service_role customer_schema     customer_svc     "${CUSTOMER_DB_PASSWORD:-}"
create_service_role account_schema      account_svc      "${ACCOUNT_DB_PASSWORD:-}"
create_service_role ledger_schema       ledger_svc       "${LEDGER_DB_PASSWORD:-}"
create_service_role notification_schema notification_svc "${NOTIFICATION_DB_PASSWORD:-}"
create_service_role fraud_schema        fraud_svc        "${FRAUD_DB_PASSWORD:-}"
