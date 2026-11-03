import crypto from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { RazorpayErrors } from './errors';

const digest = (value: string) => crypto.createHash('sha256').update(value).digest();

/**
 * Razorpay's API authentication: HTTP Basic with the key id as the user name and the key secret as the
 * password. Both sides are hashed before the comparison so it is constant time whatever the length of
 * what was presented.
 */
export function basicAuth(keyId: string, keySecret: string): RequestHandler {
  const expected = digest(`${keyId}:${keySecret}`);
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const [scheme, encoded, ...rest] = header.split(' ');
    if (scheme?.toLowerCase() !== 'basic' || !encoded || rest.length) return next(RazorpayErrors.unauthorized());
    const presented = digest(Buffer.from(encoded, 'base64').toString('utf8'));
    if (!crypto.timingSafeEqual(presented, expected)) return next(RazorpayErrors.unauthorized());
    next();
  };
}
