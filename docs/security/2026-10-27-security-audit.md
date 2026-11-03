# Security audit — 27 October 2026

**Scope.** The whole backend after three earlier review rounds: API gateway, seven services, the shared package,
Prisma migrations, and the Docker / Kafka / Redis / Postgres infrastructure. Four independent reviewers each
traced every finding end to end (route → middleware → service → SQL) before reporting it. Every finding was then
fixed test-first (a failing test before the change) and verified on a real stack.

**Result.** 37 findings: 4 high, 15 medium, 18 low. All 37 are fixed. Scale follow-ups that need a design change
are listed under [Documented limitations](#documented-limitations). Integration testing found three more defects
(S-38 to S-40), also fixed.

**Evidence.**
- Backend unit tests: 141 → 320.
- API functional and security suite: `backend/scripts/e2e.mjs`, 207 checks passing against the full Docker stack
  ([results](../testing/api-e2e-results.txt)).
- Browser journeys: 13 passing.
- Upgrade path: the new migrations were applied to a copy of an existing database holding data (0 invalid indexes,
  0 unvalidated constraints afterwards).

Severity: **High** = exploitable for money, identity or privilege, or a deploy-day outage. **Medium** = a control
that can be bypassed, or a reliability failure under realistic conditions. **Low** = defence in depth, scale,
hygiene.

## Findings and fixes

| ID | Sev | Area | Finding | Fix (and proof) |
|---|---|---|---|---|
| S-01 | High | Gateway, all services | The staff-network allowlist checked URL prefixes. Many staff actions share customer paths, so they were reachable from the internet with a stolen staff session: KYC decisions, unfreeze, limit changes, staff reads. | Enforced **by role** in the shared `authenticate` middleware on every service: any non-customer token from outside `STAFF_ALLOWED_CIDRS` gets 403 `NETWORK_NOT_ALLOWED`. Staff sign-in is refused off-network, after the password check so it can't be used to enumerate accounts. The gateway path list stays as defence in depth, now including account lookup and an exact match for the customer list. Unit + gateway tests. |
| S-02 | High | Kafka | Fraud and notification shared the `<topic>.retry` topics with write access. A retry envelope's `originalTopic` was trusted, so one compromised service could forge another's events, including bank-signed emails. Bad retry messages were sent to a dead-letter topic that doesn't exist and stalled the partition forever. | One retry topic per consumer service (`<service>.<topic>.retry`), with ACLs for that service only. The original topic is derived from the retry topic's name. `hop`, `retryAt` and payload are type-checked and `retryAt` is clamped. Unusable messages go to the original topic's existing `.dlq`. Mocked-Kafka unit tests. |
| S-03 | High | Ledger | A mismatched teller close-out could never be resolved. The supervisor's "blind" count could copy the teller's declared figure from the session list, and mismatch audits were rolled back. | Declared, expected and discrepancy figures are hidden until RECONCILED. Mismatches are audited outside the failed transaction. The teller may re-declare until sign-off. If the counts disagree, a second, different administrator entering the same count settles it (`TELLER_DECLARATION_DISPUTED` alert). Unit + API e2e (re-declare, blind list). |
| S-04 | High | Auth / browser | A wrong password on an authenticated endpoint (change password, authenticator setup or removal) returned 401. Browsers read that as an expired session: refresh, retry, sign the user out. | These endpoints now return 403 `INVALID_PASSWORD`, or 400 `INVALID_MFA_CODE` for a wrong code. 401 is kept for token problems only. Unit + API e2e ("a mistyped password does not end the session") + browser journey. |
| S-05 | Med | Auth | The administrator a four-eyes request was about could reject it, for example to block their own disablement. | The target can't reject; the requester can withdraw. API e2e. |
| S-06 | Med | Auth | The authenticator-code failure budget was check-then-act, so parallel guesses could exceed it. | Each attempt is reserved first: an atomic increment before the code is checked, refunded on success. Shared by sign-in, step-up and disable. |
| S-07 | Med | Auth | `/mfa/disable`, password change and authenticator setup didn't count failed passwords or codes. | Code failures count towards the authenticator lock; password failures count towards the account lockout. |
| S-08 | Med | Auth | `mfa_enabled_at` was never backfilled, so users who enrolled before round 3 could never pass step-up. | Backfill migration, verified on a copy of real data. |
| S-09 | Med | Accounts | A customer could immediately undo a daily-limit reduction imposed by the bank. | A limit set by an administrator becomes a ceiling (`bankLimitCeilingPaise`): the owner can lower the limit but not raise it past the ceiling. API e2e. |
| S-10 | Med | Accounts / KYC | Some staff reads of customer data weren't access-logged: KYC history, account list and detail. | Logged, in a new append-only account-service access log with triggers and REVOKE. No log row means no data is returned. |
| S-11 | Med | Ledger | Removing and re-adding a payee reset its first-day cap. Nothing told the customer that a payee had been added. | The cap sums the trailing 24 hours. Re-adds are audited and counted. A new `beneficiary.added.v1` event emails the customer with the account number masked. API e2e. |
| S-12 | Med | Ledger | Wrong withdrawal codes made the transaction wait for a second pooled connection; enough of them exhausted the pool. | The failure is recorded after rollback in its own short transaction, on a new index. 20 parallel wrong codes give 0 errors (unit). |
| S-13 | Med | Ledger | Reconciliation would silently stop at scale: 30 s statement timeout and no alert key. | `SET LOCAL statement_timeout` for the job and an `alert: LEDGER_RECONCILIATION_ERROR` key on failure. Incremental reconciliation is a documented follow-up. |
| S-14 | Med | Notifications | SMTP infrastructure errors (DNS, TLS, authentication, protocol) were treated as permanent, so alerts were lost. | Only per-message rejections are permanent. Infrastructure failures are retried and never marked as processed. |
| S-15 | Med | Fraud | One-paisa transfers bounced back and forth flooded the queue with HIGH alerts and security emails. | One open velocity alert per account per window, serialised with an advisory lock. |
| S-16 | Med | Fraud | Splitting cash deposits across tellers was never detected as structuring. | New rolling 24-hour rules per account, regardless of who handled the cash. |
| S-17 | Med | Fraud | Administrators, including the person who approved the cash, could close fraud alerts. | Alert triage is FRAUD_ANALYST only. API e2e. |
| S-18 | Med | Infrastructure | The Postgres healthcheck passed while the database was still initialising, so `migrate` could fail on a fresh `up`. | `pg_isready -h 127.0.0.1` with a start period, plus a retrying migrate job. Verified with fresh volumes. |
| S-19 | Med | Infrastructure | A slow SMTP server starved Kafka heartbeats, and the public gateway waited for the async services to be healthy. | Heartbeats during handlers, an SMTP circuit breaker, one SMTP attempt per Kafka try, and the gateway now depends on those services being *started*, not healthy. |
| S-20 | Low | Ledger | Tellers could read their own drawer balance (the expected cash) and could see the issued float before counting it. | Cash accounts return 404 except to BANK_ADMIN. Teller views are whitelisted and hide `openingFloat` while ISSUED. API e2e + browser journey. |
| S-21 | Low | Ledger | Session status was updated unconditionally after an unlocked read, so cancel and close could race. | Conditional (compare-and-set) updates. |
| S-22 | Low | Ledger | The payee add limit could be exceeded in parallel, and failed look-ups were free (account-number probing). | Per-customer advisory lock; failed look-ups count towards the daily limit. |
| S-23 | Low | Ledger | An empty or non-numeric policy setting silently disabled a control or caused 500s. | Every policy number is validated at startup. |
| S-24 | Low | Accounts | An admin freeze of an account the customer had already frozen wasn't recorded, so a single admin could later unfreeze it. | Recorded as a bank hold; only a different administrator can lift it. API e2e. |
| S-25 | Low | Accounts | The account-number space was 9 million, and ledger collisions weren't retried. | 10 random digits plus Luhn, with retries on ledger conflicts. Existing numbers stay valid. |
| S-26 | Low | Accounts | A ledger activation failure after commit returned 502, so a retry opened a duplicate account. | Always 201 after commit; an alert is raised and the reconciler activates the account. |
| S-27 | Low | Customers | Profile validation accepted future dates of birth and zero-width or direction-override characters in names. | Age 18–120; names are NFKC-normalised and limited to letters, marks, spaces and `. ' -`. API e2e. |
| S-28 | Low | Customers | A cache race could keep a stale profile cached for 30 minutes. | Version-aware cache writes. |
| S-29 | Low | Auth | Expired administrative requests stayed PENDING forever. | The expiry is committed. |
| S-30 | Low | Auth | Anyone could pre-register a future staff email address and block that staff account's creation. | Sign-ups in the staff domain get the identical 202 response and create nothing. API e2e. |
| S-31 | Low | Gateway | If an upstream died mid-response, the client connection hung. | The client response is destroyed. |
| S-32 | Low | Auth | The refresh token issued on authenticator enable was created after commit, so a concurrent password reset could leave it alive. | Created inside the transaction. |
| S-33 | Low | Auth | A full token-version sync blocked startup. | The service listens first; the sync runs in the background, pipelined. |
| S-34 | Low | Notifications | Duplicate emails on retry, email addresses in logs, and own-account transfers sent only one notice. | Each delivery is claimed before sending; addresses are redacted in logs and the DLQ; debit and credit notices have separate keys. |
| S-35 | Low | Fraud | Rule time windows had no upper bound and weren't indexed. | Windows are bounded and indexes added. |
| S-36 | Low | Outbox | The purge was one unbounded DELETE. | Batches of 5,000 with a time budget. |
| S-37 | Low | Infrastructure | `CHANGE_ME` placeholders were accepted as real secrets. | Services and init scripts refuse to start with them. |
| S-38 | — | Tests | Found during integration: `npm test` hung after notification-service because a pino-pretty worker was stranded by fake timers. | Tests log plain JSON. |
| S-39 | Med | Web container | Found during integration: under a read-only root, nginx could not render its config into a root-owned tmpfs, so the web container never served traffic. | tmpfs mounts owned by the nginx user. Verified on the stack. |
| S-40 | Low | Web | Found during integration: the brand mark disappeared on mobile (duplicate SVG gradient id). | A unique id per instance. |

## Security added with the web application

- **Same-origin deployment.** nginx serves the app and proxies `/api`, so there is no CORS surface. The gateway
  is no longer published and trusts exactly one proxy hop, and nginx overwrites `X-Forwarded-For`, so client IPs
  can't be spoofed.
- **Session tokens never reach page scripts.** The refresh token is an `HttpOnly; Secure; SameSite=Strict` cookie
  scoped to `/api/v1/auth`. The client must opt in with a custom header, so cross-site forms can't use it. The
  access token is held in memory. Refreshes are serialised across tabs and sign-out reaches every tab.
- **Strict CSP.** Scripts load only from the app's own origin, with no inline or eval. No third-party origins;
  QR codes are generated locally. Plus frame-ancestors none, no referrer, nosniff, and the COOP/CORP headers.
- **Money integrity in the UI.** BigInt paise only. Every money-moving request has an idempotency key per intent,
  reused on retry. Step-up continues the *same* request after the code is confirmed.
- **No data bleed between sessions.** The query cache is cleared on sign-out and session change. Tokens from email
  links are read from the URL fragment and removed from history.
- `npm audit`: 0 vulnerabilities in the frontend, including dev tooling.

## Documented limitations

- Reconciliation still scans the whole ledger, within a 110 s budget. Make it incremental before the ledger
  reaches tens of millions of entries.
- Customer name search uses `ILIKE` without a trigram index, because the schema owner can't create extensions.
  Add `pg_trgm` at the infrastructure level when the customer base grows.
- The old shared `<topic>.retry` topics are left in place, unused and with their ACLs revoked. Delete them once
  their consumer groups show no lag.
- If a crash happens between claiming a notification delivery and SMTP accepting it, that one email is lost
  (at-most-once). This was preferred over duplicate security emails.
- A newly created account reports ACTIVE before ledger activation completes. If activation fails, the reconciler
  completes it and an alert is raised; there is no separate PENDING status.
- There is no single-alert API. The alert detail page finds an alert among the newest 500 of each status.
- In the dev overlay, services published on localhost would accept a spoofed `X-Forwarded-For`. In production the
  services sit on internal networks only and the gateway is reachable only through the web container.
- The earlier limitations in [backend/README.md](../../backend/README.md#known-limitations) still apply: staff and
  customer identities aren't linked, single-officer KYC, alerting through structured logs.
