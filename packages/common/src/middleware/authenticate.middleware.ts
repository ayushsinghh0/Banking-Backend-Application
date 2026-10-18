import crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthenticatedUser, UserRole, verifyAccessToken } from '../auth/jwt';
import { TokenStateStore } from '../auth/token-state';
import { ForbiddenError, ServiceUnavailableError, UnauthorizedError } from '../errors/app-error';
import { logger } from '../logger/logger';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function readBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/**
 * Builds the authentication middleware. It verifies the Bearer access token and then checks the
 * shared token-state store, so logged-out tokens and tokens issued before a password change /
 * reset / account disable are rejected immediately rather than when they expire.
 *
 * Identity is only ever taken from a signed token, never from client-controlled headers.
 * If the token-state store is unreachable the request is refused (fail closed).
 */
export function createAuthenticate(tokenState: TokenStateStore): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = readBearerToken(req);
      if (!token) {
        throw new UnauthorizedError('Missing Bearer access token');
      }
      const user = verifyAccessToken(token);

      let revoked: boolean;
      try {
        revoked = await tokenState.isAccessTokenRevoked(user.id, user.jti!, user.tokenVersion!);
      } catch (err) {
        logger.error({ err }, 'Token state store unavailable; refusing request');
        throw new ServiceUnavailableError('Authentication temporarily unavailable');
      }
      if (revoked) {
        throw new UnauthorizedError('Access token has been revoked');
      }

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
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
  if (!token || token.length < 32 || /CHANGE_ME/i.test(token)) {
    throw new Error('INTERNAL_SERVICE_TOKEN must be set to a random value of at least 32 characters');
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
