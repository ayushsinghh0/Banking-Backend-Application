import { AccessRule } from '@banksphere/common';

/**
 * Who may call each route of fraud-service, checked against the router by tests/route-policies.spec.ts (and
 * turned into docs/security/access-matrix.md). Risk data is compliance-only: fraud analysts triage, bank
 * administrators and support read. Tellers and KYC officers never see it: tellers are the subjects of the
 * cash-structuring alerts, and nothing in either role's work needs risk scores. Separation of duties keeps
 * triage (closing alerts) with analysts alone, so an administrator who approved a cash operation can never
 * close the alert it raised.
 */
export const FRAUD_API_PREFIX = '/api/v1/fraud';

const RISK_READERS = ['SUPPORT', 'FRAUD_ANALYST', 'BANK_ADMIN'] as const;

export const FRAUD_ACCESS: readonly AccessRule[] = [
  { method: 'POST', path: '/evaluate', roles: ['FRAUD_ANALYST'], note: 'Dry run: scores a transaction without recording anything' },
  { method: 'GET', path: '/alerts', roles: RISK_READERS },
  {
    method: 'PATCH',
    path: '/alerts/:alertId',
    roles: ['FRAUD_ANALYST'],
    note: 'Never about a transaction the caller initiated; closing a HIGH or CRITICAL alert needs a second, different analyst. Enforced in FraudService.',
  },
  { method: 'GET', path: '/alerts/:alertId/history', roles: RISK_READERS },
];

/** fraud-service has no internal (service-to-service) routes; it consumes transaction.completed.v1 instead */
export const INTERNAL_ACCESS: readonly [] = [];
