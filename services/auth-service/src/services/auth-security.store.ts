import crypto from 'crypto';
import Redis from 'ioredis';

/**
 * Per-account abuse controls kept in Redis:
 * - failed-login counter -> temporary lockout (defeats distributed brute force that per-IP limits miss)
 * - per-email quota for outbound auth emails (prevents mail-bombing a victim via forgot-password)
 *
 * Keys use a hash of the normalised email so raw addresses aren't stored in Redis.
 */
export interface AuthSecurityStore {
  isLoginLocked(email: string): Promise<boolean>;
  recordLoginFailure(email: string): Promise<number>;
  clearLoginFailures(email: string): Promise<void>;
  /** Returns true if another email of this kind may be sent to this address now */
  consumeEmailQuota(kind: string, email: string): Promise<boolean>;
}

export interface AuthSecurityConfig {
  maxLoginFailures: number;
  lockoutSeconds: number;
  emailsPerHour: number;
}

export const defaultAuthSecurityConfig = (): AuthSecurityConfig => ({
  maxLoginFailures: Number(process.env.LOGIN_MAX_FAILURES || 5),
  lockoutSeconds: Number(process.env.LOGIN_LOCKOUT_SECONDS || 900),
  emailsPerHour: Number(process.env.AUTH_EMAILS_PER_HOUR || 3),
});

const emailKey = (email: string) =>
  crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

export class RedisAuthSecurityStore implements AuthSecurityStore {
  constructor(
    private readonly redis: Redis,
    private readonly config: AuthSecurityConfig = defaultAuthSecurityConfig()
  ) {}

  public async isLoginLocked(email: string): Promise<boolean> {
    const count = await this.redis.get(`auth:login-fail:${emailKey(email)}`);
    return Number(count ?? 0) >= this.config.maxLoginFailures;
  }

  public async recordLoginFailure(email: string): Promise<number> {
    const key = `auth:login-fail:${emailKey(email)}`;
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, this.config.lockoutSeconds, 'NX')
      .exec();
    return Number(results?.[0]?.[1] ?? 0);
  }

  public async clearLoginFailures(email: string): Promise<void> {
    await this.redis.del(`auth:login-fail:${emailKey(email)}`);
  }

  public async consumeEmailQuota(kind: string, email: string): Promise<boolean> {
    const key = `auth:mail-quota:${kind}:${emailKey(email)}`;
    const results = await this.redis.multi().incr(key).expire(key, 3600, 'NX').exec();
    return Number(results?.[0]?.[1] ?? 0) <= this.config.emailsPerHour;
  }
}

export class InMemoryAuthSecurityStore implements AuthSecurityStore {
  private readonly failures = new Map<string, number>();
  private readonly quotas = new Map<string, number>();

  constructor(private readonly config: AuthSecurityConfig = { maxLoginFailures: 5, lockoutSeconds: 900, emailsPerHour: 3 }) {}

  public async isLoginLocked(email: string): Promise<boolean> {
    return (this.failures.get(emailKey(email)) ?? 0) >= this.config.maxLoginFailures;
  }

  public async recordLoginFailure(email: string): Promise<number> {
    const next = (this.failures.get(emailKey(email)) ?? 0) + 1;
    this.failures.set(emailKey(email), next);
    return next;
  }

  public async clearLoginFailures(email: string): Promise<void> {
    this.failures.delete(emailKey(email));
  }

  public async consumeEmailQuota(kind: string, email: string): Promise<boolean> {
    const key = `${kind}:${emailKey(email)}`;
    const next = (this.quotas.get(key) ?? 0) + 1;
    this.quotas.set(key, next);
    return next <= this.config.emailsPerHour;
  }
}
