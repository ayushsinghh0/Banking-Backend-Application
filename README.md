# BankSphere — Banking Backend (Microservices)

A double-entry banking backend in TypeScript / Express / Prisma / PostgreSQL, with Redis and Kafka.

```
                 ┌───────────────────────────── private network ─────────────────────────────┐
 client ─TLS─► LB ─► api-gateway :8000 ─► auth :8001  customer :8002  account :8003 ─internal─► ledger :8004
                     (routing, CORS,        │  ▲           ▲ internal   │                          │
                      per-IP rate limit)    │  └─ Redis: token versions, jti denylist, lockouts, rate limits
                                            │                           │                          │
                                            └──── transactional outbox ─┴──────────────────────────┘
                                                              │
                                                     Kafka (KRaft) ──► notification :8005 ─SMTP─► customers
                                                                   └─► fraud :8006 ──► alerts
```

| Service | Owns | Responsibilities |
|---|---|---|
| **api-gateway** | — | Only public entry point. Routes `/api/v1/*`, never exposes `/internal/*`, strips spoofable headers, sets the real client IP, per-IP Redis rate limit, CORS allowlist. |
| **auth-service** | `auth_schema` | Registration + email verification, Argon2id passwords, JWT access tokens (15 min) with Redis-backed revocation, rotating refresh tokens with reuse detection, forgot/reset/change password, account lockout, admin user management. |
| **customer-service** | `customer_schema` | Customer profile (Redis cache-aside), staff KYC review, internal KYC lookup. |
| **account-service** | `account_schema` | KYC-gated account opening, Luhn-checked 12-digit numbers, freeze/close, daily limits; synchronously provisions/updates the ledger. |
| **transaction-service** | `ledger_schema` | Double-entry ledger: transfers, withdrawals, teller deposits, idempotency, daily-limit enforcement. |
| **notification-service** | `notification_schema` | Kafka consumer; emails the real account holder over SMTP; retries + DLQ. |
| **fraud-service** | `fraud_schema` | Amount-threshold and velocity rules, alerts and triage for compliance staff. |

All money is integer **paise** (`"100000"` = ₹1,000.00) sent as strings.

## Quick start (local development)

Prerequisites: Node ≥ 22, Docker with Compose v2.

```bash
npm install
node scripts/setup-dev-env.mjs            # creates .env + services/*/.env with random secrets
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis kafka kafka-init mailpit
npm run build                              # common + Prisma clients + every service
npm run db:migrate                         # each service migrates its own schema with its own DB role
npm test                                   # unit tests

# First bank administrator (public sign-up can only create CUSTOMERs)
ADMIN_EMAIL=ops@bank.example ADMIN_PASSWORD='A-long-Passw0rd' npm run create-admin -w @banksphere/auth-service

# Start every service (one terminal each, or a process manager)
cd services/auth-service && npm start      # ...and the other six
```

Emails (verification, password reset, notifications) are captured by **Mailpit**: http://localhost:8025.
Dev Redis is published on port **6380** so it doesn't clash with a locally installed Redis.

### Full stack in Docker

```bash
node scripts/setup-dev-env.mjs
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
docker compose run --rm -e ADMIN_EMAIL=ops@bank.example -e ADMIN_PASSWORD='A-long-Passw0rd' \
  auth-service node dist/scripts/create-admin.js
```

### Tests

```bash
npm test                                                     # unit tests (all services)
ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/e2e.mjs      # end-to-end against the running stack
```

The end-to-end suite drives real flows through the gateway, reads the real emails from Mailpit, waits for
Kafka-driven notifications and fraud alerts, and actively attempts: privilege escalation, header spoofing,
forged JWTs, user enumeration (register / login / forgot-password), brute force, token replay after logout /
password reset / account disable, IDOR, theft from other accounts, money minting, idempotency double-spend,
a 30-way concurrent overdraft race, daily-limit bypass, self-unfreeze, KYC bypass and internal-API access.
It also fails if any request in the run returns a 5xx.

## Production deployment

1. `cp .env.example .env` and replace **every** `CHANGE_ME`. Generate secrets with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (hex is URL-safe for DB URLs).
2. Point `SMTP_*` / `MAIL_FROM` at your mail provider (SES, SendGrid, Postmark, ...). TLS is required by default.
3. Set `APP_BASE_URL` to your frontend; email links go to `/verify-email#token=...` and `/reset-password#token=...`
   (the token is in the URL fragment so it never reaches server logs or `Referer` headers).
4. `docker compose up -d --build`, then create the first admin (see above).
5. Terminate TLS in front of the gateway (load balancer / reverse proxy) and set `GATEWAY_TRUST_PROXY` to the
   number of proxy hops so per-IP rate limits see the real client address.

Production properties of the compose stack:
- Only the gateway publishes a port. Containers run as non-root with a read-only filesystem and `no-new-privileges`.
- Each service connects to Postgres with **its own role that owns only its own schema**.
- Redis requires a password, persists with AOF, and uses `noeviction` so revocation state is never dropped.
- Kafka runs in KRaft mode; topics (and their `.dlq` topics) are created explicitly; auto-creation is off.
- A one-shot `migrate` job applies migrations before services start; services wait for healthy dependencies.
- Graceful shutdown (SIGTERM drains in-flight requests and the outbox relay), request/header timeouts.

### Configuration reference (per service)

| Variable | Used by | Notes |
|---|---|---|
| `JWT_ACCESS_SECRET` | all | ≥ 32 random chars, identical everywhere. Services refuse to start otherwise. |
| `INTERNAL_SERVICE_TOKEN` | all | ≥ 32 random chars; protects `/internal/*` service-to-service routes. |
| `REDIS_URL` | all | Token state store. Auth **fails closed** (503) if Redis is unreachable. |
| `DATABASE_URL` | all but gateway | Service-specific role and `?schema=`. |
| `KAFKA_BROKERS`, `KAFKA_ENABLED` | all but gateway/customer | With Kafka down, events wait in the outbox and are delivered later. |
| `EMAIL_TRANSPORT`, `SMTP_*`, `MAIL_FROM` | auth, notification | `console` transport is refused in production. |
| `APP_BASE_URL` | auth | Frontend base URL for email links. |
| `PASSWORD_RESET_TTL_MINUTES` (30), `EMAIL_VERIFICATION_TTL_HOURS` (24) | auth | One-time token lifetimes. |
| `LOGIN_MAX_FAILURES` (5), `LOGIN_LOCKOUT_SECONDS` (900), `AUTH_EMAILS_PER_HOUR` (3) | auth | Brute-force / mail-bombing controls. |
| `AUTH_RATE_LIMIT_MAX` (30), `AUTH_RECOVERY_RATE_LIMIT_MAX` (10) | auth | Per-IP requests per 15 min. |
| `TRUST_PROXY` | all | Hop count of trusted proxies (`1` behind the gateway). |

## API overview (through the gateway)

Authenticated endpoints need `Authorization: Bearer <accessToken>`. Money-moving endpoints need an
`Idempotency-Key` header (8–128 chars of `[A-Za-z0-9_-]`, a UUID is ideal).

| Method & path | Who |
|---|---|
| `POST /api/v1/auth/register` → 202, verification email | public |
| `POST /api/v1/auth/email/verify` `{token}` · `POST /api/v1/auth/email/resend-verification` `{email}` | public |
| `POST /api/v1/auth/login` · `refresh` · `logout` | public (logout also revokes the presented access token) |
| `POST /api/v1/auth/password/forgot` `{email}` → always 202 | public |
| `POST /api/v1/auth/password/reset` `{token, newPassword}` | public (signs out every session) |
| `POST /api/v1/auth/password/change` `{currentPassword, newPassword}` | any user (returns new tokens) |
| `GET /api/v1/auth/me` | any user |
| `POST /api/v1/auth/admin/users` · `PATCH /api/v1/auth/admin/users/:id/status` | BANK_ADMIN |
| `GET/POST/PATCH /api/v1/customers/me` | owner |
| `GET /api/v1/customers/:userId` · `PATCH /api/v1/customers/:userId/kyc` | staff · BANK_ADMIN |
| `POST /api/v1/accounts` (needs VERIFIED KYC) · `GET /api/v1/accounts` · `GET /api/v1/accounts/:id` | owner (staff may list via `?customerId=`) |
| `PATCH /api/v1/accounts/:id/status` | customer: freeze only · BANK_ADMIN: unfreeze / close (zero balance) |
| `PATCH /api/v1/accounts/:id/daily-limit` | owner (capped) · BANK_ADMIN |
| `POST /api/v1/transactions/transfer` | owner of source; destination by `destinationAccountId` or `destinationAccountNumber` |
| `POST /api/v1/transactions/withdraw` | owner |
| `POST /api/v1/transactions/deposit` | BANK_ADMIN (teller) |
| `GET /api/v1/transactions/accounts/:id/balance` · `/history?limit&offset` | owner or staff |
| `GET /api/v1/fraud/alerts` · `PATCH /api/v1/fraud/alerts/:id` · `POST /api/v1/fraud/evaluate` | staff |
| `GET /api/v1/notifications/logs` | staff |

Errors are JSON: `{ "error": { "code", "message", "correlationId" } }`. `503 SERVICE_BUSY` (with `Retry-After`)
means the request was rolled back because of contention and is safe to retry with the same Idempotency-Key.

Swagger UI is served by each service at `/docs` outside production (`ENABLE_SWAGGER=true` to force it on).

## Security model

- **Identity only from verified JWTs** (HS256 pinned, issuer/audience/expiry checked) — client headers like
  `x-user-id` are ignored and stripped by the gateway.
- **Revocable sessions:** every access token carries a `jti` and the user's token version. Logout denylists the
  `jti`; password change/reset and account disable bump the version, killing every outstanding token at once.
  Redis holds this state; the auth DB is the source of truth and is re-mirrored to Redis at startup.
- **Anti-enumeration:** register, login, forgot-password and resend-verification respond identically for
  known and unknown emails (including timing: Argon2 always runs, emails are sent after the response).
- **Brute force:** per-IP limits on credential endpoints plus per-account lockout (5 failures / 15 min), and
  per-address quotas on outbound auth emails.
- **One-time tokens** (verification, reset) are 256-bit random, stored only as SHA-256, single-use
  (compare-and-set), short-lived, and invalidated when a newer one is issued.
- **Roles:** `CUSTOMER` (self sign-up), `SUPPORT` (read-only staff), `BANK_ADMIN`. Staff accounts are created
  only by an admin or the bootstrap script.
- **Ownership checks** everywhere; a non-owner gets `404`, same as a missing ID.
- **Ledger invariants in the database:** ordered row locks, `CHECK (balance >= 0)`, append-only `ledger_entries`
  trigger, per-user idempotency claimed inside the money-moving transaction, daily limits checked under lock.
- **Least privilege:** one Postgres role per service; internal routes need `INTERNAL_SERVICE_TOKEN` and are
  unreachable through the gateway.
- **Reliable events:** transactional outbox in auth, account and ledger, retried with backoff forever;
  consumers deduplicate by `eventId`, retry, and route poison messages to `<topic>.dlq`.

## Known limitations

- Kafka runs as a single node without SASL/TLS: it must stay on a private network. Use a managed, replicated
  cluster with authentication for real production traffic.
- Postgres/Redis TLS is not configured in the bundled compose file (they are not exposed outside the Docker
  network). Use managed services with TLS in production.
- `npm audit` reports issues only in dev tooling (jest, ts-node-dev); production dependencies report 0.
