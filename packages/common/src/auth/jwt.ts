import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../errors/app-error';

export const ROLES = ['CUSTOMER', 'BANK_ADMIN', 'SUPPORT'] as const;
export type UserRole = (typeof ROLES)[number];

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: UserRole;
}

const JWT_ALGORITHM = 'HS256';
const JWT_ISSUER = process.env.JWT_ISSUER || 'banksphere-auth';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'banksphere-api';
const MIN_SECRET_LENGTH = 32;

/**
 * Reads the access-token signing secret. There is deliberately no fallback value:
 * a missing or weak secret must stop the service from starting rather than silently
 * signing tokens with a value that is public in the repository.
 */
export function getJwtAccessSecret(): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_ACCESS_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters long`
    );
  }
  return secret;
}

export function signAccessToken(
  claims: AccessTokenClaims,
  expiresIn: string = process.env.JWT_ACCESS_EXPIRATION || '15m'
): string {
  const { sub, ...rest } = claims;
  return jwt.sign(rest, getJwtAccessSecret(), {
    algorithm: JWT_ALGORITHM,
    subject: sub,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AuthenticatedUser {
  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, getJwtAccessSecret(), {
      algorithms: [JWT_ALGORITHM], // Pin the algorithm: rejects "none" and algorithm-confusion tokens
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }

  const role = decoded.role as UserRole;
  if (!decoded.sub || typeof decoded.email !== 'string' || !ROLES.includes(role)) {
    throw new UnauthorizedError('Malformed access token claims');
  }

  return { id: decoded.sub, email: decoded.email, role };
}
