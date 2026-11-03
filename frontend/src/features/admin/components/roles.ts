import type { Role, StaffRole } from '@/lib/auth/session';

/** What each role is called in the administration screens, and what it can do (mirrors the backend role table) */
export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  CUSTOMER: { label: 'Customer', description: 'Personal banking: their own profile, accounts, payees and transfers.' },
  SUPPORT: { label: 'Support', description: 'Read-only access to customers, branch cash, fraud alerts and notifications.' },
  TELLER: { label: 'Teller', description: 'Runs a cash desk: accepts the float, takes deposits and code-authorised withdrawals.' },
  KYC_OFFICER: { label: 'KYC officer', description: 'Reviews customers’ identity checks and verifies or rejects KYC.' },
  FRAUD_ANALYST: { label: 'Fraud analyst', description: 'Triages fraud alerts; closing high-risk alerts needs a second analyst.' },
  BANK_ADMIN: {
    label: 'Bank administrator',
    description: 'Full administration: approves cash and staff changes, signs off tellers and controls accounts.',
  },
};

export const STAFF_ROLES = ['SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN'] as const satisfies readonly StaffRole[];

export const roleLabel = (role: Role) => ROLE_INFO[role].label;
