#!/bin/sh
# Cache Redis: application caches and real-time fan-out. Evictable and not persisted: everything here can be
# rebuilt from the databases, so memory pressure evicts least-recently-used keys instead of refusing writes.
# Never holds security state (that is the AOF-persisted `redis`).
#
# One ACL user per service, each confined to its own key prefix, so a compromised service can neither read
# nor poison another service's cache:
#   ledger-svc     ~cache:ledger:*                       (transaction-service)
#   account-svc    ~cache:account:*
#   customer-svc   ~cache:customer:*
#   payment-svc    ~cache:payment:* ~rl:payment:*
#   assistant-svc  ~cache:assistant:* ~rl:assistant:*   (conversation limits and token budgets)
#   realtime-svc   ~rt:* and channels &rt:*              (pub/sub fan-out and replay streams)
#   monitor        no keys, no channels: INFO and friends for redis_exporter (only when
#                  REDIS_CACHE_MONITOR_PASSWORD is set, i.e. with the observability overlay)
#   default        disabled
# Commands: reads, writes and scripts (cache locks, GCRA); dangerous/admin commands are refused. +info is for
# the client ready check only.
set -eu
for var in REDIS_CACHE_LEDGER_PASSWORD REDIS_CACHE_ACCOUNT_PASSWORD REDIS_CACHE_CUSTOMER_PASSWORD \
           REDIS_CACHE_PAYMENT_PASSWORD REDIS_CACHE_ASSISTANT_PASSWORD REDIS_CACHE_REALTIME_PASSWORD; do
  eval "value=\${$var:-}"
  case "$value" in
    ''|*[Cc][Hh][Aa][Nn][Gg][Ee]_[Mm][Ee]*)
      echo "redis-cache: $var is empty or still the CHANGE_ME placeholder; refusing to start" >&2
      exit 1 ;;
  esac
done

COMMANDS="+@read +@write +@scripting +@connection -@dangerous +info"
MONITOR=""
if [ -n "${REDIS_CACHE_MONITOR_PASSWORD:-}" ]; then
  MONITOR="--user monitor on >${REDIS_CACHE_MONITOR_PASSWORD} resetkeys resetchannels -@all +ping +info +config|get +client|list +slowlog|get +slowlog|len +latency|latest +memory|stats +dbsize"
fi
# shellcheck disable=SC2086
exec redis-server \
  --save '' --appendonly no \
  --maxmemory "${REDIS_CACHE_MAXMEMORY:-192mb}" --maxmemory-policy allkeys-lru \
  --lazyfree-lazy-eviction yes --lazyfree-lazy-expire yes \
  --user default off \
  --user ledger-svc on ">${REDIS_CACHE_LEDGER_PASSWORD}" '~cache:ledger:*' resetchannels $COMMANDS \
  --user account-svc on ">${REDIS_CACHE_ACCOUNT_PASSWORD}" '~cache:account:*' resetchannels $COMMANDS \
  --user customer-svc on ">${REDIS_CACHE_CUSTOMER_PASSWORD}" '~cache:customer:*' resetchannels $COMMANDS \
  --user payment-svc on ">${REDIS_CACHE_PAYMENT_PASSWORD}" '~cache:payment:*' '~rl:payment:*' resetchannels $COMMANDS \
  --user assistant-svc on ">${REDIS_CACHE_ASSISTANT_PASSWORD}" '~cache:assistant:*' '~rl:assistant:*' resetchannels $COMMANDS \
  --user realtime-svc on ">${REDIS_CACHE_REALTIME_PASSWORD}" '~rt:*' '&rt:*' $COMMANDS +@pubsub   $MONITOR
