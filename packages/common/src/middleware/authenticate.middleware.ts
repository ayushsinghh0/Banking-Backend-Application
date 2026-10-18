import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedUser, UserRole, verifyAccessToken } from '../auth/jwt';
import { ForbiddenError, UnauthorizedError } from '../errors/app-error';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Verifies the Bearer access token on every request and attaches the caller identity.
 * Identity is only ever taken from a signed token, never from client-controlled
 * headers such as x-user-id / x-user-role.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing Bearer access token');
    }
    req.user = verifyAccessToken(header.slice('Bearer '.length).trim());
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('Your role is not permitted to perform this action'));
      return;
    }
    next();
  };
}

export function getAuthenticatedUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  return req.user;
}

export function isStaff(user: AuthenticatedUser): boolean {
  return user.role === 'BANK_ADMIN' || user.role === 'SUPPORT';
}

export const INTERNAL_TOKEN_HEADER = 'x-internal-service-token';

export function getInternalServiceToken(): string {
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token || token.length < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must be set and at least 32 characters long');
  }
  return token;
}

/**
 * Guards service-to-service endpoints (e.g. ledger provisioning). These routes must
 * never be exposed through the public gateway; the shared secret is a second line of defence.
 */
export function requireInternalService(req: Request, _res: Response, next: NextFunction): void {
  const presented = req.header(INTERNAL_TOKEN_HEADER) || '';
  const expected = getInternalServiceToken();
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    next(new UnauthorizedError('Invalid internal service credentials'));
    return;
  }
  next();
}
