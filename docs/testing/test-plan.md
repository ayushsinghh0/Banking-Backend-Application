# Test plan

BankSphere is tested at four levels. Each level catches what the one below can't, and every level runs
against the same code that ships.

| Level | Tool | Where | What it proves | How to run |
|---|---|---|---|---|
| Backend unit | Jest + ts-jest, Prisma and Redis doubles | `backend/services/*/tests` | Business rules and security invariants of each service (ledger maths, four-eyes, lockouts, idempotency, Kafka retry/DLQ routing), including race and failure paths | `cd backend && npm test` |
| Frontend unit & component | Vitest 5, Testing Library, MSW 2, jsdom | `frontend/src/**/*.test.ts(x)` | Every page and component behaves correctly for each role, state (loading, empty, error, retry) and API error code; money maths; session handling; route guards | `cd frontend && npm test` (`npm run test:coverage` enforces thresholds) |
| API functional & security | Node script against the live stack | `backend/scripts/e2e.mjs` | 207 checks across real services, Postgres, Redis, Kafka and SMTP (Mailpit). It actively attempts privilege escalation, header spoofing, forged JWTs, enumeration, brute force, token replay, IDOR, money minting, self-approval, blind-count bypass, double-spend and a 30-way overdraft race. Fails on any 5xx. | see below |
| API platform suite | Node script against the live stack | `backend/scripts/e2e-platform.mjs` | The platform upgrade end to end: top-ups through the Razorpay simulator (forged signature refused, exactly-once credit across confirm and webhook, declined payment, daily limit), the payments console and a refund with step-up, the assistant over SSE, real-time delivery of payment and ledger events, sessions and devices, IP deny rules and the credential-stuffing ban, the audit hash chain. Fails on any 5xx. | see below |
| Browser journeys | Playwright (Chromium) against the live stack | `frontend/e2e/journeys` | Real people's journeys end to end through the UI, including emails from Mailpit and authenticator codes; produces the documentation screenshots | see below |
| Load | k6 (in Docker) against the live stack | `loadtest/k6` | What one replica of each tier sustains inside its SLO: browsing, transfers, top-ups, assistant answers and open real-time streams. The numbers feed [the capacity plan](../operations/capacity-plan.md); a number that was not measured is never written down. | [`loadtest/README.md`](../../loadtest/README.md) |

## Principles

- **Test first.** Each backend fix and each frontend page began with a failing test that described the behaviour.
- **Behaviour, not markup.** Frontend tests query by role, label and text, the way people and assistive
  technology find things.
- **No unhandled requests.** MSW fails any test that makes an API call it didn't declare. The API suite fails on
  any 5xx.
- **Real infrastructure where it matters.** Migrations, Kafka ACLs, SMTP, Redis ACLs, cookies and CSP are only
  trusted once they have passed against the Docker stack.
- **Every route says who may call it.** Each service declares its routes and roles in `src/routes/access.ts`;
  its `tests/route-policies.spec.ts` fails when the router disagrees, and `npm run access-matrix:check` (backend)
  fails when [the published matrix](../security/access-matrix.md) is stale.
- **Money is exact.** Amounts are integer paise strings everywhere. The tests include values above
  `Number.MAX_SAFE_INTEGER`.

## Coverage targets

| Area | Target | Enforced by |
|---|---|---|
| Frontend statements / lines | ≥ 85 % | `vite.config.ts` thresholds (CI fails below) |
| Frontend branches / functions | ≥ 75 % / ≥ 80 % | same |
| Backend services | Business logic in `src/services` is unit-tested. Startup and wiring (`app.ts` `main`, Kafka consumers) are covered by the API suite on the real stack. | review + API e2e |

## Running the live-stack suites

```bash
# Fresh stack with Mailpit and relaxed per-IP limits
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# Two bootstrap administrators (enrolment tokens saved for the suites)
cd frontend && node e2e/bootstrap.mjs          # COMPOSE="wsl -d Ubuntu -- docker compose -f docker-compose.yml -f docker-compose.dev.yml" when Docker runs in WSL

# API suite (first run: pass the enrolment tokens printed by bootstrap / create-admin)
cd backend && GATEWAY_URL=http://localhost:8080 TRANSACTION_SERVICE_URL=skip \
  ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN2_EMAIL=... ADMIN2_PASSWORD=... \
  ADMIN_ENROLMENT_TOKEN=... ADMIN2_ENROLMENT_TOKEN=... node scripts/e2e.mjs

# Platform suite (same administrators; needs the dev overlay for the Razorpay simulator)
cd backend && GATEWAY_URL=http://localhost:8080 ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN2_EMAIL=... ADMIN2_PASSWORD=... \n  node scripts/e2e-platform.mjs

# Browser journeys + screenshots
cd frontend && npm run e2e -- --project=journeys
```

## Release gate (run before every deploy)

1. `cd backend && npm run build && npm test`
2. `cd frontend && npm run typecheck && npm run lint && npm run test:coverage && npm run build`
3. `npm audit --omit=dev` in `backend/` and `npm audit` in `frontend/`: 0 vulnerabilities
4. Fresh `docker compose up` on empty volumes: every service healthy, `migrate` exits 0
5. Migrations applied to a copy of production data: exit 0, no invalid indexes, no unvalidated constraints
6. API suite and platform suite: 0 failed, 0 5xx
7. Browser journeys: all passed
8. `cd backend && npm run access-matrix:check`: the published access matrix matches the code
9. k6 smoke profiles pass their thresholds against the fresh stack (`loadtest/README.md`)
