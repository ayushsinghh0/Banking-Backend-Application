import type { Role } from '@/lib/auth/session';

export interface TokenClaims {
  sub: string;
  email: string;
  role: Role;
  mfa: boolean;
  sessionId: string;
  tokenVersion: number;
  exp: number;
  iat: number;
  stepUpAt?: number;
  mfaSince?: number;
}

const base64url = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An unsigned look-alike of a BankSphere access token (the UI only decodes claims; the API verifies) */
export function makeAccessToken(claims: Partial<TokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenClaims = {
    sub: '11111111-1111-4111-8111-111111111111',
    email: 'asha@example.in',
    role: 'CUSTOMER',
    mfa: false,
    sessionId: 'session-1',
    tokenVersion: 0,
    iat: now,
    exp: now + 900,
    ...claims,
  };
  return `${base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test' }))}.${base64url(JSON.stringify(payload))}.signature`;
}
