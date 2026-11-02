import crypto from 'crypto';
import net from 'net';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthenticatedUser, UserRole, verifyAccessToken } from '../auth/jwt';
import { TokenStateStore } from '../auth/token-state';
import {
  ForbiddenError,
  HttpError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../errors/app-error';
import { logger } from '../logger/logger';
import { isAddressAllowed, staffNetworkError, staffNetworksFromEnv } from '../http/network';
import { tagPolicy } from '../auth/route-policy';

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

export function isStaffRole(role: UserRole): boolean {
  return role !== 'CUSTOMER';
}

export function isStaff(user: AuthenticatedUser): boolean {
  return isStaffRole(user.role);
}

export interface AuthenticateOptions {
  /**
   * Staff sessions must be established with MFA. Only the MFA-enrolment endpoints set this to true,
   * so a staff member without MFA can enrol but cannot use any privileged API.
   */
  allowStaffWithoutMfa?: boolean;
  /** Networks staff may call from; defaults to STAFF_ALLOWED_CIDRS (null = unrestricted) */
  staffNetworks?: net.BlockList | null;
}

/**
 * Builds the authentication middleware. It verifies the Bearer access token and then checks the
 * shared token-state store, so logged-out tokens and tokens issued before a password change /
 * reset / account disable are rejected immediately rather than when they expire.
 *
 * Identity is only ever taken from a signed token, never from client-controlled headers.
 * If the token-state store is unreachable the request is refused (fail closed).
 *
 * When STAFF_ALLOWED_CIDRS is set, every staff token is refused from outside those networks, on every
 * route. This is decided by ROLE, not path: staff actions share prefixes with customer routes
 * (/customers/:id, /accounts/:id/status, /transactions/accounts/:id/history), which the gateway's path
 * allowlist can't tell apart. req.ip is the client: services trust one proxy hop (the gateway), and the
 * gateway overwrites X-Forwarded-For with the client address.
 */
export function createAuthenticate(tokenState: TokenStateStore, options: AuthenticateOptions = {}): RequestHandler {
  const staffNetworks = options.staffNetworks !== undefined ? options.staffNetworks : staffNetworksFromEnv();
  if (staffNetworks === null && options.staffNetworks === undefined && process.env.NODE_ENV === 'production') {
    // Same rule as the gateway: an unset allowlist would open every staff API to the internet
    throw new Error('STAFF_ALLOWED_CIDRS must be set in production (the VPN/office networks staff may work from)');
  }
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = readBearerToken(req);
      if (!token) {
        throw new UnauthorizedError('Missing Bearer access token');
      }
      const user = verifyAccessToken(token);

      let revoked: boolean;
      try {
        revoked = await tokenState.isAccessTokenRevoked({
          userId: user.id,
          jti: user.jti!,
          tokenVersion: user.tokenVersion!,
          sessionId: user.sessionId,
        });
      } catch (err) {
        logger.error({ err }, 'Token state store unavailable; refusing request');
        throw new ServiceUnavailableError('Authentication temporarily unavailable');
      }
      if (revoked) {
        throw new UnauthorizedError('Access token has been revoked');
      }

      if (staffNetworks && isStaff(user) && !isAddressAllowed(staffNetworks, req.ip)) {
        (req.log ?? logger).warn(
          { userId: user.id, role: user.role, path: req.path, alert: 'STAFF_OFF_NETWORK' },
          'Staff token used from a non-allowed network'
        );
        throw staffNetworkError();
      }

      if (isStaff(user) && !user.mfa && !options.allowStaffWithoutMfa) {
        throw new HttpError(
          403,
          'MFA_REQUIRED',
          'Staff accounts must sign in with multi-factor authentication. Enrol at /api/v1/auth/mfa/setup.'
        );
      }

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRoles(...roles: UserRole[]): RequestHandler {
  if (!roles.length) throw new Error('requireRoles() needs at least one role');
  const handler = (req: Request, _res: Response, next: NextFunction): void => {
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
  // Readable by the route-policy tests (see auth/route-policy.ts)
  return tagPolicy(handler, { kind: 'roles', roles });
}

export function getAuthenticatedUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  return req.user;
}

export const INTERNAL_TOKEN_HEADER = 'x-internal-service-token';

/**
 * Reads a service-to-service credential. Each internal API has its own token, shared only between
 * that API and its legitimate callers (e.g. LEDGER_INTERNAL_TOKEN: account-service -> transaction-service),
 * so compromising an unrelated service doesn't grant access to it.
 */
export function getInternalToken(envName: string): string {
  const token = process.env[envName];
  if (!token || token.length < 32 || /CHANGE_ME/i.test(token)) {
    throw new Error(`${envName} must be set to a random value of at least 32 characters`);
  }
  return token;
}

/**
 * Guards a service-to-service router with the named credential. These routes are never exposed
 * through the public gateway; the credential is a second line of defence.
 */
export function requireInternalService(envName: string): RequestHandler {
  const expected = crypto.createHash('sha256').update(getInternalToken(envName)).digest();
  return (req: Request, _res: Response, next: NextFunction): void => {
    const presented = crypto.createHash('sha256').update(req.header(INTERNAL_TOKEN_HEADER) || '').digest();
    if (!crypto.timingSafeEqual(presented, expected)) {
      next(new UnauthorizedError('Invalid internal service credentials'));
      return;
    }
    next();
  };
}
