#!/bin/bash
# Kafka bootstrap (idempotent): topics, one SCRAM-SHA-512 user per service, least-privilege ACLs.
# Runs with the broker-only "admin" principal; services never see the admin password.
set -euo pipefail

# Refuse empty passwords and unreplaced .env.example placeholders (a CHANGE_ME password is a known password)
for var in KAFKA_ADMIN_PASSWORD KAFKA_AUTH_PASSWORD KAFKA_ACCOUNT_PASSWORD KAFKA_LEDGER_PASSWORD \
           KAFKA_FRAUD_PASSWORD KAFKA_NOTIFICATION_PASSWORD KAFKA_PAYMENT_PASSWORD KAFKA_REALTIME_PASSWORD; do
  case "${!var:-}" in
    ''|*[Cc][Hh][Aa][Nn][Gg][Ee]_[Mm][Ee]*)
      echo "kafka-init: $var is empty or still the CHANGE_ME placeholder; refusing to provision Kafka" >&2
      exit 1 ;;
  esac
done

BIN=/opt/kafka/bin
BOOTSTRAP=kafka:29092
CFG=/tmp/admin.properties
printf 'security.protocol=SASL_PLAINTEXT\nsasl.mechanism=PLAIN\nsasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="%s";\n' \
  "$KAFKA_ADMIN_PASSWORD" > "$CFG"

topics() { "$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CFG" "$@"; }
acl() { "$BIN/kafka-acls.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CFG" --add --force "$@" >/dev/null; }

EVENTS="user.registered.v1 account.created.v1 account.status.changed.v1 transaction.completed.v1 fraud.alert.created.v1 withdrawal.code.created.v1 beneficiary.added.v1 payment.updated.v1 security.new_device_login.v1"
# Topics each consuming service subscribes to
FRAUD_TOPICS="transaction.completed.v1"
NOTIFICATION_TOPICS="$EVENTS"
REALTIME_TOPICS="transaction.completed.v1 payment.updated.v1 fraud.alert.created.v1 account.status.changed.v1 beneficiary.added.v1"

# Partitions bound how many consumer replicas can work in parallel (one partition per replica at most), and they
# can only ever be increased, so domain topics start with headroom. Events are keyed (account or customer id),
# which keeps per-key ordering. Growing an existing topic remaps keys to partitions, so do it during a quiet
# period: messages for one key published just before and just after may be consumed out of order once.
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-12}"
ensure_topic() { # topic partitions
  topics --create --if-not-exists --topic "$1" --partitions "$2" --replication-factor 1
  current=$(topics --describe --topic "$1" | sed -n 's/.*PartitionCount: *\([0-9]*\).*/\1/p' | head -1)
  if [ -n "$current" ] && [ "$current" -lt "$2" ]; then
    echo "kafka-init: growing $1 from $current to $2 partitions"
    topics --alter --topic "$1" --partitions "$2"
  fi
}

for t in $EVENTS; do
  ensure_topic "$t" "$PARTITIONS"
  ensure_topic "$t.dlq" 1
done
ensure_topic notifications.dlq 1
# Delayed-retry topics, one set PER CONSUMING SERVICE (<service>.<topic>.retry): transient failures are parked
# there (with a retryAt) instead of blocking the partition. Only the owning service may write or read them, so
# no other service can inject or replay messages into its retry path.
for t in $FRAUD_TOPICS; do
  ensure_topic "fraud.$t.retry" "$PARTITIONS"
done
for t in $NOTIFICATION_TOPICS; do
  ensure_topic "notification.$t.retry" "$PARTITIONS"
done
for t in $REALTIME_TOPICS; do
  ensure_topic "realtime.$t.retry" "$PARTITIONS"
done

# SCRAM credentials (re-running simply resets them to the configured passwords)
for pair in "auth-svc:$KAFKA_AUTH_PASSWORD" "account-svc:$KAFKA_ACCOUNT_PASSWORD" "ledger-svc:$KAFKA_LEDGER_PASSWORD" \
            "fraud-svc:$KAFKA_FRAUD_PASSWORD" "notification-svc:$KAFKA_NOTIFICATION_PASSWORD" \
            "payment-svc:$KAFKA_PAYMENT_PASSWORD" "realtime-svc:$KAFKA_REALTIME_PASSWORD"; do
  user="${pair%%:*}"; password="${pair#*:}"
  "$BIN/kafka-configs.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CFG" --alter \
    --add-config "SCRAM-SHA-512=[iterations=8192,password=$password]" --entity-type users --entity-name "$user" >/dev/null
done

produce() { acl --allow-principal "User:$1" --operation Write --operation Describe --topic "$2"; }
consume() { acl --allow-principal "User:$1" --operation Read --operation Describe --topic "$2"; }
group()   { acl --allow-principal "User:$1" --operation Read --group "$2"; }
idempotent() { acl --allow-principal "User:$1" --operation IdempotentWrite --cluster; }
# Removing an ACL that does not exist is a no-op, so this stays idempotent on fresh and upgraded clusters
revoke()  {
  "$BIN/kafka-acls.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CFG" --remove --force \
    --allow-principal "User:$1" --operation Read --operation Write --operation Describe --topic "$2" >/dev/null \
    || echo "kafka-init: could not remove legacy ACLs of $1 on $2" >&2
}

# Producers: each domain event has exactly one owner
produce auth-svc    user.registered.v1
produce account-svc account.created.v1
produce account-svc account.status.changed.v1
produce ledger-svc  transaction.completed.v1
produce ledger-svc  withdrawal.code.created.v1
produce ledger-svc  beneficiary.added.v1
produce fraud-svc   fraud.alert.created.v1
produce payment-svc payment.updated.v1
produce auth-svc    security.new_device_login.v1
for u in auth-svc account-svc ledger-svc fraud-svc notification-svc payment-svc realtime-svc; do idempotent "$u"; done

# Consumers: each owns its retry hop (produce + consume <service>.<topic>.retry) and dead-letters to the
# original topic's <topic>.dlq (poison messages, and anything on its retry topic that isn't a valid envelope)
for t in $FRAUD_TOPICS; do
  consume fraud-svc "$t"
  consume fraud-svc "fraud.$t.retry"
  produce fraud-svc "fraud.$t.retry"
  produce fraud-svc "$t.dlq"
done
group   fraud-svc fraud-service-group
group   fraud-svc fraud-service-group.retry
for t in $NOTIFICATION_TOPICS; do
  consume notification-svc "$t"
  consume notification-svc "notification.$t.retry"
  produce notification-svc "notification.$t.retry"
  produce notification-svc "$t.dlq"
done
group   notification-svc notification-service-group
group   notification-svc notification-service-group.retry
produce notification-svc notifications.dlq
for t in $REALTIME_TOPICS; do
  consume realtime-svc "$t"
  consume realtime-svc "realtime.$t.retry"
  produce realtime-svc "realtime.$t.retry"
  produce realtime-svc "$t.dlq"
done
group   realtime-svc realtime-service-group
group   realtime-svc realtime-service-group.retry

# Legacy shared <topic>.retry topics (written and read by BOTH consumers): no service may use them any more.
# The topics are left in place and nothing consumes them; drain them before upgrading (see README).
for t in $EVENTS; do
  revoke fraud-svc "$t.retry"
  revoke notification-svc "$t.retry"
done

# Optional monitoring principal (observability overlay: kafka-exporter reads consumer lag). Describe only: it can
# list topics, partitions and group offsets, never read or write a message.
if [ -n "${KAFKA_MONITOR_PASSWORD:-}" ]; then
  case "$KAFKA_MONITOR_PASSWORD" in
    *[Cc][Hh][Aa][Nn][Gg][Ee]_[Mm][Ee]*) echo "kafka-init: KAFKA_MONITOR_PASSWORD is still the CHANGE_ME placeholder" >&2; exit 1 ;;
  esac
  "$BIN/kafka-configs.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CFG" --alter     --add-config "SCRAM-SHA-512=[iterations=8192,password=$KAFKA_MONITOR_PASSWORD]" --entity-type users --entity-name monitor-svc >/dev/null
  acl --allow-principal User:monitor-svc --operation Describe --topic '*'
  acl --allow-principal User:monitor-svc --operation Describe --group '*'
  acl --allow-principal User:monitor-svc --operation Describe --cluster
  echo "Kafka monitoring user monitor-svc ready (describe only)"
fi

echo "Kafka topics, users and ACLs ready"
