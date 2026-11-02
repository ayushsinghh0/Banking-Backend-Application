import { AccessRule, UserRole } from '@banksphere/common';

const EVERYONE: readonly UserRole[] = ['CUSTOMER', 'SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN'];

/**
 * Who may call each assistant route (paths relative to the /api/v1/assistant mount). Every route carries
 * assistant:chat, which every role holds; what differs per role is decided inside: staff get the help tool only,
 * and every conversation is read, written and deleted as its owner (someone else's is a 404, never a 403).
 * tests/route-policies.spec.ts proves the router matches this table; scripts/access-matrix.mjs publishes it.
 */
export const ASSISTANT_ACCESS: readonly AccessRule[] = [
  { method: 'GET', path: '/meta', roles: EVERYONE, note: 'assistant:chat; suggestions depend on the caller’s role' },
  { method: 'GET', path: '/conversations', roles: EVERYONE, note: 'assistant:chat; own conversations only' },
  { method: 'POST', path: '/conversations', roles: EVERYONE, note: 'assistant:chat; owned by the caller' },
  { method: 'GET', path: '/conversations/:id', roles: EVERYONE, note: 'assistant:chat; own only, others are 404' },
  { method: 'DELETE', path: '/conversations/:id', roles: EVERYONE, note: 'assistant:chat; own only, others are 404' },
  {
    method: 'POST',
    path: '/conversations/:id/messages',
    roles: EVERYONE,
    note: 'assistant:chat; own only. Tools run with the caller’s own token; staff get search_help only. Per-user message rate and daily token budget',
  },
];

/** The whole service, by mount path (for the access-matrix generator) */
export const ACCESS_TABLE: Readonly<Record<string, readonly AccessRule[]>> = {
  '/api/v1/assistant': ASSISTANT_ACCESS,
};
