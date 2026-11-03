# Screenshots

Captured automatically by the browser journeys (`frontend/e2e/journeys/bank-day.spec.ts`) on the real Docker stack,
with real data created during the run. Secrets on screen (authenticator keys, QR codes, withdrawal codes) are
masked. Regenerate with `cd frontend && npm run e2e -- --project=journeys`.

Desktop shots are 1440 px wide; phone shots are 390 px wide (iPhone 15/16) and show the bottom tab bar where a
person sees it. The design rules behind them are in [the design system](../../design-system/banksphere/MASTER.md).

## On a phone

| | | |
|---|---|---|
| ![Sign in on a phone](01-sign-in-mobile.png) Sign in | ![Dashboard on a phone](06-customer-dashboard-mobile.png) Overview | ![Dashboard on a phone, dark](06-customer-dashboard-mobile-dark.png) Overview, dark |
| ![Accounts on a phone](06c-accounts-mobile.png) Accounts | ![Statement on a phone](07-account-statement-mobile.png) Account and statement | ![Transfer on a phone](08-transfer-mobile.png) Transfer |
| ![Payees on a phone](10-payees-mobile.png) Payees | ![Security on a phone](13-security-mobile.png) Security | ![Teller desk on a phone](14c-teller-desk-mobile.png) Teller: day closed |
| ![KYC queue on a phone](17-kyc-queue-mobile.png) KYC queue | ![Fraud alerts on a phone](19-fraud-alerts-mobile.png) Fraud alerts | ![Admin overview on a phone](04-admin-overview-mobile.png) Administrator overview |

## Signing in and onboarding

| | |
|---|---|
| ![Sign in](01-sign-in.png) Sign in | ![Sign in, dark](01-sign-in-dark.png) Sign in, dark |
| ![Register](02-register.png) Open an account: live password policy | ![Staff authenticator enrolment](03-staff-authenticator-enrolment.png) Staff authenticator enrolment (masked) |
| ![New customer](06a-customer-onboarding.png) First sign-in: complete your profile | ![KYC pending](12-profile-kyc-pending.png) Profile submitted, verification in progress |

## Customer banking

| | |
|---|---|
| ![Dashboard](06-customer-dashboard.png) Overview: total balance, where the money is, activity, cash flow | ![Dashboard, dark](06-customer-dashboard-dark.png) Dark mode |
| ![Accounts](06c-accounts.png) Accounts as cards | ![Open account](06b-open-account.png) Open a savings or current account |
| ![Statement](07-account-statement.png) Account and statement with running balance | ![Transfer review](08-transfer-review.png) Transfer: review before sending |
| ![Receipt](09-transfer-receipt.png) Transfer receipt | ![Withdrawal code](11-cash-withdrawal-code.png) One-time cash withdrawal code (masked) |
| ![Payees](10-payees.png) Payees with cooling-off explained | ![Add payee](10a-add-payee.png) An unusable account number: one generic answer |
| ![Verified profile](12-profile-kyc-verified.png) Verified profile | ![Security](13-security.png) Security: password, authenticator, session |

## Branch cash

| | |
|---|---|
| ![Blind float](14a-teller-blind-float.png) Teller counts the opening float blind | ![Cash desk](14-teller-desk.png) Cash desk: check the details with the customer |
| ![Teller operations](14b-teller-operations.png) Teller's own operations | ![Teller sessions](15-teller-sessions.png) Supervisor: sessions, blind sign-off, reconciliation |
| ![Cash approvals](16-cash-approvals.png) Supervisor: cash approvals (maker-checker) | |

## Compliance, risk and administration

| | |
|---|---|
| ![KYC queue](17-kyc-queue.png) KYC review queue | ![Customer 360](18-customer-360.png) Customer 360 with versioned KYC decision |
| ![Fraud alerts](19-fraud-alerts.png) Fraud alerts, reasons in plain words | ![Alert detail](20-fraud-alert-detail.png) Alert triage with four-eyes closure |
| ![Admin overview](04-admin-overview.png) Administrator overview | ![Admin overview, dark](04-admin-overview-dark.png) Dark mode |
| ![Approvals](05-approvals.png) Four-eyes approvals | ![Request staff](05a-request-staff.png) Request a new staff member |
| ![Directory](21-directory.png) Staff and user directory | ![Notifications](22-notifications.png) Notification log |
