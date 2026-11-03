import { GcraResult, GcraRule } from '@banksphere/common';
import { RateLimitChecker } from '../../src/rate-limit';

/**
 * In-memory port of the GCRA Lua script in @banksphere/common (same arithmetic, same ban semantics, a
 * controllable clock), so the gateway's tiers can be tested without Redis. The script itself is tested
 * against a real Redis in packages/common (REDIS_TEST_URL).
 */
export class FakeGcra implements RateLimitChecker {
  public now = 1_000_000;
  public fail = false;
  public readonly calls: Array<{ rule: string; key: string; banKey?: string }> = [];
  private readonly tats = new Map<string, number>();
  /** ban key -> expiry (ms on this clock), or null for a ban without expiry */
  public readonly bans = new Map<string, number | null>();

  public async check(rule: GcraRule, key: string, options: { cost?: number; banKey?: string } = {}): Promise<GcraResult> {
    this.calls.push({ rule: rule.name, key, banKey: options.banKey });
    if (this.fail) throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    if (options.banKey && this.bans.has(options.banKey)) {
      const expiry = this.bans.get(options.banKey)!;
      if (expiry === null) return { allowed: false, banned: true, remaining: 0, retryAfterMs: -1, resetAfterMs: 0 };
      if (expiry > this.now) return { allowed: false, banned: true, remaining: 0, retryAfterMs: expiry - this.now, resetAfterMs: 0 };
    }
    const interval = rule.periodMs / rule.limit;
    const tolerance = interval * rule.burst;
    const increment = interval * (options.cost ?? 1);
    const bucket = `${rule.name}:${key}`;
    const tat = Math.max(this.tats.get(bucket) ?? 0, this.now);
    const newTat = tat + increment;
    const allowAt = newTat - tolerance;
    if (this.now < allowAt) {
      return { allowed: false, banned: false, remaining: 0, retryAfterMs: increment > tolerance ? -1 : allowAt - this.now, resetAfterMs: tat - this.now };
    }
    this.tats.set(bucket, newTat);
    return { allowed: true, banned: false, remaining: Math.floor((this.now - allowAt) / interval), retryAfterMs: 0, resetAfterMs: newTat - this.now };
  }

  /** Keys checked for one tier, in order */
  public keysFor(rule: string): string[] {
    return this.calls.filter((c) => c.rule === rule).map((c) => c.key);
  }
}
