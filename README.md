# BankSphere

A complete digital bank: customer internet banking with Razorpay top-ups, real-time updates and an AI assistant,
and a staff back office (teller, KYC officer, fraud analyst, support, bank administrator), on a hardened,
double-entry, event-driven microservices backend built to scale horizontally.

```
 browser ──TLS (LB)──► web :8080 (nginx: SPA, strict CSP, same-origin /api, unbuffered SSE)
                          │
                          ▼
                   api-gateway ×N ── edge Redis: GCRA limits, IP rules, bans
        verified-identity rate limits · load shedding · circuit breakers · streaming proxy
                          │
  auth · customer · account · ledger · payment · assistant · realtime · notification · fraud
     │          │                              │          │
     │   PgBouncer ─► Postgres (schema per service, owner/app roles, append-only + hash-chained audit)
     │   security Redis (token state, AOF) · cache Redis (per-service ACLs, pub/sub fan-out)
     └── Kafka (SASL/SCRAM, ACLs, transactional outbox, per-consumer retry topics, DLQs)
          Razorpay ◄── payment (egress)        LLM API ◄── assistant (egress, optional)
```

| Folder | What it is |
|---|---|
| [`backend/`](backend/README.md) | Ten TypeScript / Express / Prisma services, the shared platform library, Docker and migration tooling, API e2e suites. |
| [`frontend/`](frontend/README.md) | React + TypeScript web app (Vite, Tailwind, Radix, TanStack Query), unit/component tests (Vitest + MSW) and browser journeys (Playwright). |
| [`deploy/`](deploy/) | Kubernetes manifests (kustomize base + staging/production overlays: HPA, PDB, NetworkPolicies). |
| [`loadtest/`](loadtest/) | k6 scenarios and data seeding. |
| [`docs/`](docs/) | Architecture, decisions, security, operations, testing, user stories, screenshots. |

## What it does

- **Banking core**: accounts, double-entry ledger with continuous reconciliation, transfers with payees and
  cooling-off, branch cash with blind counts and maker-checker, KYC, fraud rules, notifications.
- **Add money with Razorpay** (UPI, cards, net banking): signature verification, server-side payment verification,
  idempotent crediting, webhooks, a reconciler and step-up protected refunds. A Razorpay simulator makes it work
  end to end locally without an account.
- **Sphere, the assistant**: answers questions about the customer's own money with read-only tools; any
  OpenAI-compatible API, or a built-in engine with no external calls. It can never move money.
- **Real-time updates** on every page over Server-Sent Events, scaled through Kafka and Redis.
- **Security**: role and permission checks on every route (proven by tests), staff network restriction, MFA and
  step-up, sessions and devices with remote sign-out, new-device alerts, credential-stuffing bans, IP rules,
  tamper-evident audit.
- **Operability**: Prometheus metrics on every service, Grafana dashboards and alerts, W3C trace context,
  PgBouncer, horizontal-scale and observability Compose overlays, Kubernetes manifests, CI with security scanning,
  k6 load tests and a capacity plan.

## Run it

Prerequisites: Docker with Compose v2.24+ (for `include`), Node ≥ 22 for local development.

```bash
node backend/scripts/setup-dev-env.mjs                               # random secrets for local use
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

- Web app: <http://localhost:8080> · captured emails (Mailpit): <http://localhost:8025>
- Add money uses the Razorpay simulator in development (a clearly labelled test checkout).
- Create the two bootstrap administrators (staff administration is four-eyes), then sign in and enrol their
  authenticators from the app:

```bash
docker compose run --rm -e ADMIN_EMAIL=ops.lead@banksphere.local -e ADMIN_PASSWORD='A-long-Passw0rd' auth-service node dist/scripts/create-admin.js
docker compose run --rm -e ADMIN_EMAIL=ops.second@banksphere.local -e ADMIN_PASSWORD='An0ther-long-Pass' auth-service node dist/scripts/create-admin.js
```

Optional overlays:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.observability.yml up -d   # Prometheus, Grafana, alerts
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d                                     # several replicas per service
```

### Configure Razorpay and the assistant

- **Razorpay**: put your API key pair and webhook secret in `backend/.env` (`RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`), point the Razorpay webhook at
  `https://<your domain>/api/v1/payments/webhooks/razorpay`, and set `RAZORPAY_CHECKOUT=on` for the web container
  so its Content Security Policy admits Razorpay Checkout.
- **Assistant**: leave `LLM_API_KEY` empty for the built-in engine, or set `LLM_API_KEY`, `LLM_BASE_URL` and
  `LLM_MODEL` for OpenAI or any compatible provider (Groq, OpenRouter, a local Ollama).

Production: `docker compose up -d --build` with a real `backend/.env` (see the backend README) behind a
TLS-terminating load balancer (`WEB_TRUSTED_PROXY_CIDR` = its address range), or the Kubernetes manifests in
[`deploy/k8s`](deploy/k8s) with managed Postgres, Kafka and Redis.

## Test it

```bash
cd backend && npm test                      # backend unit tests (every service + the shared library)
cd frontend && npm test                     # frontend unit + component tests (npm run test:coverage for coverage)
cd frontend && npm run e2e                  # browser journeys against the running stack (see frontend/e2e/README.md)
node backend/scripts/e2e.mjs                # API functional + security regression suite (see backend README)
node backend/scripts/e2e-platform.mjs       # payments, real-time, assistant, sessions, IP rules, audit chain
```

Load tests: [`loadtest/README.md`](loadtest/README.md). See [docs/testing/test-plan.md](docs/testing/test-plan.md)
and the latest [test report](docs/testing/test-report.md).

## Documentation

- [Platform design: scale, payments, assistant, real-time, edge](docs/architecture/2026-10-28-platform-scale-design.md)
- [Architecture decisions](docs/architecture/decisions.md)
- [Threat model](docs/security/threat-model.md) and [security audit](docs/security/2026-10-27-security-audit.md)
- [Access matrix](docs/security/access-matrix.md): who may call every route, generated from the code
- [Operations](docs/operations/): capacity plan, SLOs, runbooks, observability, Kubernetes
- [Original design](docs/superpowers/specs/2026-10-27-banksphere-fullstack-design.md)
- [Design system](design-system/banksphere/MASTER.md): tokens, type, grid, components, patterns and what the UI must never do
- [User stories and acceptance criteria](docs/user-stories.md)
- [Screenshots](docs/screenshots/README.md)
- [Frontend conventions](frontend/CONTRIBUTING.md)
