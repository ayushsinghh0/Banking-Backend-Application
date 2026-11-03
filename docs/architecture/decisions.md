# Architecture decisions

Short records of the decisions that shape BankSphere, with the alternatives that were rejected and why. Each
record is final until a later record supersedes it.

## ADR-001 Database per service, two roles per schema

**Decision.** One Postgres schema per service, owned by `<svc>_owner` (migrations only) and used at runtime by
`<svc>_app`, which may only read and write rows in its own schema. Append-only tables (ledger entries,
transactions, audit logs, status histories) additionally refuse UPDATE/DELETE by trigger and by revoked privilege.

**Why.** A compromised service can't read another service's data or rewrite history, and schema changes can't
happen from a running service. One physical cluster keeps operations simple at this size; moving a schema to its
own cluster later changes only a connection string.

**Rejected.** A shared schema (no isolation); one cluster per service now (cost without a load reason).

## ADR-002 Transactional outbox for every domain event

**Decision.** Events are written to the service's `outbox_events` table in the same transaction as the change,
then published to Kafka by a relay with leases, fencing tokens and per-aggregate ordering. Consumers deduplicate
on `eventId`; transient failures park on the consumer's own retry topic; poison messages go to `<topic>.dlq`.

**Why.** A bank can't have "money moved but no event" or "event but the money didn't move". Dual writes
(DB then Kafka) lose events on a crash between the two.

**Rejected.** Change data capture (Debezium): an extra moving part for the same guarantee at this size.

## ADR-003 Double-entry ledger as the single source of truth for money

**Decision.** Every movement is a balanced set of entries against accounts of a declared kind (customer
liability, teller cash, vault cash, cash suspense, payment clearing). Balances are a cached sum, reconciled
against the entries by a leased job that alerts on any mismatch. Locks are taken in ascending account id order
under a transaction-scoped advisory lock per customer.

**Why.** Money can only move between accounts, never appear or vanish; the reconciliation proves it continuously.

## ADR-004 Razorpay top-ups: verify, then fetch, then credit once

**Decision.** A top-up credits the ledger only after (1) the Checkout signature verifies in constant time and
(2) the payment fetched from Razorpay's API matches order, amount and currency. Credits are idempotent on the
top-up id (a unique ledger reference), so the browser's confirmation, the webhook and the reconciler can all race
and the customer is credited exactly once. A leased reconciler settles anything the browser and webhook missed.
Refunds are a saga: ledger debit first, Razorpay refund second, compensating credit if Razorpay refuses.

**Why.** A signature proves who signed, not that the money was captured; webhooks can arrive late, twice or
never; browsers close. Each path alone is unreliable, together and idempotent they are not.

**Rejected.** Crediting on the signature alone (a captured-but-refunded or partial payment would still credit);
crediting on the webhook alone (customers wait on Razorpay's delivery).

## ADR-005 GCRA rate limiting at the edge, keyed by verified identity

**Decision.** The gateway verifies the access token's signature (public keys only) to key limits per user, falls
back to the client's IP (/64 for IPv6) for anonymous traffic, and applies route classes (money writes,
assistant messages, webhooks) on top. The Generic Cell Rate Algorithm runs as one Lua call that also checks the
IP ban key, so the edge pays a single Redis round trip per request. Authorization stays in the services.

**Why.** Fixed windows allow double bursts at window edges and limits keyed by an unverified token can be
pointed at a victim. GCRA stores one number per client, refills smoothly and knows the exact Retry-After.

## ADR-006 Server-Sent Events for real-time updates, fanned out through Kafka and Redis

**Decision.** Browsers hold one SSE stream (`fetch` with the bearer token). realtime-service consumes domain
events once per consumer group, publishes them to Redis channels (`rt:user:<id>`, `rt:role:<ROLE>`) and keeps a
short per-user replay stream so a reconnect with `Last-Event-ID` misses nothing. Each replica subscribes only to
the channels of its own connections. Events are hints; the browser refetches the truth.

**Why.** Updates only flow server to client, which is exactly what SSE does over plain HTTP (proxies, HTTP/2,
CSP `connect-src 'self'` all just work). WebSockets would add a second protocol for no gain.

## ADR-007 Writer-owned cache invalidation with versioned keys

**Decision.** Caches live in a separate evictable Redis with one ACL user per service. Readers build keys from a
per-account version; the writer bumps the version after commit. Misses are single-flighted in process and
lock-guarded across replicas; Redis failures bypass the cache.

**Why.** Deleting every derived key on write is error-prone (history pages, balances, snapshots); bumping one
version invalidates them all, and bumping after commit means no reader can cache a value from before the write
under the new version.

## ADR-008 The assistant uses the caller's own token for every tool

**Decision.** Sphere's tools call the owning services' public APIs with the customer's own access token
(forwarding their address), are read-only, and return minimised, masked data that the prompt treats as data,
never instructions. Transfers are drafted as a card that opens the normal transfer screen. Without an LLM key a
deterministic built-in engine answers from the same tools.

**Why.** Prompt injection can at worst make the model say something wrong about data the customer can already
see; it can't reach another customer's data or move money, because the assistant has no privileges of its own.

## ADR-009 PgBouncer in transaction mode

**Decision.** Services connect through PgBouncer (`pgbouncer=true` for Prisma, one pool per runtime role,
`max_db_connections` capping Postgres backends); migrations connect directly.

**Why.** Prisma pools grow with replicas times services while Postgres throughput peaks at a few dozen busy
backends. Transaction mode is safe because nothing depends on session state: locks are transaction-scoped and
each role's `search_path` and timeouts are role defaults.

## ADR-010 Authorization is explicit on every route and proven by tests

**Decision.** Every route carries exactly one policy marker (`requireRoles`, `authorize(permission)`,
`anyAuthenticated(note)`, `publicRoute(reason)`); each service declares its access table in
`src/routes/access.ts` and a test asserts the routers match it. New capabilities authorize by permission from one
role-to-permission table. Ownership checks remain in the services.

**Why.** "We check roles everywhere" is a claim; a failing build when a route is added without a decision is a
guarantee. The tables are the reviewable access matrix.

## ADR-011 Tamper-evident audit

**Decision.** Audit rows carry `prev_hash` and `hash = sha256(prev_hash ‖ canonical row)`, appended under a
transaction-scoped advisory lock. An admin endpoint re-walks the chain.

**Why.** Triggers stop the application from editing audit rows; the chain also exposes edits made with higher
privileges, restores of old backups and deleted rows.
