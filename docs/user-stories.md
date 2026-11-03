# BankSphere user stories

Every story has acceptance criteria (AC) and the automated tests that prove it. Unit and component tests live
next to the code (`frontend/src/**/*.test.tsx`, `backend/services/*/tests`); browser journeys live in
`frontend/e2e/journeys`; API security regressions live in `backend/scripts/e2e.mjs`.

Roles: **Customer**, **Teller**, **KYC officer**, **Fraud analyst**, **Support**, **Bank administrator**.

---

## 1. Access and identity

### US-1.1 Open an account online (Customer)
*As a prospective customer I want to sign up with my email so that I can start banking without visiting a branch.*
- AC1 The password policy (≥10 characters, upper, lower, digit) is shown live and enforced before submitting.
- AC2 Whether or not the email is already registered, the response is identical ("Check your email").
- AC3 A verification link is emailed; opening it verifies the address once; an expired or used link offers a new one.
- AC4 Signing in before verifying explains what to do and can resend the link.
- Tests: `AuthFlows.test.tsx` (Register, VerifyEmail), `LoginPage.test.tsx`, `journeys/bank-day.spec.ts` ("a customer signs up…"), backend e2e "registration / enumeration".

### US-1.2 Sign in securely (everyone)
- AC1 Wrong credentials produce one generic message (no account enumeration).
- AC2 With an authenticator enabled, a second step asks for a 6-digit code; wrong codes keep the person on that step; after too many attempts the step restarts.
- AC3 Repeated failures lock sign-in; a distributed attack requires a password reset by email.
- AC4 Staff signing in from outside the staff network are refused with a clear message.
- AC5 Signed-in people visiting the sign-in page go to their home page; signed-out people visiting a protected page are sent to sign in and returned afterwards.
- Tests: `LoginPage.test.tsx`, `routes.test.tsx`, `session.test.ts`, backend auth unit tests, backend e2e "brute force", `journeys/bank-day.spec.ts`.

### US-1.3 Stay signed in safely (everyone)
- AC1 The access token lives only in memory; the refresh token is an `HttpOnly`, `SameSite=Strict` cookie the page can't read.
- AC2 Reloading the page or opening a new tab restores the session; two tabs refreshing at once don't sign the person out.
- AC3 Signing out in one tab signs out every tab; a password change or reset signs out every other device.
- AC4 Being offline never signs anyone out; an ended session sends the person to sign in.
- AC5 A mistyped password inside the app (e.g. when changing it) never ends the session.
- Tests: `session.test.ts`, `client.test.ts`, `SecurityFlows.test.tsx`, backend auth cookie tests, `journeys/bank-day.spec.ts` ("security: …").

### US-1.4 Reset a forgotten password (everyone)
- AC1 Requesting a reset always shows the same confirmation.
- AC2 The emailed link works once, sets a policy-compliant password and ends every session, including this device.
- Tests: `AuthFlows.test.tsx` (Forgot/Reset), `journeys/bank-day.spec.ts`.

### US-1.5 Protect my account with an authenticator (Customer)
- AC1 Setup re-asks for the password, shows a locally generated QR code and the setup key, and confirms with a code.
- AC2 Turning it off needs the password and a current code, and signs out everywhere.
- Tests: `SecurityFlows.test.tsx`, `journeys/bank-day.spec.ts` ("security: …").

### US-1.6 Approve high-value actions (Customer)
*As a customer I want large transfers to need a fresh code so that a stolen session can't empty my account.*
- AC1 Transfers ≥ ₹1,00,000, withdrawal codes ≥ ₹25,000 and instantly active payees ask for a fresh authenticator code, then continue automatically with the same request (no duplicate).
- AC2 Without an authenticator, the person is told how to set one up; a brand-new authenticator explains its waiting period.
- Tests: `StepUp.test.tsx`, `TransferPage.test.tsx`, `journeys/bank-day.spec.ts` ("security: …").

### US-1.7 Join as staff (all staff roles)
- AC1 An administrator requests the account (email in the corporate domain + role) and a second administrator approves it.
- AC2 The new colleague receives an activation link, chooses their own password (administrators never see it) and must enrol an authenticator before doing anything else.
- Tests: `ApprovalsPage.test.tsx`, `AuthFlows.test.tsx` (StaffActivate), `SecurityFlows.test.tsx` (MfaEnrol), `journeys/bank-day.spec.ts` ("four-eyes staff onboarding…"), backend e2e "four-eyes".

---

## 2. Customer banking

### US-2.1 Complete my profile for KYC (Customer)
- AC1 New customers are guided to create a profile (name, mobile, date of birth, address) with the same validation as the server.
- AC2 The KYC status (pending, verified, rejected) and what it means is always visible.
- AC3 Changing identity details warns that it restarts verification.
- Tests: `ProfilePage.test.tsx`, `DashboardPage.test.tsx`, `journeys/bank-day.spec.ts`.

### US-2.2 See my money at a glance (Customer)
- AC1 The dashboard shows total balance, each account, a 30-day cash-flow chart and recent activity, with clear loading, empty and error states.
- AC2 Amounts are exact (integer paise, Indian digit grouping).
- Tests: `DashboardPage.test.tsx`, `money.test.ts`, `journeys/bank-day.spec.ts`.

### US-2.3 Open an account (Customer)
- AC1 Only customers with verified KYC can open a savings or current account; others are told why.
- Tests: `AccountsPage.test.tsx`, `journeys/bank-day.spec.ts`, backend account tests.

### US-2.4 Read my statement and control my account (Customer)
- AC1 Each account shows its balance, daily limit and a paginated statement (credits and debits, running balance).
- AC2 I can freeze my account (only the bank can unfreeze it) and lower or raise my daily limit within the bank's limits.
- Tests: `AccountDetailPage.test.tsx`, backend account tests.

### US-2.5 Send money (Customer)
- AC1 I can transfer between my accounts or to a registered payee, review before confirming, and get a receipt with a reference.
- AC2 A transfer is never sent twice (idempotency key per transfer, reused on retry).
- AC3 Every refusal (insufficient balance, daily limit, payee cooling-off, first-day cap, frozen account) is explained.
- Tests: `TransferPage.test.tsx`, `endpoints.test.ts`, backend ledger tests, backend e2e "double spend / overdraft race", `journeys/bank-day.spec.ts`.

### US-2.6 Manage payees (Customer)
- AC1 New payees activate after a cooling-off period unless approved instantly with an authenticator code; the first-day cap is explained.
- AC2 Unknown or unusable account numbers all get the same answer.
- AC3 I am emailed whenever a payee is added.
- Tests: `PayeesPage.test.tsx`, backend beneficiary + notification tests, `journeys/bank-day.spec.ts`.

### US-2.7 Withdraw cash at a branch (Customer → Teller)
- AC1 I create a one-time 8-digit code for an exact amount and account; it is shown once with a countdown and emailed as a notice.
- AC2 The teller can only pay out with that code; wrong guesses burn the codes.
- Tests: `CashWithdrawalPage.test.tsx`, `TellerDeskPage.test.tsx`, backend teller tests, `journeys/bank-day.spec.ts`.

---

## 3. Branch cash

### US-3.1 Start my day with a counted float (Teller ← Administrator)
- AC1 An administrator issues an opening float; I count it blind (the issued figure is never shown) and it is booked vault → drawer only if the counts match.
- Tests: `TellerDeskPage.test.tsx`, `TellerSessionsPage.test.tsx`, backend teller tests, `journeys/bank-day.spec.ts`.

### US-3.2 Take deposits and pay withdrawals (Teller)
- AC1 I find the account by number, see the holder's name and status, and post the operation with an idempotency key.
- AC2 Large amounts or my daily total send the operation for a second person's approval (shown as "sent for approval").
- Tests: `TellerDeskPage.test.tsx`, `TellerOperationsPage.test.tsx`, `journeys/bank-day.spec.ts`.

### US-3.3 Close my day (Teller → Administrator)
- AC1 I declare my drawer count blind; the supervisor counts blind; if the counts agree the cash returns to the vault and any difference goes to suspense.
- AC2 A disagreement never leaves the session stuck: I may recount, and two independent supervisor counts resolve a dispute.
- Tests: `TellerDeskPage.test.tsx`, `TellerSessionsPage.test.tsx`, backend teller tests.

### US-3.4 Approve cash operations (Administrator)
- AC1 I see pending operations and approve or reject them; I can never approve my own request or one on my own account.
- Tests: `CashOperationsPage.test.tsx`, backend e2e "self-approval".

---

## 4. Compliance, risk and support

### US-4.1 Review KYC (KYC officer)
- AC1 A queue of pending customers, oldest first, with search.
- AC2 I verify or reject against the exact profile version I reviewed; if the customer changed details meanwhile I am asked to review again.
- Tests: `KycQueuePage.test.tsx`, `CustomerDetailPage.test.tsx`, backend customer tests.

### US-4.2 Triage fraud alerts (Fraud analyst)
- AC1 Alerts by status with severity and reason; I can start a review, resolve or dismiss with a note.
- AC2 Closing a high or critical alert needs a second analyst; the person who initiated the flagged transaction can't triage it.
- Tests: `FraudAlertsPage.test.tsx`, `FraudAlertDetailPage.test.tsx`, backend fraud tests.

### US-4.3 Help a customer (Support)
- AC1 I can look up a customer, their accounts, balances and notification history read-only; every look-up is logged.
- Tests: `CustomersPage.test.tsx`, `CustomerDetailPage.test.tsx`, `NotificationsPage.test.tsx`, backend access-log tests.

---

## 5. Administration

### US-5.1 Run the bank's controls (Administrator)
- AC1 An overview shows what needs attention: pending approvals, cash approvals, sessions awaiting sign-off, open alerts.
- AC2 Staff changes (create, disable, enable, MFA reset) are four-eyes requests; I can't approve my own requests or ones about me.
- AC3 Customers can be disabled immediately (fraud response); re-enabling needs a different administrator.
- AC4 I can freeze, unfreeze (not my own freeze), close (zero balance) and set limits on customer accounts.
- Tests: `OverviewPage.test.tsx`, `ApprovalsPage.test.tsx`, `DirectoryPage.test.tsx`, `CustomerDetailPage.test.tsx`, backend e2e "four-eyes / dual control".
