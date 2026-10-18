import Redis from 'ioredis';

/**
 * Server-side state that lets short-lived JWT access tokens be revoked before they expire.
 *
 * - token version: every user has a monotonically increasing version (source of truth in the auth DB,
 *   mirrored here). Tokens carry the version they were issued with; bumping it on password change,
 *   password reset or account disable instantly invalidates every outstanding access token.
 * - jti denylist: logout revokes the single access token presented, until it would have expired anyway.
 */
export interface TokenStateStore {
  isAccessTokenRevoked(userId: string, jti: string, tokenVersion: number): Promise<boolean>;
  setTokenVersion(userId: string, tokenVersion: number): Promise<void>;
  revokeJti(jti: string, ttlSeconds: number): Promise<void>;
}

const VERSION_KEY = (userId: string) => `auth:tv:${userId}`;
const JTI_KEY = (jti: string) => `auth:revoked-jti:${jti}`;

export class RedisTokenStateStore implements TokenStateStore {
  constructor(private readonly redis: Redis) {}

  public async isAccessTokenRevoked(userId: string, jti: string, tokenVersion: number): Promise<boolean> {
    const [currentVersion, revokedJti] = await this.redis.mget(VERSION_KEY(userId), JTI_KEY(jti));
    if (revokedJti) return true;
    return tokenVersion < Number(currentVersion ?? 0);
  }

  public async setTokenVersion(userId: string, tokenVersion: number): Promise<void> {
    // No expiry: this is a mirror of the DB value and must survive as long as the user exists.
    // Only ever move forward, so a stale writer can never resurrect revoked tokens.
    await this.redis.eval(
      `local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
       if tonumber(ARGV[1]) > cur then redis.call('SET', KEYS[1], ARGV[1]) end
       return 1`,
      1,
      VERSION_KEY(userId),
      String(tokenVersion)
    );
  }

  public async revokeJti(jti: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.redis.set(JTI_KEY(jti), '1', 'EX', Math.ceil(ttlSeconds));
  }
}

/**
 * In-process implementation for unit tests only.
 */
export class InMemoryTokenStateStore implements TokenStateStore {
  private readonly versions = new Map<string, number>();
  private readonly revoked = new Set<string>();

  public async isAccessTokenRevoked(userId: string, jti: string, tokenVersion: number): Promise<boolean> {
    return this.revoked.has(jti) || tokenVersion < (this.versions.get(userId) ?? 0);
  }

  public async setTokenVersion(userId: string, tokenVersion: number): Promise<void> {
    this.versions.set(userId, Math.max(tokenVersion, this.versions.get(userId) ?? 0));
  }

  public async revokeJti(jti: string): Promise<void> {
    this.revoked.add(jti);
  }
}
