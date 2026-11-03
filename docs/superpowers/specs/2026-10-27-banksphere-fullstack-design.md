# BankSphere full-stack platform — design

Date: 2026-10-27 · Branch: `feature/fullstack-platform`

## Intent

BankSphere already has a hardened, double-entry banking backend (seven TypeScript microservices behind an API
gateway). It has no user interface. The goal is a production-ready platform for a deployment the next day:

1. Audit the backend for vulnerabilities and fix what is real, with regression tests.
2. Run everything against a real local database and test it end to end.
3. Restructure the repository into `backend/` and `frontend/` on a new branch.
4. Build a frontend that covers every role the backend supports, with the polish of a top-tier SaaS product,
   developed test-first.
5. Ship it all as one Docker Compose stack, with screenshots, user stories and test documentation.

## Goals

- Every backend capability is reachable from the UI by the role that owns it: customer internet banking and
  the staff back office (teller, KYC officer, fraud analyst, support, bank administrator).
- The UI never weakens a backend control. It supports MFA, step-up, four-eyes approvals, blind cash counts,
  idempotency keys, cooling-off periods and anti-enumeration responses rather than working around them.
- Money is exact. Amounts stay integer paise strings end to end; the UI converts them only for display and
  input, without floating-point arithmetic.
- Zero known failing tests: backend unit tests, the backend end-to-end security suite, frontend unit and
  component tests, and browser end-to-end tests against the real stack.

## Non-goals

- Native mobile apps, marketing site, or a CMS.
- Changing the banking rules themselves (limits, approval thresholds, KYC policy) beyond fixing defects.
- Multi-currency (the backend is INR-only by design).

## Anti-goals (failure even if it "works")

- Tokens readable by page scripts for longer than needed (a refresh token in `localStorage`).
- Any client-side shortcut that shows staff the expected cash before a blind count, reveals whether an email
  or account number exists, or lets a request be double-submitted without the same idempotency key.
- A UI that hides backend errors behind generic toasts. Every error code the API returns gets a clear,
  specific message and a next step.

## Architecture

```
browser ──► frontend (nginx :8080) ──/api/*──► api-gateway :8000 ──► services
              │ serves the SPA (immutable hashed assets, strict CSP)
              └ same-origin reverse proxy: no CORS, SameSite=Strict cookies work
```

- **Same origin.** nginx serves the SPA and proxies `/api/` to the gateway. nginx is the client-facing edge,
  so it overwrites `X-Forwarded-For` with the real client address and the gateway runs with `TRUST_PROXY=1`.
  The gateway is not published in the full-stack compose file, so nobody can reach it directly with a forged
  `X-Forwarded-For`.
- **Session transport.** The access token lives only in memory. The refresh token moves to an `HttpOnly`,
  `SameSite=Strict`, path-scoped cookie when the client opts in with `X-Session-Transport: cookie`; in that
  mode the refresh token is never in a response body. Cookie-based refresh and logout also require the custom
  `X-Session-Transport` header, which a cross-site form cannot send. API clients that send the refresh token
  in the body keep working unchanged, including the existing e2e suite.
- **Multi-tab refresh.** Refreshes are serialised across tabs with the Web Locks API (falling back to a
  single in-tab promise), and a `409 REFRESH_IN_PROGRESS` is retried once after a short delay.

## Backend additions the UI needs

These are product gaps, not new banking rules. Each comes with unit tests and, where it touches data, an
integration check in the e2e suite.

| Endpoint | Who | Why |
|---|---|---|
| `GET /api/v1/auth/admin/users?role&q&limit&offset` | BANK_ADMIN | Find staff and customers to disable, re-enable, reset MFA, or issue a float to, without typing UUIDs. |
| `GET /api/v1/customers?kycStatus&q&limit&offset` | KYC_OFFICER, BANK_ADMIN, SUPPORT | KYC review queue and customer search. Staff list views are access-logged. |
| `GET /api/v1/accounts/lookup?accountNumber=` | staff | Tellers find the account they are serving by its number. Logged. |
| `GET /api/v1/transactions/teller/sessions/current` | TELLER | The teller's own session state, **without** expected cash or discrepancy (the count stays blind). |

## Frontend

**Stack:** React 18, TypeScript (strict), Vite, Tailwind CSS with design tokens as CSS variables (light and
dark), Radix UI primitives for accessible dialogs, menus, tabs, tooltips and selects, TanStack Query for
server state, React Hook Form with Zod, React Router, Recharts, lucide-react icons, `qrcode` for local
authenticator QR codes (no third-party QR service). Fonts are self-hosted (`@fontsource-variable/inter`), so
the CSP needs no external origins.

**Testing:** Vitest + Testing Library + MSW for unit and component tests (written before the code they
cover), with coverage thresholds enforced in CI. Playwright drives the real Docker stack for end-to-end user
journeys, reads verification and reset links from Mailpit, computes TOTP codes, and captures the screenshots.

**Design system (from the ui-ux-pro-max skill, "Banking / traditional finance" profile, adapted):**
- Swiss minimalism. A trust-navy ink and a precise blue primary, emerald for credits, rose for debits,
  amber for warnings. No purple gradients and no emoji icons.
- Inter with tabular figures for every amount, a 4 px spacing grid, dense-but-calm data tables, 8–12 px
  radii and subtle elevation.
- WCAG 2.2 AA: 4.5:1 text contrast, visible focus rings, full keyboard support, labelled controls, errors
  next to the field and announced, `prefers-reduced-motion` respected, 44 px touch targets on mobile.
- Responsive from 360 px to wide desktop; the sidebar collapses to a drawer on small screens.

**Information architecture**

- Public: sign in (with the MFA step), register, verify email, resend verification, forgot and reset
  password, staff activation, staff MFA enrolment.
- Customer: dashboard (total balance, accounts, cash-flow chart, recent activity, quick actions), accounts
  (open, details, statement with pagination, freeze, daily limit), transfers (own account or payee, review
  step, step-up when required), payees (add with cooling-off explanation, remove), cash withdrawal codes,
  profile and KYC status, security (password, authenticator setup and removal).
- Teller: session (accept float with a blind count, close with a blind count), deposit and withdrawal with
  account lookup, own cash operations.
- KYC officer: review queue, customer detail with KYC history, approve or reject with optimistic versioning.
- Fraud analyst: alert queue by status, alert detail with rule breakdown and history, triage actions
  (closing high-severity alerts needs a second analyst, surfaced in the UI).
- Support: read-only customer lookup, accounts, balances, cash operations, alerts and notification logs.
- Bank administrator: approvals inbox (four-eyes staff requests), staff and customer directory with
  status and MFA-reset actions, teller sessions (issue float, cancel, blind sign-off), cash-operation
  approvals, account controls (unfreeze, close, daily limit), notification logs.

## Repository layout

```
backend/        everything that exists today (services, packages, docker, scripts, its own compose files)
frontend/       the web app, its Dockerfile and nginx config, unit tests and Playwright tests
docs/           design, user stories, test plan and report, screenshots
docker-compose.yml   full stack: includes backend/docker-compose.yml and adds the frontend
```

## Calls made without the user (autonomous mode)

The user asked for autonomous work and no unnecessary questions, so these are the builder's calls:

- Branch `feature/fullstack-platform` from `feature/production-hardening`, the most recent work.
- React + Vite rather than Next.js: the backend is already the API, and a static SPA behind nginx is the
  simplest thing to secure and deploy.
- Cookie-based refresh tokens (opt-in, backward compatible) instead of `localStorage`.
- The new list and lookup endpoints above, with the same audit logging as the existing staff reads.
- A fresh Docker Compose project name (`banksphere`), so the new stack gets its own volumes and the
  previous local stack's data is left untouched.
