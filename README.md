# BankSphere — Banking Backend (Microservices)

A double-entry banking backend in TypeScript / Express / Prisma / PostgreSQL, with Redis and Kafka.

```
                 ┌──────────────────────────── private network ────────────────────────────┐
 client ──► api-gateway :8000 ──► auth :8001   customer :8002   account :8003 ──internal──► transaction/ledger :8004
            (routing, CORS,          │              │               │   (token-protected)        │ outbox
             rate limit)             │              │               │                            ▼
                                     └──── user.registered / account.* / transaction.completed ──► Kafka ──► notification :8005
                                                                                                        └──► fraud :8006
```

| Service | Owns | Notes |
|---|---|---|
| **api-gateway** | — | The only public entry point. Proxies `/api/v1/*`, never exposes `/internal/*`, strips spoofable headers, per-IP Redis rate limit, CORS allowlist. |
| **auth-service** | `auth_schema` | Argon2id passwords, HS256 JWT access tokens (15 min), rotating refresh tokens with reuse detection. |
| **customer-service** | `customer_schema` | Customer profile (Redis cache-aside), staff KYC review. |
| **account-service** | `account_schema` | Account lifecycle, Luhn-checked 12-digit numbers, daily limits. Synchronously provisions/updates the ledger. |
| **transaction-service** | `ledger_schema` | Double-entry ledger: transfers, withdrawals, teller deposits, idempotency, transactional outbox. |
| **notification-service** | `notification_schema` | Kafka consumer, emails the real account holder (simulated provider), retries + DLQ. |
| **fraud-service** | `fraud_schema` | Amount-threshold and velocity rules, alerts for compliance staff. |

All money is integer **paise** (`"100000"` = ₹1,000.00) sent as strings.

## Running locally

Prerequisites: Node ≥ 20.10, PostgreSQL, Redis. Kafka is optional for local dev.

```bash
npm install
# Each service reads services/<name>/.env — copy the template and fill in the CHANGE_ME values.
# JWT_ACCESS_SECRET and INTERNAL_SERVICE_TOKEN must be identical across services, ≥ 32 chars:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
for s in services/*; do cp $s/.env.example $s/.env; done   # then edit

# Create the database + schemas once
psql -U postgres -c "create database banksphere" && psql -U postgres -d banksphere -f docker/postgres/init-schemas.sql

npm run build        # builds common + generates Prisma clients + compiles every service
npm run db:migrate   # applies each service's migrations
npm test             # unit tests for every service

# Bootstrap the first bank administrator (public sign-up can only create CUSTOMERs)
ADMIN_EMAIL=ops@bank.example ADMIN_PASSWORD='a-long-strong-password' npm run create-admin -w @banksphere/auth-service

# Start each service (separate terminals), e.g.
cd services/auth-service && npm start
```

Without a Kafka broker set `KAFKA_ENABLED=false`. Money movement still works, and outbox events
simply stay `PENDING` until Kafka is available (they are never falsely marked as published).

### End-to-end security regression test

With the full stack running:

```bash
ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/e2e.mjs
```

It exercises the real flows and actively attempts privilege escalation, header spoofing, forged JWTs,
IDOR, theft from other users' accounts, money minting, idempotency double-spend, an overdraft race with
30 concurrent transfers, daily-limit bypass, self-unfreeze and internal-API access.

### Docker

```bash
cp .env.example .env    # replace every CHANGE_ME
docker compose up -d --build
docker compose run --rm auth-service node dist/scripts/create-admin.js   # with ADMIN_EMAIL / ADMIN_PASSWORD set via -e
```

A one-shot `migrate` job applies all migrations before the services start. Only port 8000 (the gateway)
is published; Postgres/Redis/Kafka bind to `127.0.0.1`. Kafka UI is opt-in: `docker compose --profile tools up kafka-ui`.

## API overview (through the gateway)

All endpoints except register/login/refresh/logout need `Authorization: Bearer <accessToken>`.
Money-moving endpoints need an `Idempotency-Key` header (8–128 chars of `[A-Za-z0-9_-]`, a UUID is ideal).

| Method & path | Who |
|---|---|
| `POST /api/v1/auth/register` · `login` · `refresh` · `logout` | public (rate limited) |
| `GET /api/v1/auth/me` | any user |
| `POST /api/v1/auth/admin/users` · `PATCH /api/v1/auth/admin/users/:id/status` | BANK_ADMIN |
| `GET/POST/PATCH /api/v1/customers/me` | owner |
| `GET /api/v1/customers/:userId` · `PATCH /api/v1/customers/:userId/kyc` | staff · BANK_ADMIN |
| `POST/GET /api/v1/accounts` · `GET /api/v1/accounts/:id` | owner (staff may list any via `?customerId=`) |
| `PATCH /api/v1/accounts/:id/status` | customer: freeze only · BANK_ADMIN: unfreeze / close (zero balance) |
| `PATCH /api/v1/accounts/:id/daily-limit` | owner (capped) · BANK_ADMIN |
| `POST /api/v1/transactions/transfer` | owner of source account; destination by `destinationAccountId` or `destinationAccountNumber` |
| `POST /api/v1/transactions/withdraw` | owner |
| `POST /api/v1/transactions/deposit` | BANK_ADMIN (teller) |
| `GET /api/v1/transactions/accounts/:id/balance` · `/history?limit&offset` | owner or staff |
| `GET /api/v1/fraud/alerts` · `PATCH /api/v1/fraud/alerts/:id` · `POST /api/v1/fraud/evaluate` | staff |
| `GET /api/v1/notifications/logs` | staff |

Swagger UI is served by each service at `/docs` outside production (`ENABLE_SWAGGER=true` to force it on).

## Security model

- **Identity comes only from a verified JWT.** Every service verifies the token itself (HS256 pinned,
  issuer + audience checked). Client headers like `x-user-id` / `x-user-role` are ignored and stripped.
- **Roles:** `CUSTOMER` (self-registration), `SUPPORT` (read-only staff), `BANK_ADMIN` (staff with write
  access). Staff accounts can only be created by an admin or by the bootstrap script.
- **Ownership checks** on every account, balance and history read; a non-owner sees `404`, the same as for
  a missing ID, so IDs can't be probed.
- **Ledger invariants** are enforced in the database: row locks taken in a fixed order (no deadlocks),
  `CHECK (balance >= 0)`, positive amounts, and a trigger that makes `ledger_entries` append-only.
- **Idempotency** keys are scoped per user and claimed inside the same DB transaction as the money
  movement. Concurrent duplicates block on the unique index and replay the winner's response.
- **Daily limits** are checked while the source account row is locked (IST calendar day).
- **Service-to-service** ledger calls use `INTERNAL_SERVICE_TOKEN` and are not routed by the gateway.
- **No secrets in the repo.** Services refuse to start without a strong `JWT_ACCESS_SECRET`.

## Changes from the original version

See `git log` on branch `complete-backend-and-security-fixes`. In summary:

**Security fixes**
1. Anyone could self-register as `BANK_ADMIN` (`role` was accepted by `/register`).
2. No authentication anywhere: services trusted client-supplied `x-user-id` / `x-user-role` headers, and
   the gateway they assumed did not exist. Anyone could act as anyone, including as admin.
3. The transaction service had no auth at all: anyone could deposit unlimited money, or withdraw and
   transfer out of any account.
4. Idempotency was check-then-act (two concurrent requests could both spend), keys were global (one user
   could read another's cached response), and a crash left keys stuck in `PROCESSING`.
5. JWT secret was hardcoded as a fallback and committed in `.env.example`, and the verifier didn't pin the algorithm.
6. Refresh-token rotation raced (parallel refreshes both succeeded), and disabled users could keep refreshing.
7. Customers could unfreeze accounts frozen by the bank and set an arbitrary daily limit.
8. Fraud alerts and notification logs (customer emails + bodies) were public.
9. Login timing revealed whether an email was registered; there was no brute-force rate limit.
10. Correlation IDs were reflected unvalidated into logs; health checks leaked DB error text; there was no
    request size limit and no security headers.

**Functional gaps completed**
- Ledger accounts were never created, so no money could ever move. Account freezes never reached the ledger.
- Daily limits were stored but never enforced. Mixed-currency transfers were possible.
- Ledger errors (insufficient funds, frozen account, ...) returned **500**, because the ledger's error
  classes didn't extend the shared `AppError`.
- The "simulated" Kafka publisher marked outbox events `PUBLISHED`, silently losing them.
- Notifications went to a hardcoded `customer@banksphere.com`. They now resolve the real owner from events.
- Added the API gateway, database migrations (including the integrity constraints that were never applied),
  an admin bootstrap, KYC review, alert triage, account limit changes, and Docker images for every service.
- `fraud-service` did not compile. The production build could not start, because the generated Prisma
  client was not part of `dist`.
- About 9,300 `node_modules` files, build output and stale compiled `.js` files were removed from git.

## Known limitations / next steps

- The email provider is simulated (prints to stdout). Plug a real provider into `EmailProvider`.
- Account events (`account.created.v1`, `user.registered.v1`) are published best-effort after commit. The
  ledger is updated synchronously, so this only affects notifications. Move them to an outbox if
  notification delivery must be guaranteed.
- Access tokens stay valid until expiry (15 min) after logout or disable. Add a Redis denylist for instant revocation.
- KYC status is recorded but not yet required to open an account or move money.
- `npm audit` reports issues only in dev tooling (jest, ts-node-dev → `braces`, `sprintf-js`) with no
  upstream fix yet. None of these packages are in the production images.
