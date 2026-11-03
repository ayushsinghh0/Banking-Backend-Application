import { AccessRule, ROLES } from '@banksphere/common';

/**
 * Who may call each route of customer-service, checked against the routers by tests/route-policies.spec.ts
 * (and turned into docs/security/access-matrix.md). Roles are the exact set the router lets through; the
 * note says what CustomerService decides on top of that. Every signed-in role may hold a profile of their
 * own (staff open personal accounts too), which is why the /me routes are open to all of them: the service
 * only ever reads or writes the profile of the token's subject there.
 */
export const CUSTOMER_API_PREFIX = '/api/v1/customers';

export const CUSTOMER_ACCESS: readonly AccessRule[] = [
  { method: 'GET', path: '/me', roles: ROLES, note: "The caller's own profile only (identity from the token). Enforced in CustomerService." },
  { method: 'POST', path: '/me', roles: ROLES, note: "Creates the caller's own profile only. Enforced in CustomerService." },
  {
    method: 'PATCH',
    path: '/me',
    roles: ROLES,
    note: "The caller's own profile only; an identity change on a reviewed profile resets KYC to PENDING. Enforced in CustomerService.",
  },
  { method: 'GET', path: '/', roles: ['SUPPORT', 'KYC_OFFICER', 'BANK_ADMIN'], note: 'Staff search and KYC review queue; every profile returned is access-logged' },
  { method: 'GET', path: '/:userId', roles: ['SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN'], note: 'Staff only; access-logged' },
  {
    method: 'PATCH',
    path: '/:userId/kyc',
    roles: ['KYC_OFFICER'],
    note: 'Separation of duties: KYC officers alone, never on their own profile, and only on the profile version they reviewed. Enforced in CustomerService.',
  },
  { method: 'GET', path: '/:userId/kyc/history', roles: ['SUPPORT', 'KYC_OFFICER', 'BANK_ADMIN'], note: 'Staff only (it carries identity data); access-logged' },
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
    prefix: '/internal/v1',
    credential: 'CUSTOMER_INTERNAL_TOKEN',
    caller: 'account-service',
    routes: [{ method: 'GET', path: '/customers/:userId/kyc' }],
  },
];
