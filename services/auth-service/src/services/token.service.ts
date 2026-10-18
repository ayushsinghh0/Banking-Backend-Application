import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '@banksphere/common';

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
}

export interface GeneratedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export class TokenService {
  private readonly accessSecret: string;
  private readonly accessExpiration: string;

  constructor() {
    this.accessSecret =
      process.env.JWT_ACCESS_SECRET || 'banksphere_super_secret_access_jwt_key_2026_x99!';
    this.accessExpiration = process.env.JWT_ACCESS_EXPIRATION || '15m';
  }

  /**
   * Generates a signed JWT access token containing identity claims
   */
  public generateAccessToken(payload: TokenPayload): string {
    return jwt.sign(payload, this.accessSecret, {
      expiresIn: this.accessExpiration as any,
    });
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
  public verifyAccessToken(token: string): TokenPayload {
    try {
      return jwt.verify(token, this.accessSecret) as TokenPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired access token');
    }
  }
}
