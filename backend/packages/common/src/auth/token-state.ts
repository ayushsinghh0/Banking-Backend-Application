import Redis from 'ioredis';

/**
 * Server-side state that lets short-lived JWT access tokens be revoked before they expire.
 *
 * - token version: every user has a monotonically increasing version (source of truth in the auth DB,
 *   mirrored here). Tokens carry the version they were issued with; bumping it on password change,
 *   password reset or account disable instantly invalidates every outstanding access token.
 * - jti denylist: logout revokes the single access token presented, until it would have expired anyway.
 * - session denylist: when a session (refresh-token family) is ended - logout, or refresh-token reuse
 *   i.e. suspected theft - every access token of that session stops working at once, not at expiry.
 */
export interface AccessTokenRef {
  userId: string;
  jti: string;
  tokenVersion: number;
  sessionId?: string;
}

export interface TokenStateStore {
  isAccessTokenRevoked(token: AccessTokenRef): Promise<boolean>;
  setTokenVersion(userId: string, tokenVersion: number): Promise<void>;
  /** Bulk form of setTokenVersion (one round trip), used by the periodic DB -> Redis sync */
  setTokenVersions?(versions: Array<{ userId: string; tokenVersion: number }>): Promise<void>;
  revokeJti(jti: string, ttlSeconds: number): Promise<void>;
  revokeSession(sessionId: string, ttlSeconds: number): Promise<void>;
}

const VERSION_KEY = (userId: string) => `auth:tv:${userId}`;
const JTI_KEY = (jti: string) => `auth:revoked-jti:${jti}`;
const SESSION_KEY = (sessionId: string) => `auth:revoked-sid:${sessionId}`;
// Only ever moves the version forward, so a stale writer can never resurrect revoked tokens
const SET_VERSION_SCRIPT = `local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
       if tonumber(ARGV[1]) > cur then redis.call('SET', KEYS[1], ARGV[1]) end
       return 1`;

export class RedisTokenStateStore implements TokenStateStore {
  constructor(private readonly redis: Redis) {}

  public async isAccessTokenRevoked(token: AccessTokenRef): Promise<boolean> {
    const keys = [VERSION_KEY(token.userId), JTI_KEY(token.jti), ...(token.sessionId ? [SESSION_KEY(token.sessionId)] : [])];
    const [currentVersion, revokedJti, revokedSession] = await this.redis.mget(...keys);
    if (revokedJti || revokedSession) return true;
    return token.tokenVersion < Number(currentVersion ?? 0);
  }

  public async setTokenVersion(userId: string, tokenVersion: number): Promise<void> {
    // No expiry: this is a mirror of the DB value and must survive as long as the user exists.
    await this.redis.eval(SET_VERSION_SCRIPT, 1, VERSION_KEY(userId), String(tokenVersion));
  }

  public async setTokenVersions(versions: Array<{ userId: string; tokenVersion: number }>): Promise<void> {
    if (!versions.length) return;
    const pipeline = this.redis.pipeline();
    for (const v of versions) pipeline.eval(SET_VERSION_SCRIPT, 1, VERSION_KEY(v.userId), String(v.tokenVersion));
    const failed = (await pipeline.exec())?.find(([err]) => err);
    if (failed) throw failed[0];
  }

  public async revokeJti(jti: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.redis.set(JTI_KEY(jti), '1', 'EX', Math.ceil(ttlSeconds));
  }

  public async revokeSession(sessionId: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.redis.set(SESSION_KEY(sessionId), '1', 'EX', Math.ceil(ttlSeconds));
  }
}

/**
 * In-process implementation for unit tests only.
 */
export class InMemoryTokenStateStore implements TokenStateStore {
  private readonly versions = new Map<string, number>();
  private readonly revoked = new Set<string>();
  private readonly revokedSessions = new Set<string>();

  public async isAccessTokenRevoked(token: AccessTokenRef): Promise<boolean> {
    return (
      this.revoked.has(token.jti) ||
      (token.sessionId !== undefined && this.revokedSessions.has(token.sessionId)) ||
      token.tokenVersion < (this.versions.get(token.userId) ?? 0)
    );
  }

  public async setTokenVersion(userId: string, tokenVersion: number): Promise<void> {
    this.versions.set(userId, Math.max(tokenVersion, this.versions.get(userId) ?? 0));
  }

  public async setTokenVersions(versions: Array<{ userId: string; tokenVersion: number }>): Promise<void> {
    for (const v of versions) this.versions.set(v.userId, Math.max(v.tokenVersion, this.versions.get(v.userId) ?? 0));
  }

  public async revokeJti(jti: string): Promise<void> {
    this.revoked.add(jti);
  }

  public async revokeSession(sessionId: string): Promise<void> {
    this.revokedSessions.add(sessionId);
  }
}
