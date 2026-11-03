# Test report — 31 October 2026 (platform upgrade)

Branch `feature/scale-payments-assistant`: payments with Razorpay (simulator in dev), the Sphere assistant,
real-time updates, sessions and security events, PgBouncer, cache Redis, scale and observability overlays.
Same environment as below; the full stack (19 containers, dev overlay) was restarted cold and run against the
existing local database with real sign-ins (email verification through Mailpit, authenticator codes).

| Suite | Result | Notes |
|---|---|---|
| Backend unit (Jest, 12 packages) and `tsc` | **passed** | Per package counts in `CONTINUE-HERE.md`, checkpoint 1 to 3 |
| Frontend lint, typecheck, Vitest with coverage, build | **passed** | 904 tests at checkpoint 4; lint, typecheck and the Sphere suites re-run after the last fix |
| API functional + security suite (`backend/scripts/e2e.mjs`) | **201 / 201 passed**, no 5xx | [Results](api-e2e-results.txt) |
| Platform suite (`backend/scripts/e2e-platform.mjs`) | **63 / 63 passed** | Top-ups, webhooks, refunds, reconciler, Sphere, SSE, sessions, metrics exposure. [Results](platform-e2e-results.txt) |
| Browser journeys (Playwright) | **14 / 14 passed** in 1.9 min | Now including Add money through the test checkout, Sphere, sessions, payments console and security centre. [Results](browser-journeys-results.txt) |

All three live suites pass when run back to back against the same administrators.

Defects found on 31 October and fixed:

| Found by | Defect | Fix |
|---|---|---|
| Browser journeys | Run straight after the API suites, the administrators' sign-in failed: both harnesses picked the same single-use authenticator step (the server correctly refused the replay) | Each harness also honours the other's used steps |
| Browser journeys | `getByLabel('Amount')` also matched the "Quick amounts" group on Add money | Exact label match |
| Screenshot review | The Sphere message box drew two focus rings (the global `:focus-visible` ring inside the field's own ring) | The textarea opts out, like the money input |
| Platform suite | The web origin served the SPA's `index.html` for `/metrics` | nginx answers 404 |

Not yet done on this branch: k6 load tests (`loadtest/`), so the capacity plan has no measured numbers.

---

# Test report — 27 October 2026

Branch `feature/fullstack-platform`. Environment: Windows 11; Docker 29.1.3 and Compose 2.40 in WSL2
(Ubuntu 24.04); Node 24.14; Chromium through Playwright 1.64.1.

**Result: every suite passes. No known failing test, no 5xx in the API suite, no `npm audit` findings.**

## Summary

| Suite | Result | Notes |
|---|---|---|
| Backend unit (Jest) | **320 / 320 passed** | Up from 141. Each security fix began with a failing test. |
| Backend build (`tsc`, all workspaces) | **passed** | |
| Frontend unit + component (Vitest) | **623 / 623 passed** in 39 files | Stable across repeated runs, including with the Docker stack running. |
| Frontend coverage | **91.6 % statements · 83.6 % branches · 92.0 % functions · 93.0 % lines** | Thresholds 85/75/80/85 are enforced. |
| Frontend typecheck, lint, production build | **passed** | Strict TypeScript, typescript-eslint, jsx-a11y |
| API functional + security suite (`backend/scripts/e2e.mjs`) | **207 / 207 passed** (first run), **201 / 201** (re-run after the zod upgrade) | Through the web origin on the full stack. The re-run skips the 6 first-run-only enrolment checks. No request returned a 5xx. [Results](api-e2e-results.txt) |
| Browser journeys (Playwright) | **13 / 13 passed** in 1.5 min | Real stack, real emails (Mailpit), real authenticator codes, on the redesigned interface. [Results](browser-journeys-results.txt) |
| Design review (every route, 390 px and 1440 px, light and dark) | **passed** | Each screen reviewed against the [design system](../../design-system/banksphere/MASTER.md); no page scrolls sideways at 390 px for any role (measured in the browser). 45 [screenshots](../screenshots/README.md), 13 of them on a phone. |
| Fresh `docker compose up` on empty volumes | **passed** | 15 services healthy; `migrate` exit 0 on the first attempt |
| Upgrade migrations on a copy of an existing database | **passed** | 16 new migrations applied over 250 ledger rows and 75 users; 0 invalid indexes, 0 unvalidated constraints |
| `npm audit` | **0 vulnerabilities** | Frontend (all dependencies) and backend (`--omit=dev`, after zod 4.6.7 and body-parser 1.20.9) |

## Backend unit tests by service

Coverage of each service's own `src/`. Startup wiring (`main()`, Kafka consumer set-up) is exercised by the API
suite on the real stack rather than by unit tests.

| Service | Tests | Statements | Branches | Lines |
|---|---|---|---|---|
| api-gateway | 11 | 75 % | 41 % | 77 % |
| auth-service | 89 | 74 % | 61 % | 76 % |
| customer-service | 29 | 81 % | 67 % | 82 % |
| account-service | 47 | 75 % | 67 % | 75 % |
| transaction-service | 62 | 70 % | 73 % | 73 % |
| notification-service | 50 | 57 % | 55 % | 58 % |
| fraud-service | 32 | 70 % | 62 % | 70 % |

## What the browser journeys cover

One serial "day at the bank", each person in their own browser context (own cookie session):

1. Two administrators sign in with authenticator codes.
2. Four-eyes onboarding: one administrator requests a teller, a KYC officer and a fraud analyst; the other
   approves. Each new staff member activates from the emailed link, chooses their own password and enrols an
   authenticator before reaching their workspace.
3. A customer registers, verifies their email from the real message, signs in and completes their profile.
4. The KYC officer finds them in the queue and verifies their identity on the reviewed profile version.
5. The customer opens a savings and a current account.
6. A supervisor issues a float. The teller counts it blind (the issued amount is never shown) and takes a
   ₹25,000 deposit after an account look-up.
7. The customer transfers between their own accounts (review, then receipt). Adding an unusable payee gets the
   generic answer.
8. The customer creates a one-time withdrawal code; the teller pays out ₹1,000 with it.
9. A ₹2,50,000 deposit is sent for approval. The supervisor approves it, and the fraud analyst opens the alert it
   raised and starts a review.
10. Close-out: the teller declares the drawer blind and the supervisor counts independently and signs off
    (RECONCILED).
11. Security: a mistyped current password keeps the session. The customer sets up an authenticator. A reload
    restores the session from the HttpOnly cookie. Sign-out, then sign-in with a code.
12. Documentation screenshots in light, dark and on a 390 px phone ([gallery](../screenshots/README.md)).

## Defects found by testing and fixed

| Found by | Defect | Fix |
|---|---|---|
| Frontend test-first work | Wrong passwords on authenticated endpoints returned 401, which signs browsers out | Backend returns 403 `INVALID_PASSWORD` (S-04) |
| Merge integration | `npm test` hung after notification-service (pino-pretty worker under fake timers) | Tests log plain JSON (S-38) |
| Live stack | The web container never listened: nginx couldn't render its config into a root-owned tmpfs | tmpfs owned by the nginx user (S-39) |
| Live stack | WSL shut its VM down between commands, restarting containers mid-test | Kept a WSL session open during testing (environment only) |
| Live stack | Leftover containers from the previous local project restarted on their own (`restart: always`) | Restart policy set to `no` on those containers; their volumes kept |
| Screenshot review | The brand mark disappeared on mobile (duplicate SVG gradient id); avatar initials took digits | Per-instance id; letters-only initials (S-40) |
| Load testing of the suite | Vitest over-subscribed the CPU while the stack ran, causing timeouts | Half the cores, wider async budgets; the suite also got faster (≈50 s) |
| `npm audit` | High-severity advisories in zod 3 and body-parser | zod 4.6.7, body-parser 1.20.9; all suites re-run green |
| Design review | The interface read as a generic template: tinted icon tiles, uppercase labels, red for ordinary spending, a hamburger menu on phones | Redesigned on a documented design system: Apple/Google-grade tiles, ink primary actions, tab bar and bottom sheets on phones, true-black dark mode |
| Phone layout measurement | On the 390 px overview, single-column grids grew to fit truncated text and pushed tiles past the screen edge | Every responsive grid has an explicit `minmax(0, 1fr)` track; the shell clips any stray overflow |
| Screenshot review | Approvals said a request was made "in 4 seconds" when the browser clock ran behind the server's | Past events use a clock-skew-safe "just now" (unit tested) |
| Screenshot review | The chevron of every native select never rendered | Moved from an arbitrary Tailwind class to a plain CSS class |
| Accessibility check (unit test) | Two phone tab labels ("Notifications", "Customers") were not part of their links' accessible names | Labels renamed; a test now enforces that every short label is contained in its full name |

## Not covered (and why)

- **Browsers other than Chromium.** The UI uses standard platform features (Web Locks with a fallback,
  BroadcastChannel, CSS variables). Run the journeys with `--project` set to Firefox or WebKit before a wider
  rollout.
- **Real SMTP over TLS.** Mailpit is plaintext. Production requires STARTTLS by default (`SMTP_REQUIRE_TLS=true`).
- **Load and soak testing.** Concurrency is covered by the 30-way overdraft race and the 10-way idempotency test;
  throughput under sustained load was not measured.
- **TLS termination and a load balancer in front of the web container.** Configure `WEB_TRUSTED_PROXY_CIDR`
  when one is added.
