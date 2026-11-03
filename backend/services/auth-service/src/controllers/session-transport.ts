import { Request, Response } from 'express';
import { parseCookies, serializeCookie } from '@banksphere/common';
import { GeneratedTokens } from '../services/token.service';

/**
 * Browser clients opt in to keeping the refresh token in an HttpOnly cookie with the header
 * `X-Session-Transport: cookie`; every other client keeps receiving and sending it in JSON bodies.
 * Script on the page can then never read the refresh token, and the cookie is only sent to the auth routes,
 * same-site, on requests that carry that custom header (which a cross-site form can't add).
 */
export const SESSION_COOKIE = 'bs_rt';
const SESSION_COOKIE_PATH = '/api/v1/auth';

export interface TokenBody {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
}

export function wantsCookieTransport(req: Request): boolean {
  return (req.header('x-session-transport') || '').trim().toLowerCase() === 'cookie';
}

export function readSessionCookie(req: Request): string | undefined {
  return parseCookies(req.header('cookie'))[SESSION_COOKIE] || undefined;
}

/** AUTH_COOKIE_SECURE=false drops Secure (browsers already treat http://localhost as secure, so rarely needed) */
const cookieOptions = (maxAgeSeconds: number) => ({
  maxAgeSeconds,
  path: SESSION_COOKIE_PATH,
  httpOnly: true,
  secure: process.env.AUTH_COOKIE_SECURE !== 'false',
  sameSite: 'Strict' as const,
});

export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', cookieOptions(0)));
}

/**
 * The token part of a response body, built field by field so nothing internal can leak into it. With cookie
 * transport the refresh token goes into the cookie instead, for exactly as long as it can be used (the refresh
 * TTL, capped by the remaining absolute session lifetime).
 */
export function issueTokens(req: Request, res: Response, tokens: GeneratedTokens): TokenBody {
  if (!wantsCookieTransport(req)) {
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresInSeconds: tokens.expiresInSeconds };
  }
  const maxAgeSeconds = (tokens.refreshExpiresAt.getTime() - Date.now()) / 1000;
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, tokens.refreshToken, cookieOptions(maxAgeSeconds)));
  return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
}
