import crypto, { KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../errors/app-error';

/**
 * CUSTOMER      self-registered bank customer
 * SUPPORT       read-only staff (customer service)
 * TELLER        branch cash operations (maker)
 * KYC_OFFICER   identity verification decisions
 * FRAUD_ANALYST fraud alert triage
 * BANK_ADMIN    supervisor: user/role administration, account status & limits, approvals (checker)
 */
export const ROLES = ['CUSTOMER', 'SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN'] as const;
export type UserRole = (typeof ROLES)[number];

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  /** Unique token id, used for single-token revocation (logout) */
  jti?: string;
  /** User token version at issue time; tokens below the current version are revoked */
  tokenVersion?: number;
  /** Expiry as unix seconds */
  expiresAt?: number;
  /** True when the session was established with a second factor (TOTP) */
  mfa?: boolean;
  /** Session (refresh-token family) id this access token belongs to */
  sessionId?: string;
  /** Unix seconds of the TOTP verification that issued this token (absent on refreshed tokens) */
  stepUpAt?: number;
  /** Unix seconds when the user's current second factor was enrolled */
  mfaSince?: number;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: UserRole;
  tokenVersion: number;
  mfa: boolean;
  sessionId: string;
  stepUpAt?: number;
  mfaSince?: number;
}

/**
 * Strong, RECENT customer authentication for high-risk actions (large transfers, instant payees, large
 * withdrawal codes): a TOTP code verified within `maxAgeSeconds`, on a factor enrolled at least
 * `minFactorAgeSeconds` ago, so neither a stolen long-lived session nor a factor an attacker has just
 * enrolled with a phished password is enough.
 */
export function hasRecentStrongAuth(
  user: AuthenticatedUser,
  opts: { maxAgeSeconds: number; minFactorAgeSeconds: number },
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!user.mfa || user.stepUpAt === undefined || user.mfaSince === undefined) return false;
  return nowSeconds - user.stepUpAt <= opts.maxAgeSeconds && nowSeconds - user.mfaSince >= opts.minFactorAgeSeconds;
}

/**
 * Access tokens are signed with ECDSA P-256 (ES256). Only auth-service holds the private key; every
 * other service gets public keys only, so a compromised service can verify tokens but never mint them.
 *
 *  JWT_SIGNING_KEY      base64 of a PKCS#8 PEM EC private key   (auth-service only)
 *  JWT_SIGNING_KEY_ID   key id written to the token header ("kid")
 *  JWT_VERIFY_KEYS      comma-separated "kid:base64(SPKI PEM)" entries; list the previous key during rotation
 */
const JWT_ALGORITHM = 'ES256';
const JWT_ISSUER = process.env.JWT_ISSUER || 'banksphere-auth';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'banksphere-api';

let cachedVerifyKeys: { source: string; keys: Map<string, KeyObject> } | null = null;
let cachedSigningKey: { source: string; key: KeyObject } | null = null;

function decodePem(b64: string, what: string): string {
  const pem = Buffer.from(b64.trim(), 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN')) {
    throw new Error(`${what} must be a base64-encoded PEM`);
  }
  return pem;
}

export function getVerifyKeys(): Map<string, KeyObject> {
  const source = process.env.JWT_VERIFY_KEYS || '';
  if (cachedVerifyKeys?.source === source) return cachedVerifyKeys.keys;
  if (!source) {
    throw new Error('JWT_VERIFY_KEYS must be set (comma-separated kid:base64-PEM public keys)');
  }
  const keys = new Map<string, KeyObject>();
  for (const entry of source.split(',').map((e) => e.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    if (sep <= 0) throw new Error('JWT_VERIFY_KEYS entries must look like kid:base64pem');
    const kid = entry.slice(0, sep);
    const key = crypto.createPublicKey(decodePem(entry.slice(sep + 1), `JWT_VERIFY_KEYS[${kid}]`));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error(`JWT verify key ${kid} must be an EC P-256 public key`);
    }
    keys.set(kid, key);
  }
  cachedVerifyKeys = { source, keys };
  return keys;
}

function getSigningKey(): { kid: string; key: KeyObject } {
  const source = process.env.JWT_SIGNING_KEY || '';
  const kid = process.env.JWT_SIGNING_KEY_ID || '';
  if (!source || !kid) {
    throw new Error('JWT_SIGNING_KEY and JWT_SIGNING_KEY_ID must be set on the auth service');
  }
  if (cachedSigningKey?.source !== source) {
    const key = crypto.createPrivateKey(decodePem(source, 'JWT_SIGNING_KEY'));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('JWT_SIGNING_KEY must be an EC P-256 private key');
    }
    cachedSigningKey = { source, key };
  }
  return { kid, key: cachedSigningKey.key };
}

/**
 * Fails fast at startup if token verification isn't configured correctly.
 */
export function assertJwtVerificationConfigured(): void {
  if (getVerifyKeys().size === 0) {
    throw new Error('JWT_VERIFY_KEYS contains no keys');
  }
}

/**
 * Fails fast at startup on the auth service: the signing key must exist and its public half
 * must be one of the configured verification keys (under the same kid).
 */
export function assertJwtSigningConfigured(): void {
  const { kid, key } = getSigningKey();
  const pub = getVerifyKeys().get(kid);
  const derived = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (!pub || !crypto.timingSafeEqual(Buffer.from(pub.export({ type: 'spki', format: 'der' })), Buffer.from(derived))) {
    throw new Error(`JWT_VERIFY_KEYS must contain the public key for signing kid '${kid}'`);
  }
}

export function signAccessToken(
  claims: AccessTokenClaims,
  expiresIn: string = process.env.JWT_ACCESS_EXPIRATION || '15m'
): string {
  const { kid, key } = getSigningKey();
  return jwt.sign(
    {
      email: claims.email,
      role: claims.role,
      tv: claims.tokenVersion,
      mfa: claims.mfa,
      sid: claims.sessionId,
      ...(claims.stepUpAt !== undefined ? { sua: claims.stepUpAt } : {}),
      ...(claims.mfaSince !== undefined ? { mfs: claims.mfaSince } : {}),
    },
    key,
    {
      algorithm: JWT_ALGORITHM,
      keyid: kid,
      subject: claims.sub,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      jwtid: crypto.randomUUID(),
      expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
    }
  );
}

/**
 * Verifies signature (key chosen by kid), algorithm, issuer, audience, expiry and claim shape.
 * Revocation is checked separately (see createAuthenticate) because it needs Redis.
 */
export function verifyAccessToken(token: string): AuthenticatedUser {
  let decoded: jwt.JwtPayload;
  try {
    const header = jwt.decode(token, { complete: true })?.header;
    const key = header?.kid ? getVerifyKeys().get(header.kid) : undefined;
    if (!key) throw new Error('unknown kid');
    decoded = jwt.verify(token, key, {
      algorithms: [JWT_ALGORITHM], // Pinned: rejects "none", HS* confusion and any other algorithm
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }

  const role = decoded.role as UserRole;
  if (
    !decoded.sub ||
    typeof decoded.email !== 'string' ||
    !ROLES.includes(role) ||
    typeof decoded.jti !== 'string' ||
    !Number.isInteger(decoded.tv) ||
    typeof decoded.mfa !== 'boolean' ||
    typeof decoded.sid !== 'string' ||
    typeof decoded.exp !== 'number' ||
    (decoded.sua !== undefined && !Number.isInteger(decoded.sua)) ||
    (decoded.mfs !== undefined && !Number.isInteger(decoded.mfs))
  ) {
    throw new UnauthorizedError('Malformed access token claims');
  }

  return {
    id: decoded.sub,
    email: decoded.email,
    role,
    jti: decoded.jti,
    tokenVersion: decoded.tv,
    expiresAt: decoded.exp,
    mfa: decoded.mfa,
    sessionId: decoded.sid,
    stepUpAt: decoded.sua,
    mfaSince: decoded.mfs,
  };
}

/**
 * Generates a fresh ES256 key pair, encoded the way the env variables expect (used by setup scripts).
 */
export function generateJwtKeyPair(): { privateKeyB64: string; publicKeyB64: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKeyB64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    publicKeyB64: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
  };
}
