import { AccessRule } from '@banksphere/common';

/**
 * Who may call each route of the real-time router (mounted at /api/v1/realtime). tests/route-policies.spec.ts
 * proves the router matches this table; scripts/access-matrix.mjs publishes it.
 */
export const REALTIME_ACCESS: readonly AccessRule[] = [
  {
    method: 'GET',
    path: '/stream',
    roles: ['CUSTOMER', 'SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN'],
    note: 'realtime:subscribe. Channels come from the token only: the caller\'s own user channel, plus its role channel for staff',
  },
];
