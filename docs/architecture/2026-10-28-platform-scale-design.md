# BankSphere platform upgrade: scale, payments, assistant, real-time, edge security

Status: accepted (2026-10-28). Branch: `feature/scale-payments-assistant`, stacked on `feature/fullstack-platform`.

This document is the contract between everyone building this upgrade. Every API, event, environment variable and
file-ownership rule below is binding; if something here turns out to be wrong, fix the document in the same change.

## 1. Intent

The banking core (ledger, accounts, KYC, teller cash, fraud, notifications) is already correct and hardened. This
upgrade makes it a platform that can serve a very large customer base, and adds the features a modern bank app is
expected to have:

1. **Add money with Razorpay** (UPI, cards, net banking) with signature verification, webhooks, reconciliation and
   admin refunds, all double-entry in the ledger.
2. **Sphere, an AI assistant** that answers questions about the customer's own money using read-only tools. It works
   with any OpenAI-compatible API (OpenAI, Groq, OpenRouter, a local Ollama) and falls back to a built-in,
   deterministic assistant when no key is configured. It can never move money.
3. **Real-time updates** to every open page (money received, top-up credited, new fraud alert) over Server-Sent
   Events, fanned out through Kafka and Redis so it scales horizontally.
4. **Edge protection at the gateway**: per-user and per-IP GCRA rate limits, route cost classes, IP deny rules and
   automatic bans, load shedding, circuit breakers.
5. **Account security for users**: sessions and devices with remote sign-out, sign-in history, new-device alerts,
   credential-stuffing defence.
6. **Explicit authorization on every route**, proven by tests, and a generated access matrix.
7. **Caching** with Redis (read-through, stampede-safe, writer-owned invalidation).
8. **Operability**: Prometheus metrics on every service, Grafana dashboards and alert rules, W3C trace context
   propagation, PgBouncer, Kafka partitioning, a horizontal-scale Compose overlay, Kubernetes manifests (HPA, PDB,
   NetworkPolicy), CI with security scanning, and k6 load tests with a capacity model.

### What "a million users" means here (honest framing)

A million *registered* customers is a sizing input, not a test we can run on a laptop. Typical retail-banking ratios
put peak concurrency at 2 to 5 % of registered users and peak load around 3 to 8 k requests/second, of which about
5 % are money movements. The design goal is therefore: **every tier scales horizontally and nothing has a
per-request cost that grows with the user count**. We prove the per-replica numbers with k6 on the local stack and
derive the replica counts from them in `docs/operations/capacity-plan.md`. We never claim a measurement we did not
make.

### Non-goals

- No new money-movement rails besides Razorpay top-ups (no NEFT/IMPS/UPI payouts).
- The assistant never executes an action. It may *draft* a transfer that the customer reviews and submits through
  the normal, step-up protected transfer screen.
- No database sharding now. The capacity plan says when and how (by customer id).
- No new frontend runtime dependencies, and no new backend dependency other than `prom-client`.

## 2. Architecture

```
 browser ──HTTPS──▶ web (nginx: SPA, CSP, /api proxy, SSE passthrough)
                     │
                     ▼
              api-gateway ×N  ── edge Redis (rate limits, IP rules, bans)
   JWT verify for keys only, GCRA limits, IP rules, load shedding, circuit breakers, streaming proxy
                     │
   ┌──────────┬──────────┬──────────┬──────────────┬──────────┬──────────┬──────────┬──────────┐
 auth   customer  account  transaction(ledger)  notification  fraud   payment  assistant  realtime
   │        │        │          │                    │          │        │         │          │
   └────────┴────────┴──── PgBouncer ──▶ Postgres (schema per service, owner/app roles)       │
   security Redis (token state, AOF)       cache Redis (cache:*, rt:* pub/sub, replay streams)┘
   Kafka (SASL/SCRAM per service, ACLs, outbox relays, per-consumer retry topics, DLQs)
   Razorpay API ◀── payment-service (egress)     LLM API ◀── assistant-service (egress)
```

New services and ports:

| Service | Port | Schema | Networks | Purpose |
|---|---|---|---|---|
| payment-service | 8007 | `payment_schema` | apps, backend, egress | Razorpay top-ups, webhooks, reconciliation, refunds |
| assistant-service | 8008 | `assistant_schema` | apps, backend, egress | Sphere assistant (SSE) |
| realtime-service | 8009 | none | apps, backend | SSE fan-out of domain events |
| razorpay-simulator | 8010 | none | backend | **dev and e2e only**: Razorpay API stand-in |

Every service also serves Prometheus metrics on `METRICS_PORT` (default `9464`), on a separate listener that is
never routed by the gateway or nginx.

### Redis instances

| Instance | Persistence | Eviction | Used for |
|---|---|---|---|
| `redis` (existing) | AOF | noeviction | security state only (token versions, revocations, MFA state) |
| `redis-ratelimit` (existing, the "edge" Redis) | none | allkeys-lru | gateway GCRA buckets, IP rules mirror, bans, login counters |
| `redis-cache` (new) | none | allkeys-lru | application cache `cache:<svc>:*`, real-time pub/sub `rt:*`, replay streams |

`redis-cache` has one ACL user per service, restricted to its own key prefix (`~cache:ledger:*` and so on;
`realtime-svc` gets `~rt:* &rt:*`; producers of real-time events get `&rt:*` publish only). Services read it from
`CACHE_REDIS_URL`; when that is unset, caching is disabled (no-op cache) so unit tests and native development need
nothing extra.

## 3. Shared library additions (`@banksphere/common`)

Built first; every service uses these instead of re-implementing them.

| Module | Exports | Notes |
|---|---|---|
| `observability/metrics.ts` | `metrics` (registry), `httpMetricsMiddleware`, `startMetricsServer(port?)`, `counter/gauge/histogram` helpers | `http_server_requests_seconds{service,method,route,status}`; `route` is the Express route template, never the raw path. Default process metrics. |
| `observability/trace-context.ts` | `traceContextMiddleware`, `currentTraceparent(req)`, `parseTraceparent`, `newTraceparent` | W3C `traceparent`: accepted from the gateway, generated if absent, logged as `traceId`, forwarded by `ServiceClient`. |
| `cache/cache.ts` | `Cache`, `NoopCache`, `createCache(namespace, url?)` | read-through `getOrLoad(key, loader, {ttlSeconds})`, jittered TTL, in-process single flight, cross-replica lock against stampedes, `invalidate`, `bumpVersion(tag)` / `versioned(tag)` for writer-owned invalidation, BigInt-safe serialisation, fail-open to the loader on Redis errors, hit/miss metrics. |
| `resilience/circuit-breaker.ts` | `CircuitBreaker` | closed, open, half-open; rolling window; failure ratio with minimum volume; cooldown; state gauge. |
| `resilience/retry.ts` | `retry(fn, {attempts, baseMs, maxMs, retryOn})` | exponential backoff with full jitter. |
| `http/service-client.ts` | `ServiceClient` | `fetch` wrapper for service-to-service calls: base URL, per-call timeout, deadline header, internal token header, forwarded `x-forwarded-for` / correlation id / `traceparent`, retries for idempotent methods only, circuit breaker, typed `{ success, data }` unwrapping, upstream errors mapped to `HttpError`. |
| `rate-limit/gcra.ts` | `GcraLimiter`, `createGcraMiddleware` | Generic Cell Rate Algorithm in one Lua call: O(1) memory per key, smooth bursts, exact `Retry-After`. The same script can check a ban key first, so the edge pays one Redis round trip per request. |
| `auth/permissions.ts` | `PERMISSIONS`, `ROLE_PERMISSIONS`, `authorize(...perms)`, `rolesWith(perm)`, `can(user, perm)` | central role-to-permission matrix (section 4). |
| `auth/route-policy.ts` | `publicRoute(reason)`, `anyAuthenticated(note)`, `describeRoutes(router)`, `assertRoutePolicies(router, expected)` | every route handler chain must carry exactly one policy marker (`requireRoles`, `authorize`, `anyAuthenticated`, `publicRoute`). Tests walk the router stack. |
| `audit/audit-chain.ts` | `GENESIS_HASH`, `canonicalJson`, `auditHash(prevHash, record)`, `verifyAuditChain(rows)` | tamper-evident hash chain for audit tables. |
| `http/sse.ts` | `openEventStream(req, res, {heartbeatMs})` returns `{ send(event, data, id?), close() , closed }` | sets `text/event-stream`, `no-transform`, `X-Accel-Buffering: no`, heartbeats, closes on disconnect. |

`createBaseApp()` installs `traceContextMiddleware` and `httpMetricsMiddleware`; `startHttpServer()` starts the
metrics listener when `METRICS_PORT` is set.

## 4. Authorization model

Roles stay as they are (`CUSTOMER, SUPPORT, TELLER, KYC_OFFICER, FRAUD_ANALYST, BANK_ADMIN`). New code authorizes by
**permission**; existing routers keep `requireRoles` (now tagged as a policy). Ownership ("only your own account") is
always enforced in the service layer as well, never only by role.

New permissions (`ROLE_PERMISSIONS` in `@banksphere/common`):

| Permission | Roles |
|---|---|
| `payments:topup` (create, confirm, cancel own top-ups) | CUSTOMER |
| `payments:read:own` | CUSTOMER |
| `payments:read:any` | BANK_ADMIN, SUPPORT, FRAUD_ANALYST |
| `payments:refund` (also requires recent step-up) | BANK_ADMIN |
| `payments:reconcile` | BANK_ADMIN |
| `assistant:chat` | every role |
| `realtime:subscribe` | every role |
| `security:sessions:own` | every role |
| `security:sessions:read:any` | BANK_ADMIN, SUPPORT |
| `security:sessions:revoke:any` | BANK_ADMIN |
| `security:events:read:any` | BANK_ADMIN, SUPPORT, FRAUD_ANALYST |
| `security:ip-rules:read` | BANK_ADMIN, SUPPORT |
| `security:ip-rules:write` | BANK_ADMIN |
| `audit:verify` | BANK_ADMIN |

**Every route in every service** must carry a policy marker; each service has a `route-policies.spec.ts` that
compares its routers with a declared table in `src/routes/access.ts`. `scripts/access-matrix.mjs` turns those tables
into `docs/security/access-matrix.md`.

## 5. Events (Kafka)

Existing envelope: `{ eventId, eventType, timestamp, correlationId?, ...payload }`, published through each
service's transactional outbox. Keys: account id for ledger events, customer id otherwise.

New topics (12 partitions; existing domain topics are raised to 12 as well; partitions only ever grow):

| Topic | Producer | Consumers | Payload |
|---|---|---|---|
| `payment.updated.v1` | payment-svc | realtime, notification | `topUpId, customerId, accountId, amountInPaise, status, previousStatus, method?, failureReason?` |
| `security.new_device_login.v1` | auth-svc | notification | `userId, email, deviceLabel, ipMasked, at` |

Existing topics gain a consumer: **realtime-svc** reads `transaction.completed.v1`, `payment.updated.v1`,
`fraud.alert.created.v1`, `account.status.changed.v1`, `beneficiary.added.v1`. **fraud-svc** keeps reading
`transaction.completed.v1`, which now also carries `type: ONLINE_TOP_UP | TOP_UP_REFUND`.

New Kafka users: `payment-svc`, `realtime-svc` (SCRAM, least-privilege ACLs as today, own retry topics
`<ns>.<topic>.retry`).

## 6. Payments: Razorpay top-ups (payment-service)

### Money flow

The ledger gets a system account of kind `PAYMENT_CLEARING` (an asset: money receivable from Razorpay). A captured
top-up posts **debit PAYMENT_CLEARING, credit customer** (`TransactionType.ONLINE_TOP_UP`). A refund posts
**debit customer, credit PAYMENT_CLEARING** (`TOP_UP_REFUND`). Reconciliation treats `PAYMENT_CLEARING` like the
other asset accounts.

### States

```
CREATED ─▶ PENDING ─▶ CAPTURED ─▶ CREDITED ─▶ REFUND_PENDING ─▶ REFUNDED
   │          │           │                         └──────────▶ CREDITED (refund failed, compensated)
   │          ▼           └─▶ CREDIT_BLOCKED (account closed/frozen, amount mismatch) ─▶ REFUND_PENDING
   ├─▶ CANCELLED (customer closed checkout)
   ├─▶ FAILED (payment failed)
   └─▶ EXPIRED (no payment within TOPUP_ORDER_TTL_MINUTES)
CANCELLED / FAILED / EXPIRED ─▶ CAPTURED  (a late capture still credits the customer: their money was taken)
```

Transitions are a closed table in code; every write is `UPDATE … WHERE id = $1 AND status = ANY($allowed) AND version = $v`
and appends to `payment_status_history` (append-only).

### API (gateway prefix `/api/v1/payments`)

| Method and path | Permission | Notes |
|---|---|---|
| `GET /config` | `payments:topup` | `{ provider: 'RAZORPAY', mode: 'live'\|'test'\|'simulator', keyId, limits: { minPaise, maxPaise, dailyLimitPaise, usedTodayPaise, remainingTodayPaise } }` (amounts as strings) |
| `POST /top-ups` | `payments:topup` | `Idempotency-Key` required. Body `{ accountId, amountPaise: string }`. Checks: own active CUSTOMER account, KYC `VERIFIED`, min/max, daily cap (IST day, counting CREATED/PENDING unexpired + CAPTURED + CREDITED), at most 3 open orders. Creates the Razorpay order (`receipt` = top-up id, `notes` = top-up id and account last 4). 201 `{ topUp, checkout: { keyId, orderId, amount, currency, name, description, prefill: { email } } }` |
| `POST /top-ups/:id/confirm` | `payments:topup` | Body `{ razorpayPaymentId, razorpayOrderId, razorpaySignature }`. Verifies `HMAC_SHA256(order_id + "\|" + payment_id, key_secret)` in constant time, then **fetches the payment from Razorpay** and checks order id, amount, currency and status (captures if `authorized`). Settles (credit) idempotently. Returns `{ topUp }`. |
| `POST /top-ups/:id/cancel` | `payments:topup` | Customer dismissed checkout: CREATED/PENDING → CANCELLED. |
| `POST /top-ups/:id/simulate` | `payments:topup` | **Only when mode is `simulator` and `NODE_ENV !== 'production'`** (404 otherwise). Body `{ outcome: 'success'\|'failure', method: 'upi'\|'card'\|'netbanking' }`. Asks the simulator to pay; returns the same triple Checkout.js would hand the browser. |
| `GET /top-ups?limit&cursor` | `payments:read:own` | own, newest first, cursor pagination |
| `GET /top-ups/:id` | `payments:read:own` or `payments:read:any` | owner, or staff |
| `POST /webhooks/razorpay` | public (signature) | raw body ≤ 64 KB; `X-Razorpay-Signature` = HMAC_SHA256(raw body, webhook secret); dedupe on `X-Razorpay-Event-Id`; handles `payment.authorized`, `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`, `refund.failed`; optional source allowlist `RAZORPAY_WEBHOOK_ALLOWED_CIDRS`. Invalid signature: 400 and a security log line. Unknown event types: 200, ignored. |
| `GET /admin/top-ups?status&customerId&from&to&limit&cursor` | `payments:read:any` | |
| `GET /admin/summary` | `payments:read:any` | today (IST): counts and sums by status, success rate, median seconds from created to credited |
| `POST /admin/top-ups/:id/refund` | `payments:refund` + step-up | Body `{ reason }` (10–300 chars). Saga: REFUND_PENDING → ledger debit (idempotent on refund id) → Razorpay refund → REFUNDED (or `refund.processed` webhook). If Razorpay refuses, compensate the ledger debit and return to CREDITED. CREDIT_BLOCKED orders refund without a ledger debit. |
| `POST /admin/reconcile` | `payments:reconcile` | runs the reconciler now, returns its report |

Top-up JSON shape (`topUp`): `{ id, accountId, accountNumberLast4, amountPaise, currency, status, method, providerOrderId,
providerPaymentId, failureReason, createdAt, updatedAt, creditedAt, expiresAt, refundedAt, refundReason, history?: [{ from, to, source, at }] }`.

### Reconciler (job lease, every 60 s)

CREATED/PENDING older than 2 minutes: fetch the order's payments; capture `authorized`, settle `captured`, mark
`failed`; expire after the TTL. CAPTURED but not CREDITED: retry the ledger credit. REFUND_PENDING: check the refund.
Report counts as metrics and log lines.

### Ledger internal API for payments (transaction-service)

A separate router `/internal/v1/payments` with its own credential **`PAYMENT_LEDGER_INTERNAL_TOKEN`**
(least privilege: payment-service cannot provision or close accounts).

| Route | Body | Result |
|---|---|---|
| `GET /accounts/:accountId` | | `{ accountId, customerId, accountNumberLast4, isActive, closed }`; 404 unless a CUSTOMER account |
| `POST /credits` | `{ topUpId, accountId, customerId, amountPaise, providerPaymentId }` | idempotent on `topUpId` (reference `TOPUP-<topUpId>`); 409 `ACCOUNT_NOT_CREDITABLE` if inactive, closed, or owner mismatch; `{ transactionId, referenceId, replayed }` |
| `POST /refunds` | `{ refundId, topUpId, accountId, customerId, amountPaise }` | idempotent on `refundId` (`TOPUP-REFUND-<refundId>`); no daily outflow limit (bank-initiated) but never overdraws: 409 `INSUFFICIENT_FUNDS` |
| `POST /refunds/:refundId/reverse` | | compensation, idempotent (`TOPUP-REFUND-REV-<refundId>`) |

### Razorpay simulator (dev and e2e only)

`services/razorpay-simulator`: an in-memory implementation of `POST /v1/orders`, `GET /v1/orders/:id`,
`GET /v1/orders/:id/payments`, `GET /v1/payments/:id`, `POST /v1/payments/:id/capture`, `POST /v1/payments/:id/refund`,
`GET /v1/refunds/:id` with HTTP basic auth on the key pair, plus `POST /sim/checkout/:orderId` which creates a payment,
returns the signed triple, and delivers a correctly signed webhook (with an event id) to `SIM_WEBHOOK_URL`. It is only
in `docker-compose.dev.yml`. payment-service refuses to start in production with a non-HTTPS `RAZORPAY_API_BASE` or a
`rzp_test_` key unless `RAZORPAY_ALLOW_TEST_KEYS=true`.

### Configuration

`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_API_BASE` (default
`https://api.razorpay.com`), `RAZORPAY_WEBHOOK_ALLOWED_CIDRS` (optional), `PAYMENT_LEDGER_INTERNAL_TOKEN`,
`CUSTOMER_INTERNAL_TOKEN`, `LEDGER_SERVICE_URL`, `CUSTOMER_SERVICE_URL`, `TOPUP_MIN_PAISE` (100),
`TOPUP_MAX_PAISE` (10000000), `TOPUP_DAILY_LIMIT_PAISE` (20000000), `TOPUP_ORDER_TTL_MINUTES` (30),
`STEP_UP_MAX_AGE_SECONDS` (300), `MFA_FACTOR_MIN_AGE_HOURS` (24).

## 7. Sphere assistant (assistant-service)

### API (gateway prefix `/api/v1/assistant`, permission `assistant:chat`)

| Route | Notes |
|---|---|
| `GET /meta` | `{ provider: 'llm'\|'builtin', model?, suggestions: string[] }` (role-specific suggestions) |
| `GET /conversations` | own, newest 20: `{ id, title, updatedAt }` |
| `POST /conversations` | `{ title? }` → conversation |
| `GET /conversations/:id` | own only: `{ id, title, messages: [{ id, role: 'user'\|'assistant', content, cards, createdAt }] }` |
| `DELETE /conversations/:id` | own only |
| `POST /conversations/:id/messages` | body `{ content }` (1–2000 chars). Response `text/event-stream`: `message.start {messageId}`, `tool.call {name, label}`, `tool.result {name, card}`, `token {text}`, `message.end {messageId}`, `error {code, message}`. With `Accept: application/json` the final message is returned instead. |

Cards (structured UI blocks, never HTML): `accounts {accounts:[{id, label, last4, balancePaise}]}`,
`transactions {accountLabel, items:[{id, at, description, direction, amountPaise}]}`, `spending {days, inPaise,
outPaise, byDay:[{date, inPaise, outPaise}]}`, `payees {items:[{nickname, last4, active}]}`,
`topups {items:[{id, amountPaise, status, at}]}`, `transferDraft {fromAccountId, toPayeeNickname?, amountPaise?,
note?}`, `help {title, steps:[string]}`.

### Behaviour

- Providers: `LLM_API_KEY` set → OpenAI-compatible chat completions with tool calling and streaming
  (`LLM_BASE_URL` default `https://api.openai.com/v1`, `LLM_MODEL` default `gpt-4o-mini`; Groq, OpenRouter and Ollama
  work by changing the base URL). No key → the built-in assistant: an intent router over the same tools with
  templated answers, streamed word by word. Both paths produce the same events and cards.
- Tools are **read-only** and call the owning services **with the customer's own access token** (forwarding the
  client's address), so every authorization check still happens where the data lives. Customers get data tools:
  `list_accounts`, `recent_transactions`, `spending_summary`, `list_payees`, `list_top_ups`, `explain_limits`,
  `draft_transfer` (returns a card only), `search_help`. Staff roles get `search_help` only.
- Guardrails: message length cap; 20 messages per minute and a daily token budget per user (GCRA on the cache
  Redis); tool output is masked (last 4 digits) and treated as data in the prompt; at most 4 tool rounds; 30 s LLM
  timeout; conversations kept 30 days; message bodies never logged.
- Storage `assistant_schema`: `conversations`, `messages` (role, content, cards jsonb, tool names, token counts).

## 8. Real-time (realtime-service)

- `GET /api/v1/realtime/stream` (permission `realtime:subscribe`): SSE. First event `ready {connectionId,
  heartbeatSeconds}`; then `{ id, type, at, data }` events; a comment heartbeat every 20 s; at access-token expiry it
  sends `reauth` and closes (the client reconnects with a fresh token). `Last-Event-ID` replays up to 100 missed
  events for the user from a Redis stream (24 h).
- Channels: `rt:user:<userId>`, and for staff `rt:role:<ROLE>`. At most 5 streams per user (others get 429).
- A Kafka consumer group maps events to channels and publishes to Redis; every replica subscribes only to the channels
  of its own connections (reference counted).

| Kafka event | Real-time event | Recipients |
|---|---|---|
| `transaction.completed.v1` | `transaction.posted {transactionId, type, amountInPaise, accountId, direction}` | source and destination customers |
| `payment.updated.v1` | `payment.updated {topUpId, status, amountInPaise, accountId}` | the customer; role BANK_ADMIN |
| `fraud.alert.created.v1` | `fraud.alert {alertId, severity, accountId}` | roles FRAUD_ANALYST, BANK_ADMIN, SUPPORT |
| `account.status.changed.v1` | `account.status {accountId, status}` | the customer |
| `beneficiary.added.v1` | `payee.added {beneficiaryId, nickname, activatesAt}` | the customer |

Events are hints: the browser refetches the truth from the APIs.

## 9. Account security (auth-service)

- **Sessions**: a `user_sessions` row per refresh-token family: created and last-seen times, first and last IP, user
  agent, device label (`Chrome on Windows`), MFA flag, revoked time and reason. Last-seen updates are throttled to once
  a minute.
- **Security events**: `security_events` (sign-in succeeded or failed, MFA failed, new device, session revoked,
  password changed, IP auto-banned), kept 180 days.
- **New-device sign-in**: not seen in 90 days on the same browser and OS family *and* the same network (/24 IPv4,
  /48 IPv6) → `security.new_device_login.v1` → email.
- **Credential stuffing**: per-IP HyperLogLog of distinct accounts with failed sign-ins in 10 minutes; above
  `CREDENTIAL_STUFFING_THRESHOLD` (20) the IP is banned at the edge for 30 minutes (`edge:ban:<ip-key>` in the edge
  Redis) and a security event is recorded.
- **IP rules**: `ip_rules` table (CIDR, action `DENY`, reason, expiry, created by), mirrored to the edge Redis
  (`edge:ip-rules` hash plus `edge:ip-rules:version`). Refused: rules wider than /8 (IPv4) or /32 (IPv6), rules
  overlapping `STAFF_ALLOWED_CIDRS`, and rules matching the admin's own address.

API additions (gateway prefix `/api/v1/auth`):

| Route | Permission |
|---|---|
| `GET /sessions` → `[{ id, current, deviceLabel, ipMasked, createdAt, lastSeenAt, mfa }]` | `security:sessions:own` |
| `DELETE /sessions/:sessionId` | `security:sessions:own` |
| `POST /sessions/revoke-others` | `security:sessions:own` |
| `GET /security-events?limit` → `[{ id, type, deviceLabel, ipMasked, at, details }]` | `security:sessions:own` |
| `GET /admin/users/:userId/sessions` | `security:sessions:read:any` |
| `DELETE /admin/users/:userId/sessions/:sessionId` | `security:sessions:revoke:any` |
| `GET /admin/security-events?type&userId&limit&cursor` | `security:events:read:any` |
| `GET /admin/ip-rules`, `GET /admin/ip-bans` | `security:ip-rules:read` |
| `POST /admin/ip-rules {cidr, reason, expiresInMinutes?}`, `DELETE /admin/ip-rules/:id`, `DELETE /admin/ip-bans/:ipKey` | `security:ip-rules:write` |

`ipMasked` keeps the network part only (`203.0.113.x`, `2001:db8:1::/48`).

## 10. Gateway

- **Edge identity**: verifies the access token's signature (`JWT_VERIFY_KEYS`) only to key limits by user; services
  still authenticate and authorize every request. Invalid or missing tokens are keyed by client IP.
- **GCRA limits** (env-configurable): per IP 600/min (burst 200); per user 300/min (burst 100); route classes on top:
  `money-write` (transfers, top-up orders, withdrawal codes, adding payees) 30/min burst 10; `assistant` messages
  20/min burst 5; `auth-credential` is left to auth-service; `webhook` per IP 600/min.
- **IP rules and bans**: deny rules compiled into a `net.BlockList`, refreshed when `edge:ip-rules:version` changes
  (checked every 5 s); the ban check is folded into the GCRA script. 403 `IP_BLOCKED`.
- **Load shedding**: at most `GATEWAY_MAX_INFLIGHT` (1024) concurrent requests per replica, excluding streams;
  `GATEWAY_MAX_STREAMS` (5000) streams. 503 `SERVER_BUSY` with `Retry-After: 1`.
- **Circuit breaker per upstream**: 10 s window, opens at ≥ 50 % failures over ≥ 20 requests (connection errors,
  timeouts, 502/503/504), 5 s cooldown, 3 half-open probes. 503 `UPSTREAM_UNAVAILABLE`.
- **Routes**: adds `/api/v1/payments`, `/api/v1/assistant`, `/api/v1/realtime`. Streaming routes (realtime, assistant
  messages) have no idle timeout at the proxy and are never buffered.
- `/metrics` is on the metrics port only.

## 11. Caching

| Service | Key | TTL | Invalidation |
|---|---|---|---|
| transaction | `cache:ledger:acct:<id>` (owner, kind) | 10 min | never changes; deleted on close |
| transaction | `cache:ledger:bal:<id>:v<ver>` | 30 s | `cache:ledger:ver:<id>` bumped after every committed posting that touches the account |
| transaction | `cache:ledger:hist:<id>:v<ver>:<limit>:<offset>` | 60 s | same version key |
| customer | `cache:customer:profile:<userId>` | 5 min | deleted on profile update and KYC decision |
| customer | `cache:customer:kyc:<userId>` | 60 s | deleted on KYC decision |
| account | `cache:account:list:<customerId>` (metadata, not balances) | 5 min | deleted on open, status or limit change |

Authorization runs before any cache read. Version bumps happen after commit, so a reader can never cache a value
older than a committed write under the new version.

## 12. Tamper-evident audit

`audit_log` in transaction-service, auth-service and payment-service gains `seq`, `prev_hash`, `hash`
(`hash = sha256(prev_hash ‖ canonical JSON of the row)`), written under a transaction-scoped advisory lock.
`GET /api/v1/transactions/audit/verify` and `GET /api/v1/auth/admin/audit/verify` (`audit:verify`) re-walk the chain
and report the first broken link. Rows written before the migration are outside the chain (documented).

## 13. Platform

- **PgBouncer** in transaction mode between services and Postgres (`pgbouncer=true` for Prisma; per-role pools; role
  defaults already set `search_path`); migrations connect directly.
- **Kafka**: 12 partitions for domain topics, keyed for ordering per account or customer.
- **Compose overlays**: `docker-compose.scale.yml` (replicas for stateless services), `docker-compose.observability.yml`
  (Prometheus, Grafana with provisioned dashboards, alert rules, exporters for Postgres, Redis and Kafka lag).
- **Kubernetes** (`deploy/k8s`, kustomize): Deployments with probes, resources and hardened security contexts, HPA,
  PDB, default-deny NetworkPolicies mirroring the Compose networks, migration Job, Ingress; managed Postgres, Kafka and
  Redis are referenced, not run in-cluster. Validated with `kustomize build` and `kubeconform`.
- **CI** (`.github/workflows`): backend build and tests, frontend lint, typecheck, tests and build, Docker builds,
  CodeQL, dependency audit, secret scanning, Trivy, manifest validation.
- **Load tests** (`loadtest/k6`): read-heavy browsing, money movement, top-ups, assistant and real-time scenarios with
  thresholds; results and the capacity plan in `docs/operations/`.

## 14. Web app

- **Add money** (`/add-money`, also from the dashboard quick actions and an account's page): account, amount with
  quick chips, today's remaining limit, Razorpay Checkout (live/test, script loaded on demand) or the simulated
  checkout sheet (simulator mode, clearly labelled), processing state driven by real-time events with polling as a
  fallback, receipt, recent top-ups.
- **Sphere**: launcher in the shell (desktop floating button, phone header button), side panel on desktop and a full
  sheet on phones, streaming answers with an `aria-live` region, tool status lines, cards, suggestions, stop, retry,
  history, and the line "Sphere can't move money. Answers can be wrong; check important details."
- **Security**: sessions and devices with sign-out and "sign out everywhere else"; recent sign-in activity.
- **Real-time**: `RealtimeProvider` (fetch-based SSE with the bearer token, reconnect with backoff and
  `Last-Event-ID`, re-auth), `useRealtimeEvent(type, handler)`, `useRealtimeStatus()`; query invalidation and toasts.
- **Operations** (`src/features/ops`): payments console (summary, filters, detail with timeline, refund with step-up),
  security centre (IP rules, bans, security events), sessions panel for a user, live fraud queue.

Contract between web modules: `src/lib/realtime/index.ts` exports
`RealtimeProvider`, `useRealtimeEvent<T>(type: string, handler: (data: T) => void)`, `useRealtimeStatus(): 'connecting'|'open'|'offline'`.
`src/lib/api` exports typed functions for every endpoint in sections 6–9 (ops pages may add their own in
`src/features/ops/api.ts`).

nginx: CSP allows `https://checkout.razorpay.com` (script) and `https://api.razorpay.com` (frame) only when
`RAZORPAY_CHECKOUT=on`; `/api/v1/realtime/` and assistant message streams are proxied unbuffered with long read
timeouts.

## 15. Testing and definition of done

- TDD for all new logic: state machine, signatures, webhook dedupe, reconciler, ledger credit and refund idempotency,
  GCRA, circuit breaker, cache, route policies, SSE framing, assistant intents and tool scoping, real-time fan-out.
- Every service: `npm test`, `tsc` clean; frontend: lint, typecheck, Vitest with coverage thresholds, build.
- API e2e suite extended (top-up via the simulator end to end, webhook replay, refund with step-up, assistant over
  SSE, real-time delivery, sessions, IP rule, credential-stuffing ban).
- Browser journeys extended (add money, Sphere, sessions, payments console, security centre) with screenshots.
- k6 runs recorded with their real numbers.

## 16. Ownership (parallel work)

| Owner | Files |
|---|---|
| Foundation | `backend/packages/common/**` |
| Payments | `backend/services/payment-service/**`, `backend/services/razorpay-simulator/**` |
| Assistant | `backend/services/assistant-service/**` |
| Real-time and notifications | `backend/services/realtime-service/**`, `backend/services/notification-service/**` |
| Edge and identity | `backend/services/api-gateway/**`, `backend/services/auth-service/**` |
| Core banking | `backend/services/{transaction,account,customer,fraud}-service/**` |
| Web (customer and shared) | `frontend/src/**` except `frontend/src/features/ops/**` |
| Web (operations) | `frontend/src/features/ops/**` |
| Platform | `deploy/**`, `.github/**`, `loadtest/**`, `docker/observability/**`, `docker-compose.observability.yml`, `docker-compose.scale.yml`, `docs/operations/**` |
| Integration | Compose files, `backend/docker/**`, `backend/Dockerfile`, `backend/scripts/**`, `frontend/nginx/**`, lockfiles, docs |

Nobody installs dependencies except the integration owner. Nobody edits files they don't own; anything needed
elsewhere goes in their report.
