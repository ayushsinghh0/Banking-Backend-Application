# Access matrix

Who may call each API route, by service. **Generated** by `backend/scripts/access-matrix.mjs` from each service's
`src/routes/access.ts`; do not edit by hand. Every service's `tests/route-policies.spec.ts` fails when its router and
its table disagree, so this document is what the code enforces, not a description of it.

Roles are the exact set the router admits. "every signed-in role" means any authenticated user, and the note then says
what the service decides per resource on top of that (ownership, staff audit logging, step-up). _public_ routes
carry their own proof (a one-time token, a webhook signature). Internal routes are reachable only on the backend
network with the named credential; the gateway never routes them.

## Routes per role

| Service | `CUSTOMER` | `SUPPORT` | `TELLER` | `KYC_OFFICER` | `FRAUD_ANALYST` | `BANK_ADMIN` | public |
|---|---:|---:|---:|---:|---:|---:|---:|
| account-service | 5 | 6 | 6 | 6 | 6 | 6 | 0 |
| assistant-service | 6 | 6 | 6 | 6 | 6 | 6 | 0 |
| auth-service | 10 | 15 | 10 | 10 | 11 | 26 | 10 |
| customer-service | 3 | 6 | 4 | 7 | 4 | 6 | 0 |
| fraud-service | 0 | 2 | 0 | 0 | 4 | 2 | 0 |
| payment-service | 7 | 3 | 0 | 0 | 3 | 5 | 1 |
| realtime-service | 1 | 1 | 1 | 1 | 1 | 1 | 0 |
| transaction-service | 7 | 4 | 8 | 2 | 2 | 10 | 0 |

## account-service

Mounted at `/api/v1/accounts`.

| Method | Path | Who | Note |
|---|---|---|---|
| GET | `/` | every signed-in role | The caller's own accounts; staff may list any customer's with ?customerId= (access-logged). Enforced in AccountService. |
| POST | `/` | every signed-in role | Opens an account for the caller only; requires VERIFIED KYC. Enforced in AccountService. |
| GET | `/:accountId` | every signed-in role | Owner of the account, or staff (access-logged). Enforced in AccountService. |
| PATCH | `/:accountId/daily-limit` | every signed-in role | Owner within the customer cap and the bank ceiling; BANK_ADMIN on other people's accounts (sets the ceiling). Enforced in AccountService. |
| PATCH | `/:accountId/status` | every signed-in role | Owner may freeze their own account; BANK_ADMIN may freeze, unfreeze (a different administrator than the one who froze it) or close other people's accounts. Enforced in AccountService. |
| GET | `/lookup` | `SUPPORT`, `TELLER`, `KYC_OFFICER`, `FRAUD_ANALYST`, `BANK_ADMIN` | Staff only; access-logged |

## assistant-service

Mounted at `/api/v1/assistant`.

| Method | Path | Who | Note |
|---|---|---|---|
| GET | `/conversations` | every signed-in role | assistant:chat; own conversations only |
| POST | `/conversations` | every signed-in role | assistant:chat; owned by the caller |
| GET | `/conversations/:id` | every signed-in role | assistant:chat; own only, others are 404 |
| DELETE | `/conversations/:id` | every signed-in role | assistant:chat; own only, others are 404 |
| POST | `/conversations/:id/messages` | every signed-in role | assistant:chat; own only. Tools run with the caller’s own token; staff get search_help only. Per-user message rate and daily token budget |
| GET | `/meta` | every signed-in role | assistant:chat; suggestions depend on the caller’s role |

## auth-service

Mounted at `/api/v1/auth`.

| Method | Path | Who | Note |
|---|---|---|---|
| GET | `/admin/audit/verify` | `BANK_ADMIN` | audited |
| GET | `/admin/ip-bans` | `SUPPORT`, `BANK_ADMIN` |  |
| DELETE | `/admin/ip-bans/:ipKey` | `BANK_ADMIN` | audited |
| GET | `/admin/ip-rules` | `SUPPORT`, `BANK_ADMIN` |  |
| POST | `/admin/ip-rules` | `BANK_ADMIN` | audited |
| DELETE | `/admin/ip-rules/:ruleId` | `BANK_ADMIN` | audited |
| GET | `/admin/requests` | `BANK_ADMIN` |  |
| POST | `/admin/requests/:requestId/approve` | `BANK_ADMIN` | never the requester or the target |
| POST | `/admin/requests/:requestId/reject` | `BANK_ADMIN` | never the target |
| GET | `/admin/security-events` | `SUPPORT`, `FRAUD_ANALYST`, `BANK_ADMIN` | audited |
| GET | `/admin/users` | `SUPPORT`, `BANK_ADMIN` |  |
| POST | `/admin/users` | `BANK_ADMIN` | four-eyes request |
| POST | `/admin/users/:userId/mfa/reset` | `BANK_ADMIN` | four-eyes request |
| GET | `/admin/users/:userId/sessions` | `SUPPORT`, `BANK_ADMIN` | audited |
| DELETE | `/admin/users/:userId/sessions/:sessionId` | `BANK_ADMIN` | audited |
| PATCH | `/admin/users/:userId/status` | `BANK_ADMIN` | staff targets become four-eyes requests |
| POST | `/email/resend-verification` | _public_ | same answer for every address |
| POST | `/email/verify` | _public_ | proven by the emailed one-time token |
| POST | `/login` | _public_ | password sign-in |
| POST | `/login/mfa` | _public_ | second sign-in step, proven by the challenge token |
| POST | `/logout` | _public_ | ends the session of the refresh token presented |
| GET | `/me` | every signed-in role | own profile |
| POST | `/mfa/disable` | every signed-in role | own second factor; staff refused by the service |
| POST | `/mfa/enable` | every signed-in role | own second factor |
| POST | `/mfa/setup` | every signed-in role | own second factor; re-authenticates |
| POST | `/mfa/step-up` | every signed-in role | own session |
| POST | `/password/change` | every signed-in role | own password; re-authenticates |
| POST | `/password/forgot` | _public_ | same answer for every address |
| POST | `/password/reset` | _public_ | proven by the emailed one-time token |
| POST | `/refresh` | _public_ | session continuation, proven by the refresh token |
| POST | `/register` | _public_ | self-registration; always creates an unverified CUSTOMER |
| GET | `/security-events` | every signed-in role | own history only |
| GET | `/sessions` | every signed-in role | own sessions only |
| DELETE | `/sessions/:sessionId` | every signed-in role | own sessions only |
| POST | `/sessions/revoke-others` | every signed-in role | own sessions only |
| POST | `/staff/activate` | _public_ | proven by the emailed one-time activation token |

## customer-service

Mounted at `/api/v1/customers`.

| Method | Path | Who | Note |
|---|---|---|---|
| GET | `/` | `SUPPORT`, `KYC_OFFICER`, `BANK_ADMIN` | Staff search and KYC review queue; every profile returned is access-logged |
| GET | `/:userId` | `SUPPORT`, `TELLER`, `KYC_OFFICER`, `FRAUD_ANALYST`, `BANK_ADMIN` | Staff only; access-logged |
| PATCH | `/:userId/kyc` | `KYC_OFFICER` | Separation of duties: KYC officers alone, never on their own profile, and only on the profile version they reviewed. Enforced in CustomerService. |
| GET | `/:userId/kyc/history` | `SUPPORT`, `KYC_OFFICER`, `BANK_ADMIN` | Staff only (it carries identity data); access-logged |
| GET | `/me` | every signed-in role | The caller's own profile only (identity from the token). Enforced in CustomerService. |
| POST | `/me` | every signed-in role | Creates the caller's own profile only. Enforced in CustomerService. |
| PATCH | `/me` | every signed-in role | The caller's own profile only; an identity change on a reviewed profile resets KYC to PENDING. Enforced in CustomerService. |

Internal (service-to-service):

| Method | Path | Caller | Credential |
|---|---|---|---|
| GET | `/internal/v1/customers/:userId/kyc` | account-service | `CUSTOMER_INTERNAL_TOKEN` |

## fraud-service

Mounted at `/api/v1/fraud`.

| Method | Path | Who | Note |
|---|---|---|---|
| GET | `/alerts` | `SUPPORT`, `FRAUD_ANALYST`, `BANK_ADMIN` |  |
| PATCH | `/alerts/:alertId` | `FRAUD_ANALYST` | Never about a transaction the caller initiated; closing a HIGH or CRITICAL alert needs a second, different analyst. Enforced in FraudService. |
| GET | `/alerts/:alertId/history` | `SUPPORT`, `FRAUD_ANALYST`, `BANK_ADMIN` |  |
| POST | `/evaluate` | `FRAUD_ANALYST` | Dry run: scores a transaction without recording anything |

## payment-service

Mounted at `/api/v1/payments`.

| Method | Path | Who | Note |
|---|---|---|---|
| POST | `/admin/reconcile` | `BANK_ADMIN` |  |
| GET | `/admin/summary` | `SUPPORT`, `FRAUD_ANALYST`, `BANK_ADMIN` |  |
| GET | `/admin/top-ups` | `SUPPORT`, `FRAUD_ANALYST`, `BANK_ADMIN` |  |
| POST | `/admin/top-ups/:id/refund` | `BANK_ADMIN` | also requires a recent step-up (STEP_UP_REQUIRED) |
| GET | `/config` | `CUSTOMER` |  |
| GET | `/top-ups` | `CUSTOMER` | own top-ups only |
| POST | `/top-ups` | `CUSTOMER` | into the caller's own active account only |
| GET | `/top-ups/:id` | `CUSTOMER`, `SUPPORT`, `FRAUD_ANALYST`, `BANK_ADMIN` | customers: their own top-up only (others are 404); staff with payments:read:any: any |
| POST | `/top-ups/:id/cancel` | `CUSTOMER` | own top-up only |
| POST | `/top-ups/:id/confirm` | `CUSTOMER` | own top-up only |
| POST | `/top-ups/:id/simulate` | `CUSTOMER` | own top-up only; 404 unless simulator mode outside production |
| POST | `/webhooks/razorpay` | _public_ | Razorpay webhook: authenticated by HMAC-SHA256 of the raw body with the webhook secret |

## realtime-service

Mounted at `/api/v1/realtime`.

| Method | Path | Who | Note |
|---|---|---|---|
| GET | `/stream` | every signed-in role | realtime:subscribe. Channels come from the token only: the caller's own user channel, plus its role channel for staff |

## transaction-service

Mounted at `/api/v1/transactions`.

| Method | Path | Who | Note |
|---|---|---|---|
| GET | `/accounts/:accountId/balance` | every signed-in role | Owner of a customer account, or any staff role (staff reads are audit-logged); teller drawer, vault, suspense and payment clearing accounts only to BANK_ADMIN. Enforced in LedgerService. |
| GET | `/accounts/:accountId/history` | every signed-in role | Owner of a customer account, or any staff role (staff reads are audit-logged); teller drawer, vault, suspense and payment clearing accounts only to BANK_ADMIN. Enforced in LedgerService. |
| GET | `/audit/verify` | `BANK_ADMIN` | Permission audit:verify |
| GET | `/beneficiaries` | `CUSTOMER` | The caller’s own payees |
| POST | `/beneficiaries` | `CUSTOMER` | Adds a payee for the caller |
| DELETE | `/beneficiaries/:id` | `CUSTOMER` | The caller’s own payees only |
| GET | `/cash-operations` | `SUPPORT`, `TELLER`, `BANK_ADMIN` | Tellers see only the operations they requested |
| POST | `/cash-operations/:cashOperationId/approve` | `BANK_ADMIN` | A different administrator from the requester |
| POST | `/cash-operations/:cashOperationId/reject` | `BANK_ADMIN` |  |
| POST | `/deposit` | `TELLER` |  |
| GET | `/teller/sessions` | `SUPPORT`, `BANK_ADMIN` |  |
| POST | `/teller/sessions` | `BANK_ADMIN` | Never to the caller themselves |
| POST | `/teller/sessions/:id/cancel` | `BANK_ADMIN` |  |
| POST | `/teller/sessions/:id/sign-off` | `BANK_ADMIN` | A different administrator from the teller |
| POST | `/teller/sessions/accept` | `TELLER` | The caller’s own issued float |
| POST | `/teller/sessions/close` | `TELLER` | The caller’s own open session |
| GET | `/teller/sessions/current` | `TELLER` | The caller’s own session |
| POST | `/transfer` | `CUSTOMER` | From an account the caller owns only |
| POST | `/withdraw` | `TELLER` | Needs the customer’s single-use withdrawal code |
| POST | `/withdrawal-codes` | `CUSTOMER` | For an account the caller owns only |

Internal (service-to-service):

| Method | Path | Caller | Credential |
|---|---|---|---|
| GET | `/internal/v1/payments/accounts/:accountId` | payment-service | `PAYMENT_LEDGER_INTERNAL_TOKEN` |
| POST | `/internal/v1/payments/credits` | payment-service | `PAYMENT_LEDGER_INTERNAL_TOKEN` |
| POST | `/internal/v1/payments/refunds` | payment-service | `PAYMENT_LEDGER_INTERNAL_TOKEN` |
| POST | `/internal/v1/payments/refunds/:refundId/reverse` | payment-service | `PAYMENT_LEDGER_INTERNAL_TOKEN` |
| POST | `/internal/v1/ledger-accounts` | account-service | `LEDGER_INTERNAL_TOKEN` |
| GET | `/internal/v1/ledger-accounts/:accountId` | account-service | `LEDGER_INTERNAL_TOKEN` |
| PATCH | `/internal/v1/ledger-accounts/:accountId` | account-service | `LEDGER_INTERNAL_TOKEN` |
| POST | `/internal/v1/ledger-accounts/:accountId/close` | account-service | `LEDGER_INTERNAL_TOKEN` |
| POST | `/internal/v1/ledger-accounts/snapshots` | account-service | `LEDGER_INTERNAL_TOKEN` |

