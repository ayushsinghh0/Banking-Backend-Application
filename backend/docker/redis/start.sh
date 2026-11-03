#!/bin/sh
# Security Redis (token versions, revoked jtis, MFA challenges, known networks) with ACL users:
#   auth-svc      read/write on auth:*            (the only writer of security state)
#   (token state = auth:tv:* versions, auth:revoked-jti:* tokens, auth:revoked-sid:* sessions)
#   customer-svc  read-only token state + read/write on its own customer:* cache
#   reader        read-only token state           (account, transaction, fraud, notification)
#   default       disabled
# +info is granted only for the client ready check (no key access).
# AOF persistence + noeviction: revocation state must never be dropped silently.
set -eu
: "${REDIS_AUTH_PASSWORD:?}" "${REDIS_CUSTOMER_PASSWORD:?}" "${REDIS_READER_PASSWORD:?}"
# Refuse unreplaced .env.example placeholders (a CHANGE_ME password is a known password)
for pair in "REDIS_AUTH_PASSWORD:$REDIS_AUTH_PASSWORD" "REDIS_CUSTOMER_PASSWORD:$REDIS_CUSTOMER_PASSWORD" \
            "REDIS_READER_PASSWORD:$REDIS_READER_PASSWORD"; do
  case "${pair#*:}" in
    *[Cc][Hh][Aa][Nn][Gg][Ee]_[Mm][Ee]*)
      echo "redis: ${pair%%:*} is still the CHANGE_ME placeholder from .env.example; refusing to start" >&2
      exit 1 ;;
  esac
done
exec redis-server \
  --appendonly yes --appendfsync everysec \
  --maxmemory 256mb --maxmemory-policy noeviction \
  --user default off \
  --user auth-svc on ">${REDIS_AUTH_PASSWORD}" '~auth:*' '+@all' '-@dangerous' '+info' '+ping' \
  --user customer-svc on ">${REDIS_CUSTOMER_PASSWORD}" '%R~auth:tv:*' '%R~auth:revoked-jti:*' '%R~auth:revoked-sid:*' '~customer:*' \
       '+ping' '+info' '+get' '+mget' '+set' '+del' '+exists' \
  --user reader on ">${REDIS_READER_PASSWORD}" '%R~auth:tv:*' '%R~auth:revoked-jti:*' '%R~auth:revoked-sid:*' '+ping' '+info' '+get' '+mget'
