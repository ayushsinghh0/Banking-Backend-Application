#!/bin/sh
# PgBouncer in transaction pooling mode between every service and Postgres.
#
# Why: each service replica keeps its own Prisma pool, so connections grow with replicas x services while
# Postgres performs best with a few dozen busy backends. PgBouncer multiplexes thousands of client connections
# onto MAX_DB_CONNECTIONS server connections. Transaction mode is safe here because nothing relies on session
# state: locks are transaction-scoped (pg_advisory_xact_lock, SET LOCAL), Prisma runs with pgbouncer=true (no
# named prepared statements), and each runtime role's search_path/timeouts are role defaults applied when
# PgBouncer opens its server connection (one pool per role).
#
# Only the runtime (*_app) roles are listed: migrations connect to Postgres directly as the schema owners.
# Config and the auth file are written to /tmp (tmpfs) at start-up so no secret is baked into an image.
set -eu
: "${POSTGRES_DB:?}"

SERVICES="AUTH CUSTOMER ACCOUNT LEDGER NOTIFICATION FRAUD PAYMENT ASSISTANT"
umask 077
: > /tmp/userlist.txt
for svc in $SERVICES; do
  eval "password=\${${svc}_DB_APP_PASSWORD:-}"
  case "$password" in
    ''|*[Cc][Hh][Aa][Nn][Gg][Ee]_[Mm][Ee]*)
      echo "pgbouncer: ${svc}_DB_APP_PASSWORD is empty or still the CHANGE_ME placeholder; refusing to start" >&2
      exit 1 ;;
  esac
  role=$(echo "$svc" | tr 'A-Z' 'a-z')_app
  # userlist format: "user" "password" (double quotes inside a password are doubled)
  printf '"%s" "%s"\n' "$role" "$(printf '%s' "$password" | sed 's/"/""/g')" >> /tmp/userlist.txt
done

cat > /tmp/pgbouncer.ini <<EOF
[databases]
${POSTGRES_DB} = host=${POSTGRES_HOST:-postgres} port=5432 dbname=${POSTGRES_DB}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
auth_type = scram-sha-256
auth_file = /tmp/userlist.txt
pool_mode = transaction
; Client side: every replica's Prisma pool fits easily
max_client_conn = ${MAX_CLIENT_CONN:-4000}
; Server side: per (database, role) pool, and a hard cap on Postgres backends for the whole database
default_pool_size = ${DEFAULT_POOL_SIZE:-12}
min_pool_size = 2
reserve_pool_size = 4
reserve_pool_timeout = 2
max_db_connections = ${MAX_DB_CONNECTIONS:-80}
; Fail fast instead of queueing forever when Postgres is saturated (the services answer 503 + Retry-After)
query_wait_timeout = 10
server_idle_timeout = 300
server_lifetime = 3600
server_connect_timeout = 5
server_login_retry = 2
client_login_timeout = 15
; Prisma sends these startup parameters; they are harmless to drop in transaction mode
ignore_startup_parameters = extra_float_digits,options
server_reset_query =
server_check_query = select 1
server_check_delay = 30
stats_period = 60
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
EOF

exec /usr/bin/pgbouncer /tmp/pgbouncer.ini
