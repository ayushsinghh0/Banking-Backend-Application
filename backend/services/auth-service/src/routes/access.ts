import { AccessRule, ROLES } from '@banksphere/common';

/**
 * Who may call each auth-service route (paths relative to /api/v1/auth). tests/route-policies.spec.ts fails if
 * the router and this table disagree, and scripts/access-matrix.mjs renders it into
 * docs/security/access-matrix.md. Change both together, deliberately.
 */
const EVERY_ROLE = ROLES;
// Spelled out (design section 4) rather than derived from ROLE_PERMISSIONS, so a change to the permission
// matrix that widens one of these routes fails the policy test instead of passing silently
const SESSIONS_READ_ANY = ['SUPPORT', 'BANK_ADMIN'] as const;
const EVENTS_READ_ANY = ['SUPPORT', 'FRAUD_ANALYST', 'BANK_ADMIN'] as const;
const IP_RULES_READ = ['SUPPORT', 'BANK_ADMIN'] as const;
const ADMIN_ONLY = ['BANK_ADMIN'] as const;

export const AUTH_ACCESS: readonly AccessRule[] = [
  { method: 'POST', path: '/register', roles: 'public', note: 'self-registration; always creates an unverified CUSTOMER' },
  { method: 'POST', path: '/login', roles: 'public', note: 'password sign-in' },
  { method: 'POST', path: '/login/mfa', roles: 'public', note: 'second sign-in step, proven by the challenge token' },
  { method: 'POST', path: '/refresh', roles: 'public', note: 'session continuation, proven by the refresh token' },
  { method: 'POST', path: '/logout', roles: 'public', note: 'ends the session of the refresh token presented' },
  { method: 'POST', path: '/email/verify', roles: 'public', note: 'proven by the emailed one-time token' },
  { method: 'POST', path: '/email/resend-verification', roles: 'public', note: 'same answer for every address' },
  { method: 'POST', path: '/password/forgot', roles: 'public', note: 'same answer for every address' },
  { method: 'POST', path: '/password/reset', roles: 'public', note: 'proven by the emailed one-time token' },
  { method: 'POST', path: '/staff/activate', roles: 'public', note: 'proven by the emailed one-time activation token' },

  { method: 'POST', path: '/password/change', roles: EVERY_ROLE, note: 'own password; re-authenticates' },
  { method: 'GET', path: '/me', roles: EVERY_ROLE, note: 'own profile' },
  { method: 'POST', path: '/mfa/setup', roles: EVERY_ROLE, note: 'own second factor; re-authenticates' },
  { method: 'POST', path: '/mfa/enable', roles: EVERY_ROLE, note: 'own second factor' },
  { method: 'POST', path: '/mfa/disable', roles: EVERY_ROLE, note: 'own second factor; staff refused by the service' },
  { method: 'POST', path: '/mfa/step-up', roles: EVERY_ROLE, note: 'own session' },

  { method: 'GET', path: '/sessions', roles: EVERY_ROLE, note: 'own sessions only' },
  { method: 'DELETE', path: '/sessions/:sessionId', roles: EVERY_ROLE, note: 'own sessions only' },
  { method: 'POST', path: '/sessions/revoke-others', roles: EVERY_ROLE, note: 'own sessions only' },
  { method: 'GET', path: '/security-events', roles: EVERY_ROLE, note: 'own history only' },

  { method: 'GET', path: '/admin/users', roles: ['SUPPORT', 'BANK_ADMIN'] },
  { method: 'POST', path: '/admin/users', roles: ['BANK_ADMIN'], note: 'four-eyes request' },
  { method: 'PATCH', path: '/admin/users/:userId/status', roles: ['BANK_ADMIN'], note: 'staff targets become four-eyes requests' },
  { method: 'POST', path: '/admin/users/:userId/mfa/reset', roles: ['BANK_ADMIN'], note: 'four-eyes request' },
  { method: 'GET', path: '/admin/requests', roles: ['BANK_ADMIN'] },
  { method: 'POST', path: '/admin/requests/:requestId/approve', roles: ['BANK_ADMIN'], note: 'never the requester or the target' },
  { method: 'POST', path: '/admin/requests/:requestId/reject', roles: ['BANK_ADMIN'], note: 'never the target' },

  { method: 'GET', path: '/admin/users/:userId/sessions', roles: SESSIONS_READ_ANY, note: 'audited' },
  { method: 'DELETE', path: '/admin/users/:userId/sessions/:sessionId', roles: ADMIN_ONLY, note: 'audited' },
  { method: 'GET', path: '/admin/security-events', roles: EVENTS_READ_ANY, note: 'audited' },
  { method: 'GET', path: '/admin/ip-rules', roles: IP_RULES_READ },
  { method: 'POST', path: '/admin/ip-rules', roles: ADMIN_ONLY, note: 'audited' },
  { method: 'DELETE', path: '/admin/ip-rules/:ruleId', roles: ADMIN_ONLY, note: 'audited' },
  { method: 'GET', path: '/admin/ip-bans', roles: IP_RULES_READ },
  { method: 'DELETE', path: '/admin/ip-bans/:ipKey', roles: ADMIN_ONLY, note: 'audited' },
  { method: 'GET', path: '/admin/audit/verify', roles: ADMIN_ONLY, note: 'audited' },
];
