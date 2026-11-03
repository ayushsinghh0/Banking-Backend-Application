# BankSphere web app

Customer internet banking and the staff back office in one React application. Each role gets its own workspace
after sign-in:

| Role | Workspace |
|---|---|
| Customer | Overview dashboard, accounts and statements, transfers, payees, cash withdrawal codes, profile & KYC, security |
| Teller | Cash desk (blind float count, deposits, code-authorised withdrawals, blind closing count), own operations |
| KYC officer | KYC review queue, customer 360 with versioned decisions |
| Fraud analyst | Alert triage with four-eyes closure, notification log |
| Support | Read-only customer 360, user directory, teller sessions, cash operations, alerts, notification log |
| Bank administrator | Overview, four-eyes approvals, staff & user directory, teller sessions (issue float, blind sign-off), cash approvals, customer account controls |

## Look and feel

The interface follows [the BankSphere design system](../design-system/banksphere/MASTER.md): white tiles on a soft
canvas (true black in dark mode), Inter with optical sizing, ink for the one primary action, blue for links and
focus, colour only where it means something (money in, attention, errors).

- **Customers** get a consumer layout: a translucent top bar on desktop; on phones a compact header and a bottom
  tab bar (Overview, Accounts, Transfer, Payees, Cash) within thumb reach.
- **Staff** get a quiet sidebar on desktop; on phones the same tab bar, with a "More" sheet when a role has more
  than five destinations.
- Dialogs are centred panels on desktop and bottom sheets on phones. Inputs are 44 px tall with 16 px text on
  phones (no zoom on focus); safe areas are respected on notched devices.
- Personal settings (profile, security, appearance, sign out) live in the account menu (the avatar).

## Security model in the browser

- **Same origin.** nginx serves the app and proxies `/api/` to the gateway, so there is no CORS and no
  third-party origin anywhere (fonts and QR codes are local). Strict CSP: scripts only from this origin.
- **Tokens.** The access token lives only in memory. The refresh token is an `HttpOnly; SameSite=Strict` cookie
  scoped to `/api/v1/auth`, requested with `X-Session-Transport: cookie`; page scripts can never read it.
  Refreshes are serialised across tabs (Web Locks) and sign-out is broadcast to every tab.
- **Money.** Integer paise strings end to end, BigInt arithmetic, never floats. Every money-moving request
  carries an idempotency key that is reused on retry of the same intent.
- **Step-up.** High-value actions ask for a fresh authenticator code and resume the same request.
- **Data hygiene.** The query cache is cleared when the session changes; one-time tokens from email links are
  read from the URL fragment and removed from the address bar.

## Develop

```bash
npm install
npm run dev                         # http://localhost:3000 (proxies /api to VITE_DEV_GATEWAY_URL, default http://localhost:8000)
npm test                            # unit + component tests (Vitest, MSW)
npm run test:coverage               # with coverage thresholds
npm run typecheck && npm run lint
npm run build                       # production bundle in dist/
```

Conventions for new screens: [CONTRIBUTING.md](CONTRIBUTING.md). Browser journeys and screenshots:
[e2e/README.md](e2e/README.md).

## Container

`Dockerfile` builds the app and serves it with an unprivileged nginx (`nginx/default.conf.template`,
`nginx/security-headers.conf`). Environment:

| Variable | Default | Meaning |
|---|---|---|
| `API_UPSTREAM` | `api-gateway:8000` | Gateway host:port |
| `TRUSTED_PROXY_CIDR` | `127.0.0.1/32` | Load balancer allowed to set `X-Forwarded-For`; otherwise nginx uses the TCP peer and overwrites the header |

Health: `GET /healthz`.
