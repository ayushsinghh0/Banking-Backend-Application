# BankSphere — Banking Backend (Microservices)

A double-entry banking backend in TypeScript / Express / Prisma / PostgreSQL, with Redis and Kafka, plus Razorpay
top-ups, a read-only AI assistant, real-time updates over Server-Sent Events and edge protection at the gateway.

```
                  ┌──────────────────────────── private networks ────────────────────────────┐
 client ─TLS─► LB ─► api-gateway :8000 ─► auth :8001  customer :8002  account :8003 ─internal─► ledger :8004
                     (routing, CORS,        │  ▲           ▲ internal   │                          │
                      rate limit, staff     │  └─ Redis (ACL users): token versions, revoked tokens/sessions
                      network allowlist)    │                           │                          │
                                            └──── transactional outbox ─┴──────────────────────────┘
                                                              │
                                        Kafka (KRaft, SASL/SCRAM + ACLs) ──► notification :8005 ─SMTP─► customers
                                                                         ├─► fraud :8006 ──► alerts
                                                                         └─► realtime :8009 ─SSE─► open pages
           payment :8007 ──► Razorpay (or the dev simulator :8010)      assistant :8008 ──► LLM API (optional)
           services ──► PgBouncer :6432 ──► Postgres        cache Redis (cache:*, rt:*)        metrics :9464 each
```

| Service | Owns | Responsibilities |
|---|---|---|
| **api-gateway** | — | Only public entry point. Routes `/api/v1/*`, never exposes `/internal/*`, strips spoofable headers, GCRA rate limits per IP, per user and per route class, IP deny rules and automatic bans, load shedding, a circuit breaker per upstream, unbuffered streaming for SSE, CORS allowlist, optional staff-network allowlist, liveness/readiness. |
| **auth-service** | `auth_schema` | Registration + email verification, Argon2id passwords, ES256 access tokens with Redis-backed revocation, rotating refresh tokens with reuse detection, TOTP MFA, forgot/reset/change password, lockouts, four-eyes staff administration; sessions and devices with remote sign-out, sign-in history, new-device alerts, credential-stuffing bans, IP deny rules, tamper-evident audit log. |
| **customer-service** | `customer_schema` | Customer profile (read-through cache with writer-owned invalidation), KYC review by KYC officers (versioned), staff access log. |
| **account-service** | `account_schema` | KYC-gated account opening, Luhn-checked 12-digit numbers, freeze/close, daily limits; versioned sync of account controls to the ledger. |
| **transaction-service** | `ledger_schema` | Double-entry ledger: transfers, beneficiaries, branch cash (vault, teller drawers, suspense) with dual-control floats and blind counts, customer withdrawal codes, maker-checker, idempotency, limits, reconciliation; payment clearing (top-up credits and refunds) over a least-privilege internal API; versioned read cache; tamper-evident audit chain. |
| **notification-service** | `notification_schema` | Kafka consumer; emails the real account holder over SMTP (transactions, account changes, withdrawal codes, new payees, top-ups and refunds, new-device sign-ins); retries, its own delayed-retry topics, DLQ. |
| **fraud-service** | `fraud_schema` | Amount, velocity (one open alert per account) and cash-structuring rules (per initiator and per account); alerts with four-eyes closure for fraud analysts. |
| **payment-service** | `payment_schema` | Add money with Razorpay: orders, Checkout signature verification, webhooks (signed, deduplicated), reconciliation with Razorpay, administrator refunds as a compensating saga, all double-entry through the ledger's payment API. |
| **assistant-service** | `assistant_schema` | Sphere: answers questions about the customer's own money with read-only tools called with the customer's own token; streams over SSE; OpenAI-compatible model or a built-in deterministic engine. Never moves money. |
| **realtime-service** | — | Server-Sent Events fan-out of domain events (Kafka → Redis pub/sub → every replica's open streams), replay with `Last-Event-ID`, re-authentication at token expiry. |
| **razorpay-simulator** | — | Development and e2e only: an in-memory Razorpay API that signs payments and delivers webhooks, so top-ups work end to end without a Razorpay account. Never deployed. |

All money is integer **paise** (`"100000"` = ₹1,000.00) sent as strings.

## Roles

| Role | Can |
|---|---|
| `CUSTOMER` | Self sign-up. Own profile, accounts, beneficiaries, transfers, withdrawal codes. |
| `TELLER` | Accept the issued float, cash deposits and (code-authorised) withdrawals, blind closing count. |
| `KYC_OFFICER` | Decide KYC. |
| `FRAUD_ANALYST` | Triage fraud alerts (closing HIGH/CRITICAL alerts needs two analysts). |
| `SUPPORT` | Read-only staff views. |
| `BANK_ADMIN` | Issue floats, blind-count and sign off teller sessions, approve cash operations, account controls, staff administration (four-eyes). |

No single role can both create and approve money or identities: tellers can't approve, administrators can't
handle cash or decide KYC, and every staff identity change needs two administrators.

## Quick start (local development)

Prerequisites: Node ≥ 22, Docker with Compose v2.

```bash
npm install
node scripts/setup-dev-env.mjs            # creates .env + services/*/.env with random secrets
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres pgbouncer redis redis-ratelimit redis-cache kafka kafka-init mailpit razorpay-simulator
npm run build                              # common + Prisma clients + every service
npm run db:migrate                         # each service migrates its own schema with its schema-owner role
npm test                                   # unit tests

# Two bootstrap administrators (staff administration is four-eyes, so two are needed; the script refuses a
# third). Each run prints a ONE-TIME ENROLMENT_TOKEN for that administrator's MFA enrolment
# (set ENROLMENT_TOKEN_FILE=/secure/path to write it to a 0600 file instead of the terminal).
ADMIN_EMAIL=ops1@banksphere.local ADMIN_PASSWORD='A-long-Passw0rd' npm run create-admin -w @banksphere/auth-service
ADMIN_EMAIL=ops2@banksphere.local ADMIN_PASSWORD='An0ther-long-Pass' npm run create-admin -w @banksphere/auth-service

# Start every service (one terminal each, or a process manager)
cd services/auth-service && npm start      # ...and the other nine (payment, assistant and realtime included)
```

Emails (verification, password reset, staff activation, notifications) are captured by **Mailpit**:
http://localhost:8025. Dev Redis is published on **6380** (security store), **6381** (rate limits) and **6382**
(application cache and real-time pub/sub) so it doesn't clash with a locally installed Redis; the Razorpay
simulator listens on **8010** and payment-service's `.env` points at it. After pulling changes that add new secrets, run
`node scripts/setup-dev-env.mjs --services` (keeps `.env`, appends new secrets, rewrites `services/*/.env`).

### Full stack in Docker

```bash
node scripts/setup-dev-env.mjs
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
docker compose run --rm -e ADMIN_EMAIL=ops1@banksphere.local -e ADMIN_PASSWORD='A-long-Passw0rd' \
  auth-service node dist/scripts/create-admin.js        # twice, with different administrators
```

### Tests

```bash
npm test                                     # unit tests (all services)
ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN2_EMAIL=... ADMIN2_PASSWORD=... \
ADMIN_ENROLMENT_TOKEN=... ADMIN2_ENROLMENT_TOKEN=... node scripts/e2e.mjs   # enrolment tokens: first run only
ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN2_EMAIL=... ADMIN2_PASSWORD=... node scripts/e2e-platform.mjs
npm run access-matrix                        # regenerate docs/security/access-matrix.md from src/routes/access.ts
npm run access-matrix:check                  # fails when the published matrix is stale (CI)
```

The end-to-end suite (207 checks) drives real flows through the gateway, reads real emails from Mailpit,
waits for Kafka-driven notifications and fraud alerts, and actively attempts: privilege escalation, header
spoofing, forged JWTs, user enumeration, brute force, token replay after logout / reset / disable / refresh-token
theft, IDOR, theft from other accounts, money minting, self-approval of staff and cash, float and closing-count
manipulation, withdrawal-code guessing, idempotency double-spend, a 30-way concurrent overdraft race, payee
enumeration, payee-control, step-up and daily-limit bypass, stale KYC decisions, single-admin unfreeze/re-enable,
single-analyst alert closure and internal-API access. It fails if any request returns a 5xx.

`scripts/e2e-platform.mjs` covers the platform features on the same stack (dev overlay required for the Razorpay
simulator): a top-up end to end with a forged Checkout signature refused and exactly one ledger credit across the
confirmation and the webhook, a declined payment, the daily limit, the payments console and a refund that needs a
fresh step-up, the assistant over SSE (and that it refuses to act), real-time delivery of payment and ledger events,
sessions and devices, an IP deny rule and the credential-stuffing ban, and the audit hash chain.

Every service also declares who may call each route in `src/routes/access.ts`; its `tests/route-policies.spec.ts`
fails when the router disagrees, and `scripts/access-matrix.mjs` renders the tables into
[`docs/security/access-matrix.md`](../docs/security/access-matrix.md).

## Production deployment

1. `cp .env.example .env` and replace **every** `CHANGE_ME` (anything still containing it is refused: the
   services won't start in production and the Postgres/Redis/Kafka bootstrap won't use it). Generate secrets with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (hex is URL-safe in URLs), and the
   ES256 key pair as described in `.env.example`.
2. Point `SMTP_*` / `MAIL_FROM` at your mail provider (SES, SendGrid, Postmark, ...). TLS is required by default.
3. Set `APP_BASE_URL` to your frontend. Email links go to `/verify-email`, `/reset-password`, `/staff/activate`
   and `/mfa/enrol`, always as `#token=...` (in the URL fragment, so it never reaches server logs or `Referer`).
4. Set `STAFF_EMAIL_DOMAIN` (staff must use your corporate domain), **`STAFF_ALLOWED_CIDRS`** (VPN/office
   ranges staff may sign in and work from) and **`GATEWAY_TRUST_PROXY`** (proxies in front of the gateway that
   overwrite `X-Forwarded-For`; `0` if none). The services refuse to start in production without them.
5. `docker compose up -d --build`, then create two bootstrap administrators (see above) and hand each their
   enrolment token out of band. Every further staff member is requested by one administrator, approved by
   another, and activates their own account from the emailed link (choosing their own password, then MFA).
6. Terminate TLS in front of the gateway.
7. **Razorpay**: set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`, register the webhook
   `https://<domain>/api/v1/payments/webhooks/razorpay` (events `payment.authorized`, `payment.captured`,
   `order.paid`, `payment.failed`, `refund.processed`, `refund.failed`) and, if your edge gives you Razorpay's
   source ranges, `RAZORPAY_WEBHOOK_ALLOWED_CIDRS`. A `rzp_test_` key or a non-HTTPS `RAZORPAY_API_BASE` is
   refused in production unless `RAZORPAY_ALLOW_TEST_KEYS=true` (staging).
8. **Assistant**: leave `LLM_API_KEY` empty for the built-in engine (no customer data leaves the platform), or set
   `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` for OpenAI or any compatible API. The assistant only ever reads,
   with the customer's own token.
9. Scrape `:9464/metrics` on every service (never routed by the gateway) or start the observability overlay
   (`docker-compose.observability.yml`: Prometheus, Grafana, alerts, exporters). SLOs, the capacity plan and the
   runbooks are in [`docs/operations`](../docs/operations).

**Upgrading a stack that used the shared `<topic>.retry` topics:** each consumer now parks retries on its own
`<service>.<topic>.retry` topics (`fraud.…`, `notification.…`) and nothing reads the old shared ones any more
(kafka-init revokes the services' ACLs on them). Before upgrading, check that `fraud-service-group.retry` and
`notification-service-group.retry` have no lag on the old `<topic>.retry` topics; otherwise re-publish the
`payload` of the parked envelopes to their original topic (consumers are idempotent).

Production properties of the compose stack:
- Networks: `edge` (gateway only), `apps` and `backend` (internal, no internet), `egress` (auth and
  notification for SMTP, payment for Razorpay, assistant for the model API). Only the gateway publishes a port.
- Services reach Postgres through **PgBouncer** (transaction pooling, one pool per role); migrations connect
  directly. Domain topics have 12 partitions, keyed by account or customer id, so consumers scale horizontally.
- Three Redis instances with different jobs: the security store (AOF, `noeviction`), the edge Redis (rate limits,
  bans, the IP-rules mirror, login counters) and the cache Redis (`cache:<service>:*`, real-time pub/sub `rt:*`,
  replay streams), each with one ACL user per service confined to its own key prefix.
- Every service serves Prometheus metrics on a separate listener (`METRICS_PORT`, default 9464) that nginx and the
  gateway never route; requests carry W3C `traceparent` end to end.
- Containers run as non-root, read-only filesystem, `no-new-privileges`, all capabilities dropped, memory
  limits; base images pinned by digest.
- Postgres: per service an **owner** role (migrations only) and an **app** role (row DML only) on its own
  schema. App roles cannot alter tables, disable triggers, truncate, or update/delete append-only history
  (ledger entries, transactions, audit logs, KYC events, staff access log, fraud events, admin requests).
- Redis (security store): ACL users per service — only auth-service can write token state; other services
  have read-only access to it. AOF persistence and `noeviction`, so revocation state is never dropped.
  Rate-limit counters live in a separate, evictable Redis.
- Kafka: KRaft, SASL/SCRAM-SHA-512, one user per service with least-privilege ACLs (a service can only
  produce the events it owns); per-consumer `<service>.<topic>.retry` topics that only that service can write
  and read; `<topic>.dlq` topics; auto-creation off.
- A one-shot `migrate` job applies migrations (with retries) before services start; services wait for healthy
  dependencies. The gateway only needs the asynchronous notification and fraud services to be started, so an
  SMTP or consumer problem never takes the public API down.
  Migrations are written for live databases: large indexes are built `CONCURRENTLY`, CHECK constraints are
  added `NOT VALID` and validated separately, new columns are backfilled without table rewrites.
- Periodic full-table jobs (reconciliations) run on one replica at a time via a lease in `job_leases`.
- Liveness `/health/live` and readiness `/health` on every service; graceful shutdown on SIGTERM.

### Configuration reference

| Variable | Used by | Notes |
|---|---|---|
| `JWT_SIGNING_KEY`, `JWT_SIGNING_KEY_ID` | auth | ES256 private key (base64 PKCS#8 PEM) and its key id. |
| `JWT_VERIFY_KEYS` | all | `kid:base64(SPKI PEM)` list; keep the old key listed while rotating. |
| `MFA_ENCRYPTION_KEY` | auth | 64 hex chars; TOTP secrets are AES-256-GCM encrypted. |
| `LEDGER_INTERNAL_TOKEN`, `CUSTOMER_INTERNAL_TOKEN` | account, ledger, customer | Separate tokens per internal API. |
| `REDIS_URL` | all | ACL user URL. Authentication **fails closed** (503) if the token store is unreachable. |
| `RATE_LIMIT_REDIS_URL` | gateway, auth | Rate-limit/lockout counters. Login fails closed without them; the gateway limit fails open. |
| `DATABASE_URL` / `MIGRATION_DATABASE_URL` | all but gateway | App role at runtime; owner role for migrations only. |
| `KAFKA_BROKERS`, `KAFKA_USERNAME`, `KAFKA_PASSWORD` | all but gateway/customer | With Kafka down, events wait in the outbox. |
| `EMAIL_TRANSPORT`, `SMTP_*`, `MAIL_FROM` | auth, notification | `console` transport is refused in production. |
| `APP_BASE_URL` | auth | Frontend base URL for email links. |
| `STAFF_EMAIL_DOMAIN`, `STAFF_ENROLMENT_TTL_HOURS` (24), `ADMIN_REQUEST_TTL_HOURS` (24) | auth | Staff onboarding. |
| `STAFF_ALLOWED_CIDRS` | all | Networks staff may work from: every service refuses staff tokens from elsewhere (by role, on every route), auth refuses staff sign-in after the password check, and the gateway also blocks staff-only paths. Empty = unrestricted; required in production. |
| `AUTH_COOKIE_SECURE` (true) | auth | `false` drops `Secure` from the `bs_rt` session cookie (browsers already accept Secure cookies on http://localhost). |
| `PASSWORD_RESET_TTL_MINUTES` (30), `EMAIL_VERIFICATION_TTL_HOURS` (24), `SESSION_MAX_DAYS` (30) | auth | Token lifetimes. |
| `LOGIN_MAX_FAILURES` (5), `LOGIN_LOCKOUT_SECONDS` (900), `MFA_MAX_FAILURES_PER_HOUR` (10), `AUTH_EMAILS_PER_HOUR` (3) | auth | Brute-force / mail-bombing controls. |
| `AUTH_RATE_LIMIT_MAX` (30), `AUTH_RECOVERY_RATE_LIMIT_MAX` (10) | auth | Per-IP limits on credential and recovery endpoints (fail closed). |
| `GATEWAY_RATE_IP` (600/min), `GATEWAY_BURST_IP` (200), `GATEWAY_RATE_USER` (300/min), `GATEWAY_BURST_USER` (100), `GATEWAY_RATE_MONEY_WRITE` (30/min), `GATEWAY_BURST_MONEY_WRITE` (10), `GATEWAY_RATE_ASSISTANT` (20/min), `GATEWAY_BURST_ASSISTANT` (5), `GATEWAY_RATE_WEBHOOK` (600/min), `GATEWAY_BURST_WEBHOOK` (100) | gateway | GCRA edge limits per IP, per user (token signature verified at the edge) and per route class. `GATEWAY_RATE_LIMIT_PER_MINUTE` is still read as the per-IP rate when `GATEWAY_RATE_IP` is unset. A malformed value stops the gateway. |
| `GATEWAY_MAX_INFLIGHT` (1024), `GATEWAY_MAX_STREAMS` (5000), `GATEWAY_UPSTREAM_TIMEOUT_MS` (15000), `GATEWAY_CONNECT_TIMEOUT_MS` (5000), `GATEWAY_IP_RULES_REFRESH_MS` (5000) | gateway | Load shedding (503 `SERVER_BUSY`, `Retry-After: 1`), upstream timeouts, how often the IP deny rules are refreshed from the edge Redis. |
| `CREDENTIAL_STUFFING_THRESHOLD` (20) | auth | Distinct accounts with failed sign-ins from one IP in 10 minutes before the IP is banned at the edge for 30 minutes. |
| `CACHE_REDIS_URL` | ledger, account, customer, payment, assistant, realtime | Cache Redis (ACL user per service). Unset = caching off (no-op), which is what unit tests and native development use. |
| `METRICS_PORT` (9464) | all | Prometheus metrics listener; unset disables it. |
| `KAFKA_TOPIC_PARTITIONS` (12) | kafka-init | Partitions for domain topics; only ever grows. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_API_BASE` (`https://api.razorpay.com`), `RAZORPAY_WEBHOOK_ALLOWED_CIDRS`, `RAZORPAY_ALLOW_TEST_KEYS` (false) | payment | Razorpay credentials and endpoint. The dev overlay points `RAZORPAY_API_BASE` at the simulator, which makes the service report `mode: simulator` and enable the simulated checkout (never in production). |
| `PAYMENT_LEDGER_INTERNAL_TOKEN` | payment, ledger | Credential of the ledger's payment API (`/internal/v1/payments`): credits, refunds and their reversal only; payment-service cannot open or close accounts. |
| `TOPUP_MIN_PAISE` (100), `TOPUP_MAX_PAISE` (₹1,00,000), `TOPUP_DAILY_LIMIT_PAISE` (₹2,00,000), `TOPUP_ORDER_TTL_MINUTES` (30), `PAYMENT_RECONCILE_INTERVAL_MS` (60000) | payment | Top-up limits (the daily limit counts an IST day) and the reconciler interval (one replica at a time). Refunds also need `STEP_UP_MAX_AGE_SECONDS` / `MFA_FACTOR_MIN_AGE_HOURS`. |
| `LLM_API_KEY`, `LLM_BASE_URL` (`https://api.openai.com/v1`), `LLM_MODEL` (`gpt-4o-mini`), `LLM_TIMEOUT_MS` (30000), `LLM_MAX_OUTPUT_TOKENS` (600), `LLM_TEMPERATURE` (0.2) | assistant | Empty key = built-in assistant. A non-HTTPS base URL is refused in production unless `LLM_ALLOW_HTTP=true` (a model server on a private network). |
| `ASSISTANT_RATE_LIMIT` (20/min), `ASSISTANT_RATE_BURST` (5), `ASSISTANT_DAILY_TOKEN_BUDGET` (50000), `ASSISTANT_RETENTION_DAYS` (30), `ASSISTANT_HISTORY_MESSAGES` (12) | assistant | Per-user guardrails and conversation retention. |
| `REALTIME_MAX_CONNECTIONS` (10000) | realtime | Open streams per replica; each user may hold at most 5. |
| `STEP_UP_THRESHOLD_PAISE` (₹1,00,000), `WITHDRAWAL_CODE_STEP_UP_PAISE` (₹25,000) | ledger | Need recent strong authentication (step-up). |
| `STEP_UP_MAX_AGE_SECONDS` (300), `MFA_FACTOR_MIN_AGE_HOURS` (24) | ledger | Step-up = TOTP verified within this window, on a factor at least this old. |
| `BENEFICIARY_COOLING_MINUTES` (60), `NEW_BENEFICIARY_LIMIT_PAISE` (₹50,000), `MAX_NEW_BENEFICIARIES_PER_DAY` (10) | ledger | Payee controls (the daily cap counts adds, re-adds and failed lookups). Ledger policy numbers must be whole numbers: an empty or invalid value stops the service at startup. |
| `CASH_SINGLE_APPROVAL_LIMIT_PAISE` (₹2,00,000), `TELLER_DAILY_LIMIT_PAISE` (₹10,00,000), `CASH_APPROVAL_TTL_HOURS` (24) | ledger | Maker-checker thresholds. |
| `CUSTOMER_DAILY_OUTFLOW_LIMIT_PAISE` (₹5,00,000), `WITHDRAWAL_CODE_TTL_MINUTES` (15) | ledger | Outflow controls. |
| `HIGH_AMOUNT_THRESHOLD_PAISE`, `VELOCITY_*`, `STRUCTURING_MAX_OPS` | fraud | Rule tuning. |
| `VELOCITY_ALERT_DEDUPE_HOURS` (24) | fraud | While a velocity alert this young is open for an account, further velocity-only hits are recorded but raise no new alert. |
| `KAFKA_TRANSIENT_BUDGET_MS` (15000), `KAFKA_PARTITIONS_CONCURRENCY` (3) | consumers | In-place retry budget before a message moves to the consumer's `<service>.<topic>.retry`; parallel partitions. |
| `SMTP_CIRCUIT_OPEN_MS` (30000) | notification | After an SMTP infrastructure failure, no email is attempted for this long (then one probe). |
| `RECONCILE_INTERVAL_MS` | account, ledger | Reconciliation interval (one replica at a time). |
| `TRUST_PROXY` | all | Hop count of trusted proxies (`1` behind the gateway). |

## API overview (through the gateway)

Authenticated endpoints need `Authorization: Bearer <accessToken>`. Money-moving endpoints need an
`Idempotency-Key` header (8–128 chars of `[A-Za-z0-9_-]`, a UUID is ideal). Staff need an MFA session.

| Method & path | Who |
|---|---|
| `POST /api/v1/auth/register` → 202, verification email (`STAFF_EMAIL_DOMAIN` addresses get the same 202 but no account) | public |
| `POST /api/v1/auth/email/verify` `{token}` · `POST /api/v1/auth/email/resend-verification` `{email}` | public |
| `POST /api/v1/auth/login` → tokens, or `{mfaRequired, challengeToken}` · `POST /api/v1/auth/login/mfa` `{challengeToken, code}` | public |
| `POST /api/v1/auth/refresh` (409 `REFRESH_IN_PROGRESS` if another tab just refreshed) · `POST /api/v1/auth/logout` | public |
| Browsers: send `X-Session-Transport: cookie` and every token-issuing response (login, login/mfa, refresh, mfa/enable, password/change, staff/activate) sets the refresh token as the `bs_rt` cookie (HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth, Max-Age = the refresh token's remaining lifetime) instead of returning it; refresh/logout then read it from the cookie (no session anywhere: 401), and logout or a dead session clears it | public |
| `POST /api/v1/auth/password/forgot` `{email}` → always 202 · `POST /api/v1/auth/password/reset` `{token, newPassword}` | public |
| `POST /api/v1/auth/password/change` · `GET /api/v1/auth/me` | any user |
| `POST /api/v1/auth/mfa/setup` `{password, enrolmentToken?}` · `/mfa/enable` `{code, enrolmentToken?}` · `/mfa/disable` | any user (staff need the enrolment token; staff can't disable) |
| `POST /api/v1/auth/mfa/step-up` `{code}` → fresh access token valid for high-risk actions | MFA session |
| `POST /api/v1/auth/staff/activate` `{token, password}` | new staff (from the activation email) |
| `GET /api/v1/auth/admin/users?role&q&limit&offset` → user directory, newest first (`q`: email contains, or exact id; audited) | BANK_ADMIN, SUPPORT |
| `POST /api/v1/auth/admin/users` `{email, role}` → 202 request | BANK_ADMIN |
| `PATCH /api/v1/auth/admin/users/:id/status` | BANK_ADMIN (customers: immediate, re-enable by a different admin; staff: 202 request) |
| `POST /api/v1/auth/admin/users/:id/mfa/reset` | BANK_ADMIN (always a 202 four-eyes request) |
| `GET /api/v1/auth/admin/requests` · `POST .../:id/approve` · `POST .../:id/reject` | BANK_ADMIN (approve: never the requester or the target; reject: never the target, the requester may withdraw) |
| `GET/POST/PATCH /api/v1/customers/me` (name: letters, marks, spaces, `.'-`; date of birth: age 18–120) | owner |
| `GET /api/v1/customers/:userId` (logged) · `PATCH /api/v1/customers/:userId/kyc` `{kycStatus, expectedVersion}` | staff · KYC_OFFICER |
| `GET /api/v1/customers?kycStatus&q&limit&offset` (logged per profile; `PENDING` = review queue, oldest first) · `GET .../:userId/kyc/history` (logged) | KYC_OFFICER, BANK_ADMIN, SUPPORT |
| `POST /api/v1/accounts` (needs VERIFIED KYC) · `GET /api/v1/accounts` · `GET /api/v1/accounts/:id` | owner (staff may list via `?customerId=`; staff reads logged) |
| `GET /api/v1/accounts/lookup?accountNumber=` → `{id, accountNumber, customerId, accountType, status}` (logged) | staff |
| `PATCH /api/v1/accounts/:id/status` | customer: freeze only · BANK_ADMIN: freeze (on an already-frozen account: a bank hold), unfreeze (not one they froze or held) / close (zero balance) |
| `PATCH /api/v1/accounts/:id/daily-limit` | owner (lower freely; raise up to the customer cap and the bank ceiling) · BANK_ADMIN (sets the bank ceiling, `bankLimitCeilingPaise`) |
| `GET/POST /api/v1/transactions/beneficiaries` · `DELETE .../:id` | CUSTOMER |
| `POST /api/v1/transactions/transfer` | CUSTOMER: own accounts, or an active beneficiary |
| `POST /api/v1/transactions/withdrawal-codes` `{accountId, amountInPaise}` → one-time 8-digit code, emailed notice | CUSTOMER (account owner; step-up from ₹25,000) |
| `POST /api/v1/transactions/teller/sessions` `{tellerId, openingFloatPaise}` · `POST .../:id/cancel` | BANK_ADMIN (issues the float) |
| `GET /api/v1/transactions/teller/sessions/current` (today's session, else the latest unfinished one, else `null`; no counts, no float until accepted) | TELLER |
| `POST /api/v1/transactions/teller/sessions/accept` `{countedFloatPaise}` · `/close` `{countedCashPaise}` (blind; calling `/close` again re-declares the count until sign-off) | TELLER |
| `POST /api/v1/transactions/deposit` · `POST /api/v1/transactions/withdraw` (`authorizationCode` required) | TELLER (201 executed, or 202 pending approval) |
| `GET /api/v1/transactions/cash-operations` | BANK_ADMIN, SUPPORT; TELLER (own requests only) |
| `POST /api/v1/transactions/cash-operations/:id/approve` · `POST .../:id/reject` | BANK_ADMIN (not the requester) |
| `GET /api/v1/transactions/teller/sessions` (counts hidden until RECONCILED; also SUPPORT) · `POST .../:id/sign-off` `{countedCashPaise}` (blind recount) | BANK_ADMIN |
| `GET /api/v1/transactions/accounts/:id/balance` · `/history?limit&offset` | owner or staff (staff reads audited); cash accounts (drawers, vault, suspense): BANK_ADMIN only |
| `GET /api/v1/fraud/alerts` · `PATCH /api/v1/fraud/alerts/:id` · `GET .../:id/history` | FRAUD_ANALYST (reads also BANK_ADMIN, SUPPORT) |
| `GET /api/v1/notifications/logs` | BANK_ADMIN, SUPPORT, FRAUD_ANALYST |
| `GET /api/v1/auth/sessions` · `DELETE .../:sessionId` · `POST .../revoke-others` · `GET /api/v1/auth/security-events?limit` | any user (own sessions and history only) |
| `GET /api/v1/auth/admin/users/:userId/sessions` (also SUPPORT) · `DELETE .../:sessionId` · `GET /api/v1/auth/admin/security-events?type&userId&limit&cursor` (also SUPPORT, FRAUD_ANALYST) | BANK_ADMIN (audited) |
| `GET /api/v1/auth/admin/ip-rules` · `GET .../ip-bans` (also SUPPORT) · `POST .../ip-rules` `{cidr, reason, expiresInMinutes?}` · `DELETE .../ip-rules/:id` · `DELETE .../ip-bans/:ipKey` | BANK_ADMIN (rules wider than /8 or /32, overlapping `STAFF_ALLOWED_CIDRS` or matching your own address are refused) |
| `GET /api/v1/auth/admin/audit/verify` · `GET /api/v1/transactions/audit/verify` → the first broken link of the hash chain, if any | BANK_ADMIN |
| `GET /api/v1/payments/config` → mode (`live`/`test`/`simulator`), key id, today's remaining limit · `POST /api/v1/payments/top-ups` `{accountId, amountPaise}` → 201 top-up + Checkout parameters · `POST .../:id/confirm` `{razorpayPaymentId, razorpayOrderId, razorpaySignature}` · `POST .../:id/cancel` · `GET /api/v1/payments/top-ups?limit&cursor` · `GET .../:id` | CUSTOMER (own KYC-verified account; `Idempotency-Key` required to create) |
| `POST /api/v1/payments/top-ups/:id/simulate` `{outcome, method}` | CUSTOMER, simulator mode only (404 otherwise) |
| `POST /api/v1/payments/webhooks/razorpay` (`X-Razorpay-Signature`, `X-Razorpay-Event-Id`) | Razorpay |
| `GET /api/v1/payments/admin/top-ups?status&customerId&from&to&limit&cursor` · `GET .../summary` | BANK_ADMIN, SUPPORT, FRAUD_ANALYST |
| `POST /api/v1/payments/admin/top-ups/:id/refund` `{reason}` · `POST /api/v1/payments/admin/reconcile` | BANK_ADMIN (refund needs a fresh step-up) |
| `GET /api/v1/assistant/meta` · `GET/POST /api/v1/assistant/conversations` · `GET/DELETE .../:id` · `POST .../:id/messages` `{content}` → `text/event-stream` (`message.start`, `tool.call`, `tool.result`, `token`, `message.end`, `error`), or JSON with `Accept: application/json` | any user (own conversations; customers get data tools, staff only help search) |
| `GET /api/v1/realtime/stream` → `text/event-stream` (`ready`, then `transaction.posted`, `payment.updated`, `fraud.alert`, `account.status`, `payee.added`; `reauth` at token expiry; `Last-Event-ID` replays 24 h) | any user (own channel; staff also their role channel; 5 streams per user) |

Errors are JSON: `{ "error": { "code", "message", "correlationId" } }`. `503 SERVICE_BUSY` /
`SERVICE_UNAVAILABLE` (with `Retry-After`) means nothing was committed and the request is safe to retry with
the same Idempotency-Key. On authenticated endpoints `401` only ever means the access token is missing, invalid,
expired or revoked: a wrong password or code in the body (password change, MFA setup/disable, step-up) is
`403 INVALID_PASSWORD` or `400 INVALID_MFA_CODE`, so clients don't mistake a typo for an expired session.

Swagger UI is served by each service at `/docs` outside production (`ENABLE_SWAGGER=true` to force it on).

## Security model

- **Identity only from verified JWTs**: ES256 with `kid` (algorithm pinned, issuer/audience/expiry checked);
  client headers like `x-user-id` are ignored and stripped by the gateway.
- **Staff network**: with `STAFF_ALLOWED_CIDRS` set, staff tokens only work from those networks on every route
  of every service (decided by role, since staff actions share paths with customer routes) and staff can only sign
  in from them; the gateway's path allowlist is a second layer.
- **Revocable sessions**: access tokens carry a `jti`, a session id and the user's token version. Logout
  denylists the token and its session; refresh-token reuse (theft) kills the whole session, including access
  tokens already issued; password change/reset, MFA changes and disabling bump the version. Redis mirrors the
  state (the auth DB is the source of truth, re-synced periodically). Sessions have an absolute lifetime.
- **MFA**: TOTP (RFC 6238), single-use codes, attempt-limited challenges bound to the password-time token
  version, per-user lockout with an email alert. Mandatory for staff; staff enrolment needs a one-time enrolment
  token. Removing anyone's MFA is four-eyes.
- **Step-up**: transfers ≥ ₹1,00,000, large withdrawal codes and instantly-active payees need a TOTP code verified
  in the last 5 minutes on a factor enrolled at least 24 hours ago, so neither a stolen long-lived session nor a
  factor an attacker just enrolled with a phished password is enough.
- **Four-eyes administration**: staff creation, staff enable/disable and staff MFA reset are requests that a
  second administrator approves. Administrators never know staff passwords (self-activation by email).
- **Cash controls**: a cash general ledger (vault, teller drawers, suspense). A supervisor issues each float and
  the teller must count the same amount before it is booked vault → drawer; at close the teller and then the
  supervisor count blind (the teller never sees the expected figure), the counts must agree, the cash returns to
  the vault and any difference is posted to suspense and alerted. Until sign-off the teller may re-declare their
  count; a disagreeing supervisor count is recorded, and the same blind count from a second, different
  administrator settles the session on the supervisors' count (alert `TELLER_DECLARATION_DISPUTED`). Mismatched
  counts are always audited. Every cash movement is therefore in the ledger
  and fake deposits surface as a shortage. Withdrawals need the customer's one-time code for the exact amount
  (emailed notice; brute force burns all codes); large or over-budget operations need a second person; a
  cumulative structuring rule flags split cash operations, per teller and per account (splitting across tellers
  doesn't hide them). Only fraud analysts triage alerts; administrators can read but not close them.
- **Dual control on account and user status**: an account frozen by a staff member (or held by one after its
  owner froze it), or a user disabled by an administrator, can only be reinstated by a different administrator.
  A daily limit set by an administrator is a ceiling the owner can lower but not raise past.
- **Payee controls**: transfers only to own accounts or registered beneficiaries; cooling-off unless added with a fresh step-up;
  first-day cap per new beneficiary (trailing 24 hours, so removing and re-adding a payee doesn't reset it); add attempts
  capped per day, failed lookups included; every add is announced (`beneficiary.added.v1`); per-account and per-customer
  daily outflow limits.
- **Anti-enumeration**: register, login, forgot-password and resend-verification respond identically for
  known and unknown emails (Argon2 always runs; emails are sent after the response); the ledger checks the
  caller's own account before anything about the destination, and every unusable destination looks the same.
- **Brute force**: per-IP limits, per-account/network lockout with step-up to password reset when attacked
  from many networks, per-address email quotas.
- **One-time tokens** (verification, reset, activation, enrolment) are 256-bit random, stored as SHA-256,
  single-use (compare-and-set), short-lived, and invalidated by newer ones.
- **Ownership checks** everywhere; a non-owner gets `404`, same as a missing ID. Staff reads of customer data
  are logged in append-only tables.
- **Ledger invariants in the database**: ordered row locks, CHECK constraints (non-negative customer balances,
  positive amounts, balance cap), append-only entries/transactions/audit, per-user idempotency claimed inside the
  money-moving transaction, versioned account controls (each change reserves a unique version; a rejected or
  stale push never counts as success, and the ledger is never loosened automatically), and a periodic zero-sum
  reconciliation on one consistent snapshot (customer balances = cash accounts) that alerts on any mismatch.
- **Reliable events**: transactional outbox with leases, fencing and per-aggregate ordering (an unavailable
  broker only delays events; only messages the broker can never accept are parked, with an alert and a re-drive);
  consumers deduplicate, park transient failures on their own delayed-retry topic served by a separate consumer
  group (a circuit breaker stops a dead dependency from stalling fresh events; retry envelopes are validated and
  never trusted for routing), and dead-letter poison messages. Infrastructure failures (database, SMTP
  connection/DNS/TLS/auth) are always retried, never dead-lettered. Each email is claimed before it is sent, so
  retries and redeliveries never send it twice; error text in logs, retry envelopes and DLQs has email
  addresses redacted.
- **Payee enumeration**: without a registered beneficiary every third-party account number gets the same answer.
- **Edge protection**: GCRA rate limits (per IP, per verified user, per route class) in one Redis round trip,
  IP deny rules and automatic bans (403 `IP_BLOCKED`), load shedding when a replica is full (503 `SERVER_BUSY`),
  and a circuit breaker per upstream (503 `UPSTREAM_UNAVAILABLE`), so one slow service never takes the API down.
- **Sessions and devices**: every refresh-token family is a visible session (device, approximate network, last
  seen) the user can end, one at a time or all others at once; sign-ins from an unseen device and network are
  emailed; credential stuffing (many accounts from one address) bans the address at the edge; sign-in history is
  kept 180 days.
- **Payments**: Razorpay never touches the ledger directly. A top-up is credited only after the Checkout signature
  (HMAC over our order id and the payment id) is verified in constant time **and** the payment is fetched from
  Razorpay and matches order, amount, currency and status. Webhooks are verified over the raw body, deduplicated
  by event id and can only ever move a top-up forward in a closed state table. Credits and refunds are idempotent
  in the ledger; a refund Razorpay refuses is compensated. The clearing account is reconciled with everything else.
- **Assistant**: tools are read-only and call the owning services with the customer's own access token (so every
  authorization check still happens where the data lives), staff get help search only, tool output is masked and
  treated as data, rates and daily token budgets are enforced per user, conversations are scoped to their owner and
  purged after the retention period, and message bodies are never logged. It drafts transfers; it never submits them.
- **Caching**: authorization runs before any cache read, every cache key is owned by the service that writes the
  data, and versions are bumped after commit, so a reader can never cache a value older than a committed write.
- **Tamper-evident audit**: the audit logs of the ledger, auth and payments are hash chains
  (`hash = sha256(prev_hash ‖ canonical row)`) written under a lock; `audit/verify` re-walks them and reports the
  first broken link.

## Known limitations

- Staff and customer identities are separate accounts. A staff member who is also a customer under another
  email is not automatically linked; linking requires a national identifier (PAN/Aadhaar) in KYC, after which
  staff operations on linked accounts should be blocked.
- A single KYC officer can verify a customer, and a single administrator can raise a daily limit above the
  customer cap (outflow stays bounded by the per-customer daily limit). Add maker-checker there if your risk
  policy requires it.
- Alerting: Prometheus metrics on every service and the alert rules of the observability overlay cover
  saturation, errors and the payment reconciler; business anomalies are still structured log lines
  (`alert: ...` keys) to wire into your log pipeline.
- Audit rows written before the hash-chain migration sit outside the chain; `audit/verify` starts at the first
  chained row.
- Payouts (NEFT/IMPS/UPI out) are not implemented; Razorpay is used for top-ups and refunds only.

- The bundled compose runs single-node Postgres, Redis and Kafka without TLS on internal networks. Use managed,
  replicated services with TLS for real production traffic.
- `npm audit` reports issues only in dev tooling (jest, ts-node-dev); production dependencies report 0.
