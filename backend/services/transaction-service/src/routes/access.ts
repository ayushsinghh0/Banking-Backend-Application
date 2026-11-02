import { AccessRule, ROLES } from '@banksphere/common';

/**
 * Who may call each route of transaction-service, checked against the routers by
 * tests/route-policies.spec.ts (and turned into docs/security/access-matrix.md). Roles are the exact set the
 * router lets through; a note says what the service decides per resource on top of that.
 */
export const TRANSACTION_API_PREFIX = '/api/v1/transactions';

const OWNER_OR_STAFF =
  'Owner of a customer account, or any staff role (staff reads are audit-logged); teller drawer, vault, suspense and payment clearing accounts only to BANK_ADMIN. Enforced in LedgerService.';

export const TRANSACTION_ACCESS: readonly AccessRule[] = [
  // Customers: their own money (source account ownership is enforced in the service)
  { method: 'POST', path: '/transfer', roles: ['CUSTOMER'], note: 'From an account the caller owns only' },
  { method: 'GET', path: '/beneficiaries', roles: ['CUSTOMER'], note: 'The caller’s own payees' },
  { method: 'POST', path: '/beneficiaries', roles: ['CUSTOMER'], note: 'Adds a payee for the caller' },
  { method: 'DELETE', path: '/beneficiaries/:id', roles: ['CUSTOMER'], note: 'The caller’s own payees only' },
  { method: 'POST', path: '/withdrawal-codes', roles: ['CUSTOMER'], note: 'For an account the caller owns only' },

  // Tellers (maker): branch cash inside their own session, never on their own accounts
  { method: 'GET', path: '/teller/sessions/current', roles: ['TELLER'], note: 'The caller’s own session' },
  { method: 'POST', path: '/teller/sessions/accept', roles: ['TELLER'], note: 'The caller’s own issued float' },
  { method: 'POST', path: '/teller/sessions/close', roles: ['TELLER'], note: 'The caller’s own open session' },
  { method: 'POST', path: '/deposit', roles: ['TELLER'] },
  { method: 'POST', path: '/withdraw', roles: ['TELLER'], note: 'Needs the customer’s single-use withdrawal code' },

  // Supervisors (checker)
  { method: 'GET', path: '/teller/sessions', roles: ['SUPPORT', 'BANK_ADMIN'] },
  { method: 'POST', path: '/teller/sessions', roles: ['BANK_ADMIN'], note: 'Never to the caller themselves' },
  { method: 'POST', path: '/teller/sessions/:id/cancel', roles: ['BANK_ADMIN'] },
  { method: 'POST', path: '/teller/sessions/:id/sign-off', roles: ['BANK_ADMIN'], note: 'A different administrator from the teller' },
  { method: 'GET', path: '/cash-operations', roles: ['SUPPORT', 'TELLER', 'BANK_ADMIN'], note: 'Tellers see only the operations they requested' },
  { method: 'POST', path: '/cash-operations/:cashOperationId/approve', roles: ['BANK_ADMIN'], note: 'A different administrator from the requester' },
  { method: 'POST', path: '/cash-operations/:cashOperationId/reject', roles: ['BANK_ADMIN'] },

  // Integrity
  { method: 'GET', path: '/audit/verify', roles: ['BANK_ADMIN'], note: 'Permission audit:verify' },

  // Ledger reads
  { method: 'GET', path: '/accounts/:accountId/balance', roles: ROLES, note: OWNER_OR_STAFF },
  { method: 'GET', path: '/accounts/:accountId/history', roles: ROLES, note: OWNER_OR_STAFF },
];

/** Service-to-service routes: never routed by the gateway, guarded by a credential instead of a role */
export interface InternalRouteTable {
  prefix: string;
  /** Environment variable holding the credential (x-internal-service-token) */
  credential: string;
  caller: string;
  routes: ReadonlyArray<{ method: string; path: string }>;
}

export const INTERNAL_ACCESS: readonly InternalRouteTable[] = [
  {
    prefix: '/internal/v1/payments',
    credential: 'PAYMENT_LEDGER_INTERNAL_TOKEN',
    caller: 'payment-service',
    routes: [
      { method: 'GET', path: '/accounts/:accountId' },
      { method: 'POST', path: '/credits' },
      { method: 'POST', path: '/refunds' },
      { method: 'POST', path: '/refunds/:refundId/reverse' },
    ],
  },
  {
    prefix: '/internal/v1',
    credential: 'LEDGER_INTERNAL_TOKEN',
    caller: 'account-service',
    routes: [
      { method: 'POST', path: '/ledger-accounts' },
      { method: 'POST', path: '/ledger-accounts/snapshots' },
      { method: 'POST', path: '/ledger-accounts/:accountId/close' },
      { method: 'GET', path: '/ledger-accounts/:accountId' },
      { method: 'PATCH', path: '/ledger-accounts/:accountId' },
    ],
  },
];
