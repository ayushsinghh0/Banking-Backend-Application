import crypto from 'crypto';
import { signAccessToken, verifyAccessToken, AuthenticatedUser, UserRole } from '@banksphere/common';

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  tokenVersion: number;
  mfa: boolean;
  sessionId: string;
  stepUpAt?: number;
  mfaSince?: number;
}

export interface GeneratedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

function durationToSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration '${value}', expected e.g. 15m, 1h, 7d`);
  }
  return Number(match[1]) * DURATION_UNITS[match[2]];
}

export class TokenService {
  private readonly accessExpiration: string;
  public readonly accessTokenTtlSeconds: number;
  public readonly refreshTokenTtlMs: number;

  constructor() {
    this.accessExpiration = process.env.JWT_ACCESS_EXPIRATION || '15m';
    this.accessTokenTtlSeconds = durationToSeconds(this.accessExpiration);
    const refreshDays = Number(process.env.JWT_REFRESH_EXPIRATION_DAYS || 7);
    this.refreshTokenTtlMs = refreshDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Generates a signed JWT access token containing identity claims
   */
  public generateAccessToken(payload: TokenPayload): string {
    return signAccessToken(
      {
        sub: payload.userId,
        email: payload.email,
        role: payload.role as UserRole,
        tokenVersion: payload.tokenVersion,
        mfa: payload.mfa,
        sessionId: payload.sessionId,
        stepUpAt: payload.stepUpAt,
        mfaSince: payload.mfaSince,
      },
      this.accessExpiration
    );
  }

  /**
   * Generates a cryptographically random refresh token
   */
  public generateRawRefreshToken(): string {
    return crypto.randomBytes(40).toString('hex');
  }

  /**
   * Hashes a raw refresh token using SHA-256 for secure database storage
   */
  public hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Verifies and decodes an access token
   */
  public verifyAccessToken(token: string): AuthenticatedUser {
    return verifyAccessToken(token);
  }
}
