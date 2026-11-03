# Runbooks

One section per alert in `backend/docker/observability/prometheus/alerts.yml`. Each says what the alert means for
customers, how to confirm it, and what to do, in that order. Commands assume the Compose stack from `backend/`
(`dc` = `docker compose -f docker-compose.yml -f docker-compose.dev.yml`); on Kubernetes use the equivalent
`kubectl -n banksphere` commands from [kubernetes.md](kubernetes.md).

General rules: money is never "fixed" by editing rows. The ledger is append-only, every correction is a new
posting through the service APIs, and every manual step goes in the incident log.

## service-down

**Means:** a service stopped answering its metrics port; requests to it fail or are shed by the gateway's circuit
breaker. **Confirm:** `dc ps`, then `dc logs --tail 200 <service>`. A service that exits at start-up names the
missing or invalid setting (they refuse to start on placeholders, bad keys or a non-HTTPS Razorpay base in
production). **Act:** fix the configuration and `dc up -d <service>`. If it runs out of memory, raise `mem_limit`
and record it in the capacity plan.

## high-error-ratio

**Means:** one service returns more than 2 % 5xx. **Confirm:** Grafana, "5xx ratio by service" and "Slowest
routes"; logs filtered by `"level":50` carry the `correlationId` and `traceId` of each failure. **Act:** a recent
deployment is the usual cause: roll back first, investigate after. A dependency error (Postgres, Redis, Kafka)
has its own alert below.

## error-budget-burn

**Means:** the edge is failing fast enough to use up the monthly budget in about two days. **Act:** treat as an
incident: find the failing service (previous section), stop deployments, communicate.

## slow-requests

**Means:** p95 above 300 ms for 10 minutes. **Confirm:** "Slowest routes" and "Service-to-service calls" panels;
Postgres "connections by state" (many `active` or `idle in transaction` means lock waits or pool exhaustion).
**Act:** scale the slow service if CPU-bound; if waits are on PgBouncer, check `connection_limit` in its
`DATABASE_URL` against the pool size; check the cache hit ratio (a cold or evicting cache Redis shifts reads to
Postgres).

## gateway-shedding

**Means:** a gateway replica hit `GATEWAY_MAX_INFLIGHT` (or `GATEWAY_MAX_STREAMS`) and answered 503
`SERVER_BUSY`. Usually a slow upstream holding requests open, not raw traffic. **Act:** fix the slow upstream
first (slow-requests); add gateway replicas if every upstream is healthy. Do not raise the limits to make the
alert go away: they protect the gateway's memory.

## circuit-breaker-open

**Means:** a service saw ≥ 50 % failures calling an upstream and stopped calling it for 5 s at a time; callers
get 503 `UPSTREAM_UNAVAILABLE` immediately. **Act:** the upstream named in the alert is the problem: see its own
alerts and logs. The breaker closes by itself after three successful probes.

## rate-limiter-unavailable

**Means:** the gateway cannot reach the edge Redis and is failing **open**: per-IP and per-user limits, IP bans and
deny rules are not enforced. Services still authenticate and authorize every request. **Act:** restore
`redis-ratelimit` (`dc logs redis-ratelimit`); nothing in it needs to be restored from backup (it is evictable,
and auth-service re-mirrors IP rules within a minute).

## credential-stuffing

**Means:** auth-service banned addresses that failed sign-in on more than 20 distinct accounts in 10 minutes.
**Confirm:** Security centre, "Security events", type `IP_AUTO_BANNED`. **Act:** usually nothing: bans expire after
30 minutes. For a sustained attack from one network, add a deny rule (Security centre, "IP rules"; at most a /8 or
an IPv6 /32, never a staff network). If many accounts were targeted, check `SIGN_IN_SUCCEEDED` events from the same
networks and force sign-out for any account that succeeded.

## outbox-backlog

**Means:** committed events are not reaching Kafka: notifications, fraud scoring and real-time updates lag. Money
is safe (the events are in the service's own database). **Confirm:** `dc logs <service> | grep -i outbox`, and
Kafka health. **Act:** restore Kafka or the service's SCRAM credentials; the relay drains the backlog in order.
Events the broker refused `OUTBOX_MAX_ATTEMPTS` times (`OutboxFailedEvents`) stay in the service's `outbox_events`
table with status `FAILED` and their last error; after fixing the cause, set them back to `PENDING` with
`retry_count = 0` (the one sanctioned manual write: it changes delivery state, never money) and the relay
publishes them in order.

## payment-reconciler

**Means:** reconciliation runs fail repeatedly, or none ran for 10 minutes (it runs every 60 s on whichever replica
holds the `payment-reconciler` lease). Paid top-ups may sit in CAPTURED and refunds in REFUND_PENDING. **Confirm:**
`dc logs payment-service | grep -i reconcil`; Razorpay status; the ledger internal API
(`PAYMENT_LEDGER_INTERNAL_TOKEN` must match in payment-service and transaction-service). **Act:** fix the dependency;
then run `POST /api/v1/payments/admin/reconcile` as an administrator and check its report. A lease held by a
dead replica expires after 5 minutes.

## webhook-signature-failures

**Means:** webhooks arrive with a bad `X-Razorpay-Signature`. **Confirm:** a recent change of
`RAZORPAY_WEBHOOK_SECRET` (it must match the secret in the Razorpay dashboard), or traffic from unknown sources
(set `RAZORPAY_WEBHOOK_ALLOWED_CIDRS`). **Act:** nothing is lost while this lasts: confirm and the reconciler settle
payments by fetching them from Razorpay's API.

## kafka-consumer-lag

**Means:** a consumer group is more than 1,000 messages behind. **Act:** check the consumer's logs for a poison
message (it is retried through `<service>.<topic>.retry` and then parked in `<topic>.dlq`, so it cannot block the
partition for long). Scale the consumer up to 12 replicas (one per partition).

## dead-letters

**Means:** a consumer gave up on a message after its retries. **Act:** read the message from `<topic>.dlq`, fix
the cause, and re-publish it to the original topic: every consumer is idempotent on `eventId`.

## realtime-stalled

**Means:** events are published to Redis but no open stream receives them. **Confirm:** `dc logs realtime-service`;
the cache Redis ACL user `realtime-svc` needs `&rt:*` channels. **Act:** restart realtime-service; browsers
reconnect with `Last-Event-ID` and replay what they missed (up to 100 events, 24 h).

## postgres

**Means:** Postgres is down or close to `max_connections`. **Act:** services reach Postgres only through PgBouncer
(transaction pooling); connection growth means a pool is misconfigured or a client bypasses PgBouncer. Migrations
connect directly and briefly. Never raise `max_connections` without memory headroom.

## redis

**Means:** a Redis instance is down or the security Redis is filling up. The security Redis never evicts (sign-ins,
revocations and MFA state would be lost): raise its memory or find the leak (keys without TTL under `auth:`). The
cache Redis evicts least-recently-used keys by design; a low hit ratio after a restart is expected and recovers.
