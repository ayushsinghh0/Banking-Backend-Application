import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors/app-error';
import { ROLES, UserRole } from './jwt';
import { tagPolicy } from './route-policy';

/**
 * Permissions for the capabilities added with payments, the assistant, real-time updates and account
 * security. Routes ask for a permission, not a role, so who may do what is decided in this one table and
 * reviewed in one place (docs/security/access-matrix.md is generated from the routes that use it).
 * Ownership ("your own top-up") is always also enforced by the service; a permission never replaces it.
 */
export const PERMISSIONS = [
  'payments:topup',
  'payments:read:own',
  'payments:read:any',
  'payments:refund',
  'payments:reconcile',
  'assistant:chat',
  'realtime:subscribe',
  'security:sessions:own',
  'security:sessions:read:any',
  'security:sessions:revoke:any',
  'security:events:read:any',
  'security:ip-rules:read',
  'security:ip-rules:write',
  'audit:verify',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const EVERYONE: Permission[] = ['assistant:chat', 'realtime:subscribe', 'security:sessions:own'];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  CUSTOMER: [...EVERYONE, 'payments:topup', 'payments:read:own'],
  SUPPORT: [...EVERYONE, 'payments:read:any', 'security:sessions:read:any', 'security:events:read:any', 'security:ip-rules:read'],
  TELLER: [...EVERYONE],
  KYC_OFFICER: [...EVERYONE],
  FRAUD_ANALYST: [...EVERYONE, 'payments:read:any', 'security:events:read:any'],
  BANK_ADMIN: [
    ...EVERYONE,
    'payments:read:any',
    'payments:refund',
    'payments:reconcile',
    'security:sessions:read:any',
    'security:sessions:revoke:any',
    'security:events:read:any',
    'security:ip-rules:read',
    'security:ip-rules:write',
    'audit:verify',
  ],
};

export function can(user: { role: UserRole } | undefined, permission: Permission): boolean {
  return Boolean(user && ROLE_PERMISSIONS[user.role]?.includes(permission));
}

export function rolesWith(...permissions: Permission[]): UserRole[] {
  return ROLES.filter((role) => permissions.some((p) => ROLE_PERMISSIONS[role].includes(p)));
}

/**
 * Lets the request through if the signed-in user holds ANY of the permissions (e.g. "read your own top-up"
 * or "read any top-up"); the handler then narrows by ownership. Must run after authentication.
 */
export function authorize(...permissions: Permission[]): RequestHandler {
  if (!permissions.length) throw new Error('authorize() needs at least one permission');
  const handler = (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new UnauthorizedError());
    if (!permissions.some((p) => can(req.user, p))) {
      return next(new ForbiddenError('Your role is not permitted to perform this action'));
    }
    next();
  };
  return tagPolicy(handler, { kind: 'permission', roles: rolesWith(...permissions), permissions });
}
