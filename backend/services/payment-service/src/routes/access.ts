import { AccessRule } from '@banksphere/common';

/**
 * Who may call each payment-service route (paths relative to the /api/v1/payments mount). Declared by hand,
 * not derived from the permission table, so tests/route-policies.spec.ts fails if the code and this table
 * ever disagree. docs/security/access-matrix.md is generated from it.
 */
export const PAYMENT_ROUTES_ACCESS: readonly AccessRule[] = [
  { method: 'GET', path: '/config', roles: ['CUSTOMER'] },
  { method: 'POST', path: '/top-ups', roles: ['CUSTOMER'], note: 'into the caller\'s own active account only' },
  { method: 'GET', path: '/top-ups', roles: ['CUSTOMER'], note: 'own top-ups only' },
  {
    method: 'GET',
    path: '/top-ups/:id',
    roles: ['CUSTOMER', 'SUPPORT', 'FRAUD_ANALYST', 'BANK_ADMIN'],
    note: 'customers: their own top-up only (others are 404); staff with payments:read:any: any',
  },
  { method: 'POST', path: '/top-ups/:id/confirm', roles: ['CUSTOMER'], note: 'own top-up only' },
  { method: 'POST', path: '/top-ups/:id/cancel', roles: ['CUSTOMER'], note: 'own top-up only' },
  { method: 'POST', path: '/top-ups/:id/simulate', roles: ['CUSTOMER'], note: 'own top-up only; 404 unless simulator mode outside production' },
  { method: 'GET', path: '/admin/top-ups', roles: ['SUPPORT', 'FRAUD_ANALYST', 'BANK_ADMIN'] },
  { method: 'GET', path: '/admin/summary', roles: ['SUPPORT', 'FRAUD_ANALYST', 'BANK_ADMIN'] },
  { method: 'POST', path: '/admin/top-ups/:id/refund', roles: ['BANK_ADMIN'], note: 'also requires a recent step-up (STEP_UP_REQUIRED)' },
  { method: 'POST', path: '/admin/reconcile', roles: ['BANK_ADMIN'] },
];

export const WEBHOOK_ROUTES_ACCESS: readonly AccessRule[] = [
  {
    method: 'POST',
    path: '/webhooks/razorpay',
    roles: 'public',
    note: 'Razorpay webhook: authenticated by HMAC-SHA256 of the raw body with the webhook secret',
  },
];

/** The whole service, by mount path (for the access-matrix generator) */
export const ACCESS_TABLE: Readonly<Record<string, readonly AccessRule[]>> = {
  '/api/v1/payments': [...WEBHOOK_ROUTES_ACCESS, ...PAYMENT_ROUTES_ACCESS],
};
