import { AccessRule, ROLES } from '@banksphere/common';

/**
 * Who may call each route of account-service, checked against the router by tests/route-policies.spec.ts
 * (and turned into docs/security/access-matrix.md). Roles are the exact set the router lets through; the
 * note says what AccountService decides per account on top of that. Staff may hold personal accounts and
 * have a customer's rights on them, which is why most routes are open to every signed-in role.
 */
export const ACCOUNT_API_PREFIX = '/api/v1/accounts';

export const ACCOUNT_ACCESS: readonly AccessRule[] = [
  { method: 'POST', path: '/', roles: ROLES, note: 'Opens an account for the caller only; requires VERIFIED KYC. Enforced in AccountService.' },
  {
    method: 'GET',
    path: '/',
    roles: ROLES,
    note: "The caller's own accounts; staff may list any customer's with ?customerId= (access-logged). Enforced in AccountService.",
  },
  { method: 'GET', path: '/lookup', roles: ['SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN'], note: 'Staff only; access-logged' },
  { method: 'GET', path: '/:accountId', roles: ROLES, note: 'Owner of the account, or staff (access-logged). Enforced in AccountService.' },
  {
    method: 'PATCH',
    path: '/:accountId/status',
    roles: ROLES,
    note: "Owner may freeze their own account; BANK_ADMIN may freeze, unfreeze (a different administrator than the one who froze it) or close other people's accounts. Enforced in AccountService.",
  },
  {
    method: 'PATCH',
    path: '/:accountId/daily-limit',
    roles: ROLES,
    note: "Owner within the customer cap and the bank ceiling; BANK_ADMIN on other people's accounts (sets the ceiling). Enforced in AccountService.",
  },
];

/** account-service has no internal (service-to-service) routes of its own; it calls ledger and customer APIs */
export const INTERNAL_ACCESS: readonly [] = [];
