# BankSphere — Banking Backend (Microservices)

A double-entry banking backend in TypeScript / Express / Prisma / PostgreSQL, with Redis and Kafka.

```
                  ┌──────────────────────────── private networks ────────────────────────────┐
 client ─TLS─► LB ─► api-gateway :8000 ─► auth :8001  customer :8002  account :8003 ─internal─► ledger :8004
                     (routing, CORS,        │  ▲           ▲ internal   │                          │
                      rate limit, staff     │  └─ Redis (ACL users): token versions, revoked tokens/sessions
                      network allowlist)    │                           │                          │
                                            └──── transactional outbox ─┴──────────────────────────┘
                                                              │
                                        Kafka (KRaft, SASL/SCRAM + ACLs) ──► notification :8005 ─SMTP─► customers
                                                                         └─► fraud :8006 ──► alerts
```

| Service | Owns | Responsibilities |
|---|---|---|
| **api-gateway** | — | Only public entry point. Routes `/api/v1/*`, never exposes `/internal/*`, strips spoofable headers, per-IP rate limit, CORS allowlist, optional staff-network allowlist, liveness/readiness. |
| **auth-service** | `auth_schema` | Registration + email verification, Argon2id passwords, ES256 access tokens with Redis-backed revocation, rotating refresh tokens with reuse detection, TOTP MFA, forgot/reset/change password, lockouts, four-eyes staff administration. |
| **customer-service** | `customer_schema` | Customer profile (Redis cache-aside), KYC review by KYC officers (versioned), staff access log. |
| **account-service** | `account_schema` | KYC-gated account opening, Luhn-checked 12-digit numbers, freeze/close, daily limits; versioned sync of account controls to the ledger. |
| **transaction-service** | `ledger_schema` | Double-entry ledger: transfers, beneficiaries, teller sessions and cash drawers, customer withdrawal codes, maker-checker, idempotency, limits, reconciliation. |
| **notification-service** | `notification_schema` | Kafka consumer; emails the real account holder over SMTP; retries, delayed-retry topic, DLQ. |
| **fraud-service** | `fraud_schema` | Amount, velocity and cash-structuring rules; alerts with four-eyes closure for fraud analysts. |

All money is integer **paise** (`"100000"` = ₹1,000.00) sent as strings.

## Roles

| Role | Can |
|---|---|
| `CUSTOMER` | Self sign-up. Own profile, accounts, beneficiaries, transfers, withdrawal codes. |
| `TELLER` | Open/close a daily cash session; cash deposits and (code-authorised) withdrawals. |
| `KYC_OFFICER` | Decide KYC. |
| `FRAUD_ANALYST` | Triage fraud alerts (closing HIGH/CRITICAL alerts needs two analysts). |
| `SUPPORT` | Read-only staff views. |
| `BANK_ADMIN` | Approve cash operations and teller sign-offs, account controls, staff administration (four-eyes). |

No single role can both create and approve money or identities: tellers can't approve, administrators can't
handle cash or decide KYC, and every staff identity change needs two administrators.

## Quick start (local development)

Prerequisites: Node ≥ 22, Docker with Compose v2.

```bash
npm install
node scripts/setup-dev-env.mjs            # creates .env + services/*/.env with random secrets
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis redis-ratelimit kafka kafka-init mailpit
npm run build                              # common + Prisma clients + every service
npm run db:migrate                         # each service migrates its own schema with its schema-owner role
npm test                                   # unit tests

# Two bootstrap administrators (staff administration is four-eyes, so two are needed).
# Each run prints a ONE-TIME ENROLMENT_TOKEN required to enrol that administrator's MFA.
ADMIN_EMAIL=ops1@banksphere.local ADMIN_PASSWORD='A-long-Passw0rd' npm run create-admin -w @banksphere/auth-service
ADMIN_EMAIL=ops2@banksphere.local ADMIN_PASSWORD='An0ther-long-Pass' npm run create-admin -w @banksphere/auth-service

# Start every service (one terminal each, or a process manager)
cd services/auth-service && npm start      # ...and the other six
```

Emails (verification, password reset, staff activation, notifications) are captured by **Mailpit**:
http://localhost:8025. Dev Redis is published on **6380** (security store) and **6381** (rate limits) so it
doesn't clash with a locally installed Redis. After pulling changes that add new secrets, run
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
```

The end-to-end suite (150 checks) drives real flows through the gateway, reads real emails from Mailpit,
waits for Kafka-driven notifications and fraud alerts, and actively attempts: privilege escalation, header
spoofing, forged JWTs, user enumeration, brute force, token replay after logout / reset / disable / refresh-token
theft, IDOR, theft from other accounts, money minting, self-approval of staff and cash, withdrawal-code guessing,
idempotency double-spend, a 30-way concurrent overdraft race, payee-control and daily-limit bypass, stale KYC
decisions, single-analyst alert closure and internal-API access. It fails if any request returns a 5xx.

## Production deployment

1. `cp .env.example .env` and replace **every** `CHANGE_ME`. Generate secrets with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (hex is URL-safe in URLs), and the
   ES256 key pair as described in `.env.example`.
2. Point `SMTP_*` / `MAIL_FROM` at your mail provider (SES, SendGrid, Postmark, ...). TLS is required by default.
3. Set `APP_BASE_URL` to your frontend. Email links go to `/verify-email`, `/reset-password`, `/staff/activate`
   and `/mfa/enrol`, always as `#token=...` (in the URL fragment, so it never reaches server logs or `Referer`).
4. Set `STAFF_EMAIL_DOMAIN` (staff must use your corporate domain) and **`STAFF_ALLOWED_CIDRS`** (VPN/office
   ranges allowed to call staff-only APIs).
5. `docker compose up -d --build`, then create two bootstrap administrators (see above) and hand each their
   enrolment token out of band. Every further staff member is requested by one administrator, approved by
   another, and activates their own account from the emailed link (choosing their own password, then MFA).
6. Terminate TLS in front of the gateway. Leave `GATEWAY_TRUST_PROXY` empty unless that proxy overwrites
   `X-Forwarded-For`; then set it to the number of such hops.

Production properties of the compose stack:
- Networks: `edge` (gateway only), `apps` and `backend` (internal, no internet), `egress` (only auth and
  notification, for SMTP). Only the gateway publishes a port.
- Containers run as non-root, read-only filesystem, `no-new-privileges`, all capabilities dropped, memory
  limits; base images pinned by digest.
- Postgres: per service an **owner** role (migrations only) and an **app** role (row DML only) on its own
  schema. App roles cannot alter tables, disable triggers, truncate, or update/delete append-only history
  (ledger entries, transactions, audit logs, KYC events, staff access log, fraud events, admin requests).
- Redis (security store): ACL users per service — only auth-service can write token state; other services
  have read-only access to it. AOF persistence and `noeviction`, so revocation state is never dropped.
  Rate-limit counters live in a separate, evictable Redis.
- Kafka: KRaft, SASL/SCRAM-SHA-512, one user per service with least-privilege ACLs (a service can only
  produce the events it owns); `<topic>.retry` and `<topic>.dlq` topics; auto-creation off.
- A one-shot `migrate` job applies migrations before services start; services wait for healthy dependencies.
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
| `STAFF_ALLOWED_CIDRS` | gateway | Networks allowed to call staff-only APIs (empty = unrestricted). |
| `PASSWORD_RESET_TTL_MINUTES` (30), `EMAIL_VERIFICATION_TTL_HOURS` (24), `SESSION_MAX_DAYS` (30) | auth | Token lifetimes. |
| `LOGIN_MAX_FAILURES` (5), `LOGIN_LOCKOUT_SECONDS` (900), `MFA_MAX_FAILURES_PER_HOUR` (10), `AUTH_EMAILS_PER_HOUR` (3) | auth | Brute-force / mail-bombing controls. |
| `AUTH_RATE_LIMIT_MAX` (30), `AUTH_RECOVERY_RATE_LIMIT_MAX` (10), `GATEWAY_RATE_LIMIT_PER_MINUTE` (300) | auth, gateway | Per-IP limits. |
| `STEP_UP_THRESHOLD_PAISE` (₹1,00,000) | ledger | Transfers at or above need an MFA session. |
| `BENEFICIARY_COOLING_MINUTES` (60), `NEW_BENEFICIARY_LIMIT_PAISE` (₹50,000), `MAX_NEW_BENEFICIARIES_PER_DAY` (10) | ledger | Payee controls. |
| `CASH_SINGLE_APPROVAL_LIMIT_PAISE` (₹2,00,000), `TELLER_DAILY_LIMIT_PAISE` (₹10,00,000), `CASH_APPROVAL_TTL_HOURS` (24) | ledger | Maker-checker thresholds. |
| `CUSTOMER_DAILY_OUTFLOW_LIMIT_PAISE` (₹5,00,000), `WITHDRAWAL_CODE_TTL_MINUTES` (15) | ledger | Outflow controls. |
| `HIGH_AMOUNT_THRESHOLD_PAISE`, `VELOCITY_*`, `STRUCTURING_MAX_OPS` | fraud | Rule tuning. |
| `TRUST_PROXY` | all | Hop count of trusted proxies (`1` behind the gateway). |

## API overview (through the gateway)

Authenticated endpoints need `Authorization: Bearer <accessToken>`. Money-moving endpoints need an
`Idempotency-Key` header (8–128 chars of `[A-Za-z0-9_-]`, a UUID is ideal). Staff need an MFA session.

| Method & path | Who |
|---|---|
| `POST /api/v1/auth/register` → 202, verification email | public |
| `POST /api/v1/auth/email/verify` `{token}` · `POST /api/v1/auth/email/resend-verification` `{email}` | public |
| `POST /api/v1/auth/login` → tokens, or `{mfaRequired, challengeToken}` · `POST /api/v1/auth/login/mfa` `{challengeToken, code}` | public |
| `POST /api/v1/auth/refresh` (409 `REFRESH_IN_PROGRESS` if another tab just refreshed) · `POST /api/v1/auth/logout` | public |
| `POST /api/v1/auth/password/forgot` `{email}` → always 202 · `POST /api/v1/auth/password/reset` `{token, newPassword}` | public |
| `POST /api/v1/auth/password/change` · `GET /api/v1/auth/me` | any user |
| `POST /api/v1/auth/mfa/setup` `{password, enrolmentToken?}` · `/mfa/enable` `{code, enrolmentToken?}` · `/mfa/disable` | any user (staff need the enrolment token; staff can't disable) |
| `POST /api/v1/auth/staff/activate` `{token, password}` | new staff (from the activation email) |
| `POST /api/v1/auth/admin/users` `{email, role}` → 202 request | BANK_ADMIN |
| `PATCH /api/v1/auth/admin/users/:id/status` · `POST /api/v1/auth/admin/users/:id/mfa/reset` | BANK_ADMIN (customers: immediate; staff: 202 request) |
| `GET /api/v1/auth/admin/requests` · `POST .../:id/approve` · `POST .../:id/reject` | BANK_ADMIN (never the requester or the target) |
| `GET/POST/PATCH /api/v1/customers/me` | owner |
| `GET /api/v1/customers/:userId` (logged) · `PATCH /api/v1/customers/:userId/kyc` `{kycStatus, expectedVersion}` | staff · KYC_OFFICER |
| `POST /api/v1/accounts` (needs VERIFIED KYC) · `GET /api/v1/accounts` · `GET /api/v1/accounts/:id` | owner (staff may list via `?customerId=`) |
| `PATCH /api/v1/accounts/:id/status` | customer: freeze only · BANK_ADMIN: unfreeze / close (zero balance) |
| `PATCH /api/v1/accounts/:id/daily-limit` | owner (capped) · BANK_ADMIN |
| `GET/POST /api/v1/transactions/beneficiaries` · `DELETE .../:id` | CUSTOMER |
| `POST /api/v1/transactions/transfer` | CUSTOMER: own accounts, or an active beneficiary |
| `POST /api/v1/transactions/withdrawal-codes` `{accountId, amountInPaise}` → one-time 8-digit code | CUSTOMER (account owner) |
| `POST /api/v1/transactions/teller/sessions/open` `{openingFloatPaise}` · `/close` `{countedCashPaise}` | TELLER |
| `POST /api/v1/transactions/deposit` · `POST /api/v1/transactions/withdraw` (`authorizationCode` required) | TELLER (201 executed, or 202 pending approval) |
| `GET /api/v1/transactions/cash-operations` · `POST .../:id/approve` · `POST .../:id/reject` | BANK_ADMIN (not the requester) |
| `GET /api/v1/transactions/teller/sessions` · `POST .../:id/sign-off` | BANK_ADMIN |
| `GET /api/v1/transactions/accounts/:id/balance` · `/history?limit&offset` | owner or staff (staff reads audited) |
| `GET /api/v1/fraud/alerts` · `PATCH /api/v1/fraud/alerts/:id` · `GET .../:id/history` | FRAUD_ANALYST (reads also BANK_ADMIN, SUPPORT) |
| `GET /api/v1/notifications/logs` | BANK_ADMIN, SUPPORT, FRAUD_ANALYST |

Errors are JSON: `{ "error": { "code", "message", "correlationId" } }`. `503 SERVICE_BUSY` /
`SERVICE_UNAVAILABLE` (with `Retry-After`) means nothing was committed and the request is safe to retry with
the same Idempotency-Key.

Swagger UI is served by each service at `/docs` outside production (`ENABLE_SWAGGER=true` to force it on).

## Security model

- **Identity only from verified JWTs**: ES256 with `kid` (algorithm pinned, issuer/audience/expiry checked);
  client headers like `x-user-id` are ignored and stripped by the gateway.
- **Revocable sessions**: access tokens carry a `jti`, a session id and the user's token version. Logout
  denylists the token and its session; refresh-token reuse (theft) kills the whole session, including access
  tokens already issued; password change/reset, MFA changes and disabling bump the version. Redis mirrors the
  state (the auth DB is the source of truth, re-synced periodically). Sessions have an absolute lifetime.
- **MFA**: TOTP (RFC 6238), single-use codes, attempt-limited challenges, per-user lockout with an email alert.
  Mandatory for staff; staff enrolment needs a one-time enrolment token, so a stolen password can't enrol.
  Transfers ≥ ₹1,00,000 need an MFA session (step-up).
- **Four-eyes administration**: staff creation, staff enable/disable and staff MFA reset are requests that a
  second administrator approves. Administrators never know staff passwords (self-activation by email).
- **Cash controls**: teller sessions with opening float and counted close (discrepancies flagged, supervisor
  sign-off); all cash is double-entry against the teller's drawer; withdrawals need the customer's one-time code
  for the exact amount (brute-force burns all codes); large or over-budget operations need a second person.
- **Payee controls**: transfers only to own accounts or registered beneficiaries; cooling-off without MFA;
  first-day cap per new beneficiary; per-account and per-customer daily outflow limits.
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
  money-moving transaction, versioned account controls (a stale sync can never undo a newer freeze), and a
  periodic zero-sum reconciliation (customer balances = teller drawers) that alerts on any mismatch.
- **Reliable events**: transactional outbox with leases, fencing and per-aggregate ordering; consumers
  deduplicate, retry transient failures via a delayed-retry topic and dead-letter poison messages.

## Known limitations

- The bundled compose runs single-node Postgres, Redis and Kafka without TLS on internal networks. Use managed,
  replicated services with TLS for real production traffic.
- `npm audit` reports issues only in dev tooling (jest, ts-node-dev); production dependencies report 0.
