import crypto from 'crypto';
import Redis from 'ioredis';

/**
 * Per-account abuse controls kept in Redis.
 *
 * Login lockout is keyed on (email, client network) with a much higher per-email ceiling:
 * - a password-guessing attacker gets LOGIN_MAX_FAILURES tries per network (then a lock),
 * - but cannot lock the real customer out from *their* network unless they mount a large distributed
 *   attack (LOGIN_GLOBAL_MAX_FAILURES per hour across all networks), which is also an alerting signal.
 * The attempt is counted BEFORE the password is checked (atomic INCR), so concurrent bursts cannot
 * squeeze extra guesses past the limit; a successful login refunds it.
 *
 * Keys use a hash of the normalised email so raw addresses aren't stored in Redis.
 */
export interface LoginAttempt {
  locked: boolean;
}

export interface AuthSecurityStore {
  beginLoginAttempt(email: string, network: string): Promise<LoginAttempt>;
  loginSucceeded(email: string, network: string): Promise<void>;
  clearAllLoginFailures(email: string): Promise<void>;
  /** Returns true if another email of this kind may be sent to this address now */
  consumeEmailQuota(kind: string, email: string): Promise<boolean>;
  /** MFA login challenges: short-lived, single-use, limited attempts */
  createMfaChallenge(userId: string, ttlSeconds: number): Promise<string>;
  /** Returns the user id while the challenge is valid and under its attempt limit */
  peekMfaChallenge(token: string): Promise<string | null>;
  recordMfaChallengeFailure(token: string): Promise<void>;
  deleteMfaChallenge(token: string): Promise<void>;
}

export interface AuthSecurityConfig {
  maxLoginFailures: number;
  globalMaxLoginFailures: number;
  lockoutSeconds: number;
  emailsPerHour: number;
  maxMfaAttempts: number;
}

export const defaultAuthSecurityConfig = (): AuthSecurityConfig => ({
  maxLoginFailures: Number(process.env.LOGIN_MAX_FAILURES || 5),
  globalMaxLoginFailures: Number(process.env.LOGIN_GLOBAL_MAX_FAILURES || 100),
  lockoutSeconds: Number(process.env.LOGIN_LOCKOUT_SECONDS || 900),
  emailsPerHour: Number(process.env.AUTH_EMAILS_PER_HOUR || 3),
  maxMfaAttempts: 5,
});

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const emailKey = (email: string) => hash(email.trim().toLowerCase());

export class RedisAuthSecurityStore implements AuthSecurityStore {
  constructor(
    private readonly redis: Redis,
    private readonly config: AuthSecurityConfig = defaultAuthSecurityConfig()
  ) {}

  private pairKey(email: string, network: string) {
    return `auth:login-fail:${emailKey(email)}:${hash(network)}`;
  }
  private globalKey(email: string) {
    return `auth:login-fail-global:${emailKey(email)}`;
  }

  public async beginLoginAttempt(email: string, network: string): Promise<LoginAttempt> {
    const pair = this.pairKey(email, network);
    const global = this.globalKey(email);
    const results = await this.redis
      .multi()
      .incr(pair)
      .expire(pair, this.config.lockoutSeconds, 'NX')
      .incr(global)
      .expire(global, 3600, 'NX')
      .exec();
    const pairCount = Number(results?.[0]?.[1] ?? 0);
    const globalCount = Number(results?.[2]?.[1] ?? 0);
    return {
      locked: pairCount > this.config.maxLoginFailures || globalCount > this.config.globalMaxLoginFailures,
    };
  }

  public async loginSucceeded(email: string, network: string): Promise<void> {
    // Refund this attempt and forget this network's failures
    await this.redis.multi().del(this.pairKey(email, network)).decr(this.globalKey(email)).exec();
  }

  public async clearAllLoginFailures(email: string): Promise<void> {
    const prefix = `auth:login-fail:${emailKey(email)}:`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      if (keys.length) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    await this.redis.del(this.globalKey(email));
  }

  public async consumeEmailQuota(kind: string, email: string): Promise<boolean> {
    const key = `auth:mail-quota:${kind}:${emailKey(email)}`;
    const results = await this.redis.multi().incr(key).expire(key, 3600, 'NX').exec();
    return Number(results?.[0]?.[1] ?? 0) <= this.config.emailsPerHour;
  }

  public async createMfaChallenge(userId: string, ttlSeconds: number): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.redis.set(`auth:mfa-challenge:${hash(token)}`, JSON.stringify({ userId, failures: 0 }), 'EX', ttlSeconds);
    return token;
  }

  public async peekMfaChallenge(token: string): Promise<string | null> {
    const raw = await this.redis.get(`auth:mfa-challenge:${hash(token)}`);
    if (!raw) return null;
    const { userId, failures } = JSON.parse(raw) as { userId: string; failures: number };
    return failures < this.config.maxMfaAttempts ? userId : null;
  }

  public async recordMfaChallengeFailure(token: string): Promise<void> {
    const key = `auth:mfa-challenge:${hash(token)}`;
    // Atomic read-modify-write that preserves the TTL
    await this.redis.eval(
      `local v = redis.call('GET', KEYS[1])
       if not v then return 0 end
       local o = cjson.decode(v)
       o.failures = o.failures + 1
       redis.call('SET', KEYS[1], cjson.encode(o), 'KEEPTTL')
       return o.failures`,
      1,
      key
    );
  }

  public async deleteMfaChallenge(token: string): Promise<void> {
    await this.redis.del(`auth:mfa-challenge:${hash(token)}`);
  }
}

export class InMemoryAuthSecurityStore implements AuthSecurityStore {
  private readonly pairs = new Map<string, number>();
  private readonly globals = new Map<string, number>();
  private readonly quotas = new Map<string, number>();
  private readonly challenges = new Map<string, { userId: string; failures: number }>();

  constructor(
    private readonly config: AuthSecurityConfig = {
      maxLoginFailures: 5,
      globalMaxLoginFailures: 100,
      lockoutSeconds: 900,
      emailsPerHour: 3,
      maxMfaAttempts: 5,
    }
  ) {}

  public async beginLoginAttempt(email: string, network: string): Promise<LoginAttempt> {
    const pk = `${emailKey(email)}:${network}`;
    const p = (this.pairs.get(pk) ?? 0) + 1;
    const g = (this.globals.get(emailKey(email)) ?? 0) + 1;
    this.pairs.set(pk, p);
    this.globals.set(emailKey(email), g);
    return { locked: p > this.config.maxLoginFailures || g > this.config.globalMaxLoginFailures };
  }

  public async loginSucceeded(email: string, network: string): Promise<void> {
    this.pairs.delete(`${emailKey(email)}:${network}`);
    this.globals.set(emailKey(email), Math.max(0, (this.globals.get(emailKey(email)) ?? 1) - 1));
  }

  public async clearAllLoginFailures(email: string): Promise<void> {
    for (const k of [...this.pairs.keys()]) if (k.startsWith(`${emailKey(email)}:`)) this.pairs.delete(k);
    this.globals.delete(emailKey(email));
  }

  public async consumeEmailQuota(kind: string, email: string): Promise<boolean> {
    const key = `${kind}:${emailKey(email)}`;
    const next = (this.quotas.get(key) ?? 0) + 1;
    this.quotas.set(key, next);
    return next <= this.config.emailsPerHour;
  }

  public async createMfaChallenge(userId: string, _ttlSeconds?: number): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    this.challenges.set(hash(token), { userId, failures: 0 });
    return token;
  }

  public async peekMfaChallenge(token: string): Promise<string | null> {
    const c = this.challenges.get(hash(token));
    return c && c.failures < this.config.maxMfaAttempts ? c.userId : null;
  }

  public async recordMfaChallengeFailure(token: string): Promise<void> {
    const c = this.challenges.get(hash(token));
    if (c) c.failures++;
  }

  public async deleteMfaChallenge(token: string): Promise<void> {
    this.challenges.delete(hash(token));
  }
}
