import crypto from 'crypto';
import Redis from 'ioredis';
import { ServiceUnavailableError } from '@banksphere/common';

/**
 * Per-account abuse controls.
 *
 * Login lockout is keyed on (email, client network) with a much higher per-email ceiling:
 * - a password-guessing attacker gets LOGIN_MAX_FAILURES tries per network, then a lock;
 * - when the per-email ceiling trips (a distributed attack), networks from which the user has signed in
 *   successfully before are still let through, so the attack can't lock the real customer out.
 * The attempt is counted BEFORE the password is checked (atomic INCR); a successful login refunds it.
 *
 * MFA challenges allow a fixed number of attempts, counted atomically BEFORE the code is verified, and a
 * per-user TOTP failure budget (not reset by a correct password) stops brute force across challenges. Every
 * TOTP check reserves one unit of that budget BEFORE verifying (atomic INCR), so concurrent guesses can't all
 * pass a "not locked yet" check; a correct code clears it.
 *
 * Storage: high-churn counters live in the evictable rate-limit Redis (so a spray of random emails can't
 * fill the security Redis); challenges and known networks live in the durable security Redis.
 * Keys use a hash of the normalised email so raw addresses aren't stored.
 */
export interface LoginAttempt {
  locked: boolean;
  /** The per-email ceiling tripped and this network is not a known one: step-up required */
  stepUpRequired?: boolean;
}

export interface AuthSecurityStore {
  beginLoginAttempt(email: string, network: string): Promise<LoginAttempt>;
  loginSucceeded(email: string, network: string): Promise<void>;
  clearAllLoginFailures(email: string): Promise<void>;
  /** Returns true if another email of this kind may be sent to this address now */
  consumeEmailQuota(kind: string, email: string): Promise<boolean>;
  /** A challenge remembers the token version at password time, so a reset in between invalidates it */
  createMfaChallenge(userId: string, tokenVersion: number, ttlSeconds: number): Promise<string>;
  /** Atomically counts an attempt; returns the challenge if it is valid and under its limit */
  consumeMfaChallengeAttempt(token: string): Promise<MfaChallenge | null>;
  deleteMfaChallenge(token: string): Promise<void>;
  /**
   * Counts a TOTP attempt against the user's hourly failure budget before the code is checked. The
   * reservation stands as a failure unless the code is correct (then clearMfaFailures).
   */
  reserveMfaAttempt(userId: string): Promise<MfaAttemptReservation>;
  clearMfaFailures(userId: string): Promise<void>;
}

export interface MfaAttemptReservation {
  /** False when the budget is already spent: refuse without checking the code */
  allowed: boolean;
  /** This attempt is the last one in the budget: if it fails, TOTP is locked for the user */
  last: boolean;
}

export interface MfaChallenge {
  userId: string;
  tokenVersion: number;
}

export interface AuthSecurityConfig {
  maxLoginFailures: number;
  globalMaxLoginFailures: number;
  lockoutSeconds: number;
  emailsPerHour: number;
  maxMfaAttempts: number;
  maxMfaFailuresPerHour: number;
}

export const defaultAuthSecurityConfig = (): AuthSecurityConfig => ({
  maxLoginFailures: Number(process.env.LOGIN_MAX_FAILURES || 5),
  globalMaxLoginFailures: Number(process.env.LOGIN_GLOBAL_MAX_FAILURES || 100),
  lockoutSeconds: Number(process.env.LOGIN_LOCKOUT_SECONDS || 900),
  emailsPerHour: Number(process.env.AUTH_EMAILS_PER_HOUR || 3),
  maxMfaAttempts: 5,
  maxMfaFailuresPerHour: Number(process.env.MFA_MAX_FAILURES_PER_HOUR || 10),
});

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const emailKey = (email: string) => hash(email.trim().toLowerCase());
const KNOWN_NETWORK_TTL = 90 * 24 * 3600;

export class RedisAuthSecurityStore implements AuthSecurityStore {
  /**
   * @param counters evictable rate-limit Redis (lockout counters, quotas, TOTP failure counts)
   * @param state    durable security Redis (MFA challenges, known networks)
   */
  constructor(
    private readonly counters: Redis,
    private readonly state: Redis,
    private readonly config: AuthSecurityConfig = defaultAuthSecurityConfig()
  ) {}

  private pairKey(email: string, network: string) {
    return `auth:login-fail:${emailKey(email)}:${hash(network)}`;
  }
  private globalKey(email: string) {
    return `auth:login-fail-global:${emailKey(email)}`;
  }
  private knownKey(email: string) {
    return `auth:known-net:${emailKey(email)}`;
  }

  public async beginLoginAttempt(email: string, network: string): Promise<LoginAttempt> {
    const pair = this.pairKey(email, network);
    const global = this.globalKey(email);
    const results = await this.counters
      .multi()
      .incr(pair)
      .expire(pair, this.config.lockoutSeconds, 'NX')
      .incr(global)
      .expire(global, 3600, 'NX')
      .exec();
    const pairCount = Number(results?.[0]?.[1] ?? 0);
    const globalCount = Number(results?.[2]?.[1] ?? 0);
    if (pairCount > this.config.maxLoginFailures) return { locked: true };
    if (globalCount > this.config.globalMaxLoginFailures) {
      const known = await this.state.sismember(this.knownKey(email), hash(network));
      if (!known) return { locked: true, stepUpRequired: true };
    }
    return { locked: false };
  }

  public async loginSucceeded(email: string, network: string): Promise<void> {
    // Refund this attempt, forget this network's failures and remember it as a known network
    await this.counters.multi().del(this.pairKey(email, network)).decr(this.globalKey(email)).exec();
    await this.state.multi().sadd(this.knownKey(email), hash(network)).expire(this.knownKey(email), KNOWN_NETWORK_TTL).exec();
  }

  public async clearAllLoginFailures(email: string): Promise<void> {
    const prefix = `auth:login-fail:${emailKey(email)}:`;
    let cursor = '0';
    do {
      const [next, keys] = await this.counters.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      if (keys.length) await this.counters.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    await this.counters.del(this.globalKey(email));
  }

  public async consumeEmailQuota(kind: string, email: string): Promise<boolean> {
    const key = `auth:mail-quota:${kind}:${emailKey(email)}`;
    const results = await this.counters.multi().incr(key).expire(key, 3600, 'NX').exec();
    return Number(results?.[0]?.[1] ?? 0) <= this.config.emailsPerHour;
  }

  public async createMfaChallenge(userId: string, tokenVersion: number, ttlSeconds: number): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    const key = `auth:mfa-challenge:${hash(token)}`;
    await this.state.multi().hset(key, 'userId', userId, 'tv', String(tokenVersion), 'attempts', '0').expire(key, ttlSeconds).exec();
    return token;
  }

  public async consumeMfaChallengeAttempt(token: string): Promise<MfaChallenge | null> {
    // Increment-then-check in one atomic step: parallel requests can't all see "0 attempts"
    const result = (await this.state.eval(
      `if redis.call('EXISTS', KEYS[1]) == 0 then return false end
       local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
       if n > tonumber(ARGV[1]) then return false end
       return redis.call('HMGET', KEYS[1], 'userId', 'tv')`,
      1,
      `auth:mfa-challenge:${hash(token)}`,
      String(this.config.maxMfaAttempts)
    )) as [string | null, string | null] | null;
    if (!result || !result[0] || result[1] === null) return null;
    return { userId: result[0], tokenVersion: Number(result[1]) };
  }

  public async deleteMfaChallenge(token: string): Promise<void> {
    await this.state.del(`auth:mfa-challenge:${hash(token)}`);
  }

  public async reserveMfaAttempt(userId: string): Promise<MfaAttemptReservation> {
    const key = `auth:mfa-fail:${userId}`;
    const results = await this.counters.multi().incr(key).expire(key, 3600, 'NX').exec();
    const count = Number(results?.[0]?.[1]);
    // Fail closed: an attempt that couldn't be counted is never verified
    if (!Number.isInteger(count) || count < 1) throw new ServiceUnavailableError('Verification temporarily unavailable');
    return { allowed: count <= this.config.maxMfaFailuresPerHour, last: count === this.config.maxMfaFailuresPerHour };
  }

  public async clearMfaFailures(userId: string): Promise<void> {
    await this.counters.del(`auth:mfa-fail:${userId}`);
  }
}

export class InMemoryAuthSecurityStore implements AuthSecurityStore {
  private readonly pairs = new Map<string, number>();
  private readonly globals = new Map<string, number>();
  private readonly known = new Map<string, Set<string>>();
  private readonly quotas = new Map<string, number>();
  private readonly challenges = new Map<string, { userId: string; tokenVersion: number; attempts: number }>();
  private readonly mfaFailures = new Map<string, number>();

  constructor(
    private readonly config: AuthSecurityConfig = {
      maxLoginFailures: 5,
      globalMaxLoginFailures: 100,
      lockoutSeconds: 900,
      emailsPerHour: 3,
      maxMfaAttempts: 5,
      maxMfaFailuresPerHour: 10,
    }
  ) {}

  public async beginLoginAttempt(email: string, network: string): Promise<LoginAttempt> {
    const ek = emailKey(email);
    const p = (this.pairs.get(`${ek}:${network}`) ?? 0) + 1;
    const g = (this.globals.get(ek) ?? 0) + 1;
    this.pairs.set(`${ek}:${network}`, p);
    this.globals.set(ek, g);
    if (p > this.config.maxLoginFailures) return { locked: true };
    if (g > this.config.globalMaxLoginFailures && !this.known.get(ek)?.has(network)) {
      return { locked: true, stepUpRequired: true };
    }
    return { locked: false };
  }

  public async loginSucceeded(email: string, network: string): Promise<void> {
    const ek = emailKey(email);
    this.pairs.delete(`${ek}:${network}`);
    this.globals.set(ek, Math.max(0, (this.globals.get(ek) ?? 1) - 1));
    if (!this.known.has(ek)) this.known.set(ek, new Set());
    this.known.get(ek)!.add(network);
  }

  public async clearAllLoginFailures(email: string): Promise<void> {
    const ek = emailKey(email);
    for (const k of [...this.pairs.keys()]) if (k.startsWith(`${ek}:`)) this.pairs.delete(k);
    this.globals.delete(ek);
  }

  public async consumeEmailQuota(kind: string, email: string): Promise<boolean> {
    const key = `${kind}:${emailKey(email)}`;
    const next = (this.quotas.get(key) ?? 0) + 1;
    this.quotas.set(key, next);
    return next <= this.config.emailsPerHour;
  }

  public async createMfaChallenge(userId: string, tokenVersion: number, _ttlSeconds?: number): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    this.challenges.set(hash(token), { userId, tokenVersion, attempts: 0 });
    return token;
  }

  public async consumeMfaChallengeAttempt(token: string): Promise<MfaChallenge | null> {
    const c = this.challenges.get(hash(token));
    if (!c) return null;
    c.attempts++;
    return c.attempts <= this.config.maxMfaAttempts ? { userId: c.userId, tokenVersion: c.tokenVersion } : null;
  }

  public async deleteMfaChallenge(token: string): Promise<void> {
    this.challenges.delete(hash(token));
  }

  public async reserveMfaAttempt(userId: string): Promise<MfaAttemptReservation> {
    const n = (this.mfaFailures.get(userId) ?? 0) + 1;
    this.mfaFailures.set(userId, n);
    return { allowed: n <= this.config.maxMfaFailuresPerHour, last: n === this.config.maxMfaFailuresPerHour };
  }

  public async clearMfaFailures(userId: string): Promise<void> {
    this.mfaFailures.delete(userId);
  }
}
