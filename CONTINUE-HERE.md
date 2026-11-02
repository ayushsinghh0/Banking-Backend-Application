# Continue here: BankSphere platform upgrade (paused 2026-10-28)

Work was paused on request. Nothing was deleted, reverted or committed: every change is in this folder on branch
`feature/scale-payments-assistant` (171 changed or new files). To resume, open the paused session and say
"continue", or give this file to any new session.

## Resume log

### 2026-10-31, checkpoint 7: every live suite green, real sign-ins

- Cold restart of the stack after a laptop shutdown; all 19 containers healthy, images newer than the sources.
- `e2e.mjs` 201/201 (no 5xx), `e2e-platform.mjs` 63/63, browser journeys 14/14, run back to back.
  Admins on this database: `ops.lead@` and `ops.second@banksphere.local` (password: the journey default in
  `frontend/e2e/bootstrap.mjs`; TOTP secrets in both git-ignored state files).
- Fixed: the two harnesses reused one single-use TOTP step (each now reads the other's used steps); a loose
  `Amount` selector; a double focus ring on the Sphere message box. Results in `docs/testing/*-results.txt`,
  report updated.
- Left: k6 load tests (heavy for this 7 GB laptop), then commits (local only, no push).

### 2026-10-31, checkpoint 1: every backend unit suite green

`npx tsc --noEmit -p .` is clean in every package, and `NODE_ENV=test npx jest --runInBand` passes everywhere:
common 50 (+5 Redis-only skipped), account 57, gateway 48, assistant 192, auth 147, customer 40, fraud 41,
notification 89, payment 183, razorpay-simulator 35, realtime 110, transaction 133.

Fixed on resume:
- auth-service tests: audit-chain typing helper; the job-lease lookup matched the wrong lease; the IPv6
  staff-overlap case used a /16 (refused as too wide first); the IPv6 credential-stuffing sprays were off by one.
- customer-service: now on the versioned `CustomerCache` (cache Redis, `CACHE_REDIS_URL`), `createApp(prisma, deps)`,
  `/me` routes carry `anyAuthenticated`; old write-through cache tests removed (covered by `customer-cache.spec.ts`).
- fraud-service: policy test expects the router-wide guard's message for an undeclared route.
- razorpay-simulator: a fully refunded payment refuses further refunds (Razorpay's message); orders test id fixed.

Next: the "Known fixes needed on resume" list below, then the stack and the e2e suites.

### 2026-10-31, checkpoint 6: stack up, API e2e green, platform e2e fixes

- CRLF had crept into 98 changed or new files (it broke three container entrypoints); all of them are back to LF.
- Root stack (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`, run from the REPO ROOT):
  all 20 containers healthy. `kafka-init` takes about 10 min (one JVM per kafka-*.sh call): possible follow-up.
- `backend/scripts/e2e.mjs`: 201 passed, 0 failed, no 5xx (re-run variant: 6 first-run enrolment checks skipped).
- `backend/scripts/e2e-platform.mjs` first run: 55/63. The failures were script bugs: `GET /top-ups/:id` answers
  `data.topUp`; the minimum amount is 422 AMOUNT_TOO_SMALL; an SSE frame's payload is `data.data`; signing in with
  TOTP already counts as a step-up, so the no-step-up refund check now uses a refreshed token (the kit returns
  `refreshToken`). Real gap fixed: the web nginx now answers 404 for `/metrics` (the SPA fallback served index.html).

### 2026-10-31, checkpoint 5: platform overlays and operations docs

- `backend/docker-compose.observability.yml` (the root overlay included a file that didn't exist): Prometheus with
  `alerts.yml`, Grafana with a provisioned 29-panel overview dashboard, exporters for Postgres, the three Redis
  instances and Kafka lag. Exporters use new least-privilege principals created only when their password is set
  (`MONITORING_DB_PASSWORD` pg_monitor role, `REDIS_CACHE_MONITOR_PASSWORD` key-less ACL user,
  `KAFKA_MONITOR_PASSWORD` describe-only SCRAM user); `setup-dev-env.mjs` generates them and `GRAFANA_ADMIN_PASSWORD`.
- `backend/docker-compose.scale.yml` (also missing): 2 replicas (`SCALE_REPLICAS`) of every stateless service.
  All four overlay combinations validate, and the rendered model shows the replicas and exporters.
- Kubernetes PrometheusRule generated from the same alert file (`backend/scripts/prometheus-rule.mjs [--check]`);
  CI now checks it and the access matrix.
- `docs/operations/slos.md` and `docs/operations/runbooks.md` (one section per alert; checked: no alert without one).
- Bug fixed: PgBouncer's `tmpfs: [/tmp:uid=70,gid=70,...]` split on the commas, so the stack could not start.
- Stack: run Compose from the repository ROOT (project `banksphere`, keeps the data); running it from `backend/`
  creates a second project named `backend` with empty volumes.

### 2026-10-31, checkpoint 4: frontend green

- `npm run lint`, `npm run typecheck`, `npm run test:coverage` (904 tests, thresholds met), `npm run build` pass.
- Routes and navigation for `/payments` and `/security-centre` were already wired; a duplicated `/payments`
  route was removed.
- Bug fixed: Sphere reopening on the conversation list left nothing focused (`onOpenAutoFocus` always cancelled
  Radix's default focus); keyboard users now land on its first control.

### 2026-10-31, checkpoint 3: assistant HTTP tests, known fixes

- assistant-service: `tests/http.spec.ts` (SSE framing and storage, JSON mode, owner-only 404s, validation
  before the stream, GCRA message limit with Retry-After, staff tool scoping), `tests/route-policies.spec.ts`,
  `tests/support/memory-store.ts`. 203 tests.
- Gateway limits: names in the dev overlay were already right; production Compose now passes every
  `GATEWAY_RATE_*`/`GATEWAY_BURST_*`/`GATEWAY_MAX_*` through (empty = default), documented in `.env.example`.
- `e2e-platform.mjs`: maps simulate's snake_case Checkout triple to confirm's camelCase body.
- `docs/security/access-matrix.md` regenerated (92 routes, 8 services); `--check` passes.

### 2026-10-31, checkpoint 2: payment-service finished (212 tests)

- New specs: `tests/refund.spec.ts` (refund saga: step-up, refusals, idempotent retry, insufficient funds,
  Razorpay rejection with ledger compensation, pending then webhook, failed then reconciler, outages, lost
  Razorpay answer, CREDIT_BLOCKED refunds), `tests/reconciler-admin.spec.ts` (expiry, authorized/failed orders,
  error isolation, audit, manual run, staff list and IST summary), `tests/route-policies.spec.ts`.
- Bug fixed: two reconciler runs started together on one replica both ran (the job lease is re-entrant for its
  holder); `Reconciler` now claims its run slot synchronously.

## What was asked

Make BankSphere production grade for a very large user base: Redis and Kafka used properly, Razorpay "Add money",
an AI chatbot (OpenAI or a free alternative), IP and security hardening, explicit role checks on every API, a
complex but sound architecture, and a perfect UI on desktop and phones. Work autonomously, in one go.

## Where things stand

- **The contract**: `docs/architecture/2026-10-28-platform-scale-design.md` (every API, event, env var, file owner).
- **Safe**: PR #2 (`feature/fullstack-platform`, the version being deployed) is untouched. This branch stacks on it.
- **Nothing is committed yet.** Commit messages and PRs must not mention any AI tool (no Co-Authored-By).

### Done and verified

| Area | Evidence |
|---|---|
| Shared library `backend/packages/common`: metrics, W3C trace context, Redis cache, circuit breaker, retry, service client, GCRA rate limiter, permissions, route-policy checks, audit hash chain, SSE, raw-body capture | 55 tests pass (`npx jest` in the package; 5 GCRA tests need `REDIS_TEST_URL` and passed against a real Redis in WSL); all 320 existing service tests still passed after it |
| Infrastructure: PgBouncer, cache Redis with per-service ACLs, Kafka topics at 12 partitions + new users, `db-bootstrap` job for new schemas, new services in Compose, Razorpay simulator in the dev overlay, secrets generator, `.env.example` | `docker compose ... config` validates |
| nginx: unbuffered streaming for real-time and the assistant, CSP that admits Razorpay only with `RAZORPAY_CHECKOUT=on` | `nginx -t` passes in both modes |
| Docs: decisions (`docs/architecture/decisions.md`), threat model (`docs/security/threat-model.md`), README | written |
| Tests ready to run: `backend/scripts/e2e-platform.mjs` (new suite), `backend/scripts/lib/e2e-kit.mjs` (shared helpers, `e2e.mjs` now uses it) | syntax-checked only; never run yet |

### Stopped mid-way (code exists, NOT verified: review, finish, run tests)

| Workstream | Files | Last step before the pause |
|---|---|---|
| Payments | `backend/services/payment-service/**` | writing the refund-saga tests |
| Razorpay simulator | `backend/services/razorpay-simulator/**` | not written yet (package skeleton only) |
| Sphere assistant | `backend/services/assistant-service/**` | intent routing fix (how-to questions vs "another user's data"); no `src/app.ts` yet |
| Real-time + notifications | `backend/services/realtime-service/**`, `backend/services/notification-service/**` | starting a local smoke test |
| Gateway + identity | `backend/services/api-gateway/**`, `backend/services/auth-service/**` (sessions, security events, IP rules, audit chain, 2 migrations) | wiring `auth-service/src/app.ts` |
| Core banking | `backend/services/transaction-service/**` (payment credits/refunds API, cache, audit chain, 5 migrations), `backend/services/account-service/**` | account-service route-policy and cache tests; **customer-service and fraud-service not started** |
| Web: customer | `frontend/src/**` (Add money, Razorpay/simulator checkout, Sphere UI, real-time, sessions and sign-in activity) | reviewing dark mode screenshots |
| Web: staff and admin | `frontend/src/features/ops/**`, `features/staff/**`, `features/admin/**` | waiting on the coverage run |
| Platform | `deploy/k8s/**`, `.github/workflows/**`, `loadtest/**`, `docs/operations/kubernetes.md` | partial: no observability overlay, scale overlay, capacity plan, SLOs or runbooks yet |

### Known fixes needed on resume

- `backend/docker-compose.dev.yml` uses `GATEWAY_IP_RATE`/`GATEWAY_IP_BURST`/... but the gateway reads
  `GATEWAY_RATE_IP`, `GATEWAY_BURST_IP`, `GATEWAY_RATE_USER`, `GATEWAY_BURST_USER`, `GATEWAY_RATE_MONEY_WRITE`,
  `GATEWAY_BURST_MONEY_WRITE`, `GATEWAY_RATE_ASSISTANT`, `GATEWAY_BURST_ASSISTANT` (see `api-gateway/src/config.ts`).
- `e2e-platform.mjs` assumes the simulate response field names; align with payment-service once finished.
- Wire the staff/admin pages into `frontend/src/app/routes.tsx` and `navigation.ts` (payments console `/payments`,
  security centre `/security-centre`).
- Write `backend/scripts/access-matrix.mjs` to generate `docs/security/access-matrix.md` from each service's
  `src/routes/access.ts`.
- Metrics use `prom-client` (the renamed `@prometheus-io/client` is too new to trust yet; revisit later).

## How to resume (in order)

1. Read the design doc, then finish each "stopped mid-way" workstream (parallel agents work well; keep the file
   ownership table in section 16 of the design).
2. Per service: `NODE_ENV=test npx jest --runInBand` and `npx tsc --noEmit -p .`; then `npm test` in `backend/`.
   Frontend: `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run build`.
3. Rebuild the stack in WSL: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`
   (Docker runs only inside WSL Ubuntu).
4. Run `backend/scripts/e2e.mjs` (must still pass all 207 checks), then `backend/scripts/e2e-platform.mjs`, then the
   browser journeys (`cd frontend && npm run e2e`) with new screenshots.
5. Run the k6 load tests (`loadtest/README.md`) and record real numbers in the capacity plan.
6. Update `docs/testing/test-report.md`, commit in logical groups, push to the `ayushraj-go` fork, and open the PR
   (base: `main` of `yashgoel31/Banking-Backend-Application`, or stacked after PR #2 merges).
