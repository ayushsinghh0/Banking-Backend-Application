import Redis from 'ioredis';
import { GcraLimiter, GcraRule, logger } from '@banksphere/common';

/**
 * The two per-user guardrails on messages (design section 7): a GCRA message rate and a daily token budget for the
 * model, both on the cache Redis so every replica sees the same counters. The cache Redis ACL grants this service
 * `rl:assistant:*` for them (docker/redis/cache-start.sh). Without CACHE_REDIS_URL (unit tests, native
 * development) an in-memory implementation applies the same rules to one replica.
 */
export const LIMITS_KEY_PREFIX = 'rl:assistant:';
export const MESSAGE_RULE_NAME = 'messages';
/** A day's budget counter outlives its day by a margin, then expires on its own */
const BUDGET_TTL_SECONDS = 2 * 86_400;

export interface LimitSettings {
  rate: { limit: number; periodMs: number; burst: number };
  dailyTokenBudget: number;
}

export interface RateDecision {
  allowed: boolean;
  /** When refused: ms until the next message is allowed */
  retryAfterMs: number;
}

/** unknown: the counter couldn't be read, so spending can't be accounted for */
export type BudgetState = 'ok' | 'exhausted' | 'unknown';

export interface BudgetDecision {
  state: BudgetState;
  usedTokens: number;
}

export interface TurnLimits {
  checkRate(userId: string): Promise<RateDecision>;
  /** `day` is the IST calendar day (YYYY-MM-DD) the budget belongs to */
  checkBudget(userId: string, day: string): Promise<BudgetDecision>;
  recordTokens(userId: string, day: string, tokens: number): Promise<void>;
}

const budgetKey = (day: string, userId: string) => `${LIMITS_KEY_PREFIX}budget:${day}:${userId}`;

function ruleOf(settings: LimitSettings): GcraRule {
  return { name: MESSAGE_RULE_NAME, limit: settings.rate.limit, periodMs: settings.rate.periodMs, burst: settings.rate.burst };
}

/**
 * On the cache Redis. The rate limit fails open (a cache outage must not silence the assistant; the gateway still
 * limits the route class); the budget reports `unknown` so the caller can avoid unaccounted model spend.
 */
export class RedisTurnLimits implements TurnLimits {
  private readonly limiter: GcraLimiter;
  private readonly rule: GcraRule;

  constructor(
    private readonly redis: Redis,
    private readonly settings: LimitSettings
  ) {
    this.limiter = new GcraLimiter(redis, LIMITS_KEY_PREFIX);
    this.rule = ruleOf(settings);
  }

  public async checkRate(userId: string): Promise<RateDecision> {
    try {
      const result = await this.limiter.check(this.rule, userId);
      return { allowed: result.allowed, retryAfterMs: Math.max(0, result.retryAfterMs) };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Assistant message limiter unavailable; allowing the message');
      return { allowed: true, retryAfterMs: 0 };
    }
  }

  public async checkBudget(userId: string, day: string): Promise<BudgetDecision> {
    try {
      const usedTokens = Number((await this.redis.get(budgetKey(day, userId))) ?? 0);
      return { state: usedTokens >= this.settings.dailyTokenBudget ? 'exhausted' : 'ok', usedTokens };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Assistant token budget unavailable');
      return { state: 'unknown', usedTokens: 0 };
    }
  }

  public async recordTokens(userId: string, day: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    const key = budgetKey(day, userId);
    try {
      await this.redis.multi().incrby(key, Math.ceil(tokens)).expire(key, BUDGET_TTL_SECONDS).exec();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Assistant token usage could not be recorded');
    }
  }
}

/** One replica, no Redis: the same GCRA (one timestamp per user) and per-day counters in process memory */
export class MemoryTurnLimits implements TurnLimits {
  private readonly arrivals = new Map<string, number>();
  private readonly usage = new Map<string, Map<string, number>>();
  private readonly interval: number;
  private readonly tolerance: number;

  constructor(
    private readonly settings: LimitSettings,
    private readonly now: () => number = Date.now
  ) {
    if (settings.rate.limit <= 0 || settings.rate.periodMs <= 0 || settings.rate.burst < 1) throw new Error('Invalid assistant rate limit');
    this.interval = settings.rate.periodMs / settings.rate.limit;
    this.tolerance = this.interval * settings.rate.burst;
  }

  public async checkRate(userId: string): Promise<RateDecision> {
    const now = this.now();
    if (this.arrivals.size > 10_000) this.sweep(now);
    const tat = Math.max(this.arrivals.get(userId) ?? 0, now);
    const allowAt = tat + this.interval - this.tolerance;
    if (now < allowAt) return { allowed: false, retryAfterMs: Math.ceil(allowAt - now) };
    this.arrivals.set(userId, tat + this.interval);
    return { allowed: true, retryAfterMs: 0 };
  }

  public async checkBudget(userId: string, day: string): Promise<BudgetDecision> {
    const usedTokens = this.usage.get(day)?.get(userId) ?? 0;
    return { state: usedTokens >= this.settings.dailyTokenBudget ? 'exhausted' : 'ok', usedTokens };
  }

  public async recordTokens(userId: string, day: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    // Only the current day matters; earlier days are dropped as soon as a new one starts
    for (const other of this.usage.keys()) if (other < day) this.usage.delete(other);
    const counters = this.usage.get(day) ?? new Map<string, number>();
    counters.set(userId, (counters.get(userId) ?? 0) + Math.ceil(tokens));
    this.usage.set(day, counters);
  }

  private sweep(now: number): void {
    for (const [userId, tat] of this.arrivals) if (tat <= now) this.arrivals.delete(userId);
  }
}
