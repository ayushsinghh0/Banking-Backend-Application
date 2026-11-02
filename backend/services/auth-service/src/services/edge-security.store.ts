import crypto from 'crypto';
import Redis from 'ioredis';

/**
 * Auth-service's side of the edge Redis (redis-ratelimit, RATE_LIMIT_REDIS_URL), shared with the gateway.
 * Key contract (the gateway reads the edge:* keys; auth-service is the only writer):
 *
 *   edge:ban:<clientIpKey>          string JSON { reason, bannedAt, source, distinctAccounts? }, TTL = ban length.
 *                                   Its existence makes the gateway answer 403 IP_BLOCKED (checked inside the GCRA call).
 *   edge:ip-rules                   hash  rule id -> JSON { cidr, expiresAt: ISO-8601 | null, reason }
 *   edge:ip-rules:version           string, a new random value on every change of the hash
 *   auth:stuffing:<ipKey>:<bucket>  HyperLogLog of hashed emails with failed sign-ins in a 5-minute bucket
 *                                   (the current and previous buckets together are the 10-minute window)
 *
 * The instance evicts (allkeys-lru): bans and the rules mirror can disappear under memory pressure. The rules
 * are re-mirrored from the database every minute; a lost ban only shortens it.
 */
export const BAN_KEY_PREFIX = 'edge:ban:';
export const IP_RULES_KEY = 'edge:ip-rules';
export const IP_RULES_VERSION_KEY = 'edge:ip-rules:version';
const STUFFING_BUCKET_MS = 5 * 60_000;

export interface BanInfo {
  reason: string;
  bannedAt: string;
  source: string;
  distinctAccounts?: number;
}

export interface ActiveBan {
  ipKey: string;
  /** ms left; null when the ban has no expiry */
  ttlMs: number | null;
  info: Partial<BanInfo> | null;
}

export interface MirroredIpRule {
  id: string;
  cidr: string;
  expiresAt: Date | null;
  reason: string;
}

export interface EdgeSecurityStore {
  /** Adds the account to this address's failed-sign-in set; returns the distinct accounts in the 10-minute window */
  recordFailedSignIn(ipKey: string, email: string): Promise<number>;
  /** Bans the address at the edge unless it is already banned; true if this call created the ban */
  banIp(ipKey: string, ttlSeconds: number, info: BanInfo): Promise<boolean>;
  /** Active bans, bounded: `complete` is false when the scan budget ran out first */
  listBans(limit: number): Promise<{ bans: ActiveBan[]; complete: boolean }>;
  /** true if a ban existed */
  liftBan(ipKey: string): Promise<boolean>;
  /** Replaces the rules mirror if it differs from `rules` (or its version is missing); true if it wrote */
  mirrorIpRules(rules: MirroredIpRule[]): Promise<boolean>;
}

const emailHash = (email: string) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);

export const mirrorValue = (rule: MirroredIpRule) =>
  JSON.stringify({ cidr: rule.cidr, expiresAt: rule.expiresAt ? rule.expiresAt.toISOString() : null, reason: rule.reason });

const newVersion = () => `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

function parseBanInfo(raw: string | null): Partial<BanInfo> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Partial<BanInfo>) : null;
  } catch {
    return null;
  }
}

export class RedisEdgeSecurityStore implements EdgeSecurityStore {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now
  ) {}

  public async recordFailedSignIn(ipKey: string, email: string): Promise<number> {
    const bucket = Math.floor(this.now() / STUFFING_BUCKET_MS);
    const current = `auth:stuffing:${ipKey}:${bucket}`;
    const previous = `auth:stuffing:${ipKey}:${bucket - 1}`;
    const results = await this.redis
      .multi()
      .pfadd(current, emailHash(email))
      .pexpire(current, 2 * STUFFING_BUCKET_MS + 60_000)
      .pfcount(current, previous)
      .exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
    return Number(results?.[2]?.[1] ?? 0);
  }

  public async banIp(ipKey: string, ttlSeconds: number, info: BanInfo): Promise<boolean> {
    const result = await this.redis.set(`${BAN_KEY_PREFIX}${ipKey}`, JSON.stringify(info), 'EX', Math.max(1, Math.ceil(ttlSeconds)), 'NX');
    return result === 'OK';
  }

  public async listBans(limit: number): Promise<{ bans: ActiveBan[]; complete: boolean }> {
    // SCAN walks the whole (large, LRU) keyspace in slices; bound the walk so the admin page can't stall Redis
    const found = new Set<string>(); // SCAN may return a key more than once
    let cursor = '0';
    let iterations = 0;
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${BAN_KEY_PREFIX}*`, 'COUNT', 1000);
      for (const key of batch) found.add(key);
      cursor = next;
      iterations += 1;
    } while (cursor !== '0' && found.size < limit && iterations < 200);
    const complete = cursor === '0' && found.size <= limit;
    const selected = [...found].slice(0, limit);
    if (!selected.length) return { bans: [], complete };

    const pipeline = this.redis.pipeline();
    for (const key of selected) pipeline.pttl(key).get(key);
    const results = (await pipeline.exec()) ?? [];
    const bans: ActiveBan[] = [];
    selected.forEach((key, i) => {
      const ttl = Number(results[i * 2]?.[1]);
      if (ttl === -2) return; // expired between SCAN and PTTL
      bans.push({ ipKey: key.slice(BAN_KEY_PREFIX.length), ttlMs: ttl >= 0 ? ttl : null, info: parseBanInfo(results[i * 2 + 1]?.[1] as string | null) });
    });
    return { bans, complete };
  }

  public async liftBan(ipKey: string): Promise<boolean> {
    return (await this.redis.del(`${BAN_KEY_PREFIX}${ipKey}`)) > 0;
  }

  public async mirrorIpRules(rules: MirroredIpRule[]): Promise<boolean> {
    const desired = Object.fromEntries(rules.map((r) => [r.id, mirrorValue(r)]));
    const [current, version] = await Promise.all([this.redis.hgetall(IP_RULES_KEY), this.redis.get(IP_RULES_VERSION_KEY)]);
    if (version && sameEntries(current, desired)) return false;
    const tx = this.redis.multi().del(IP_RULES_KEY);
    if (rules.length) tx.hset(IP_RULES_KEY, desired);
    tx.set(IP_RULES_VERSION_KEY, newVersion());
    const results = await tx.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
    return true;
  }
}

function sameEntries(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** In-process implementation for unit tests (same semantics, exact counting instead of HyperLogLog) */
export class InMemoryEdgeSecurityStore implements EdgeSecurityStore {
  public readonly failures = new Map<string, Map<string, number>>();
  public readonly bans = new Map<string, { info: BanInfo; expiresAt: number }>();
  public rules: Record<string, string> = {};
  public version: string | null = null;
  public writes = 0;

  constructor(public now: () => number = Date.now) {}

  public async recordFailedSignIn(ipKey: string, email: string): Promise<number> {
    const seen = this.failures.get(ipKey) ?? new Map<string, number>();
    this.failures.set(ipKey, seen);
    const now = this.now();
    seen.set(emailHash(email), now);
    const windowStart = (Math.floor(now / STUFFING_BUCKET_MS) - 1) * STUFFING_BUCKET_MS;
    return [...seen.values()].filter((at) => at >= windowStart).length;
  }

  public async banIp(ipKey: string, ttlSeconds: number, info: BanInfo): Promise<boolean> {
    const existing = this.bans.get(ipKey);
    if (existing && existing.expiresAt > this.now()) return false;
    this.bans.set(ipKey, { info, expiresAt: this.now() + ttlSeconds * 1000 });
    return true;
  }

  public async listBans(limit: number): Promise<{ bans: ActiveBan[]; complete: boolean }> {
    const active = [...this.bans].filter(([, ban]) => ban.expiresAt > this.now());
    return {
      bans: active.slice(0, limit).map(([ipKey, ban]) => ({ ipKey, ttlMs: ban.expiresAt - this.now(), info: ban.info })),
      complete: active.length <= limit,
    };
  }

  public async liftBan(ipKey: string): Promise<boolean> {
    const existed = (this.bans.get(ipKey)?.expiresAt ?? 0) > this.now();
    this.bans.delete(ipKey);
    return existed;
  }

  public async mirrorIpRules(rules: MirroredIpRule[]): Promise<boolean> {
    const desired = Object.fromEntries(rules.map((r) => [r.id, mirrorValue(r)]));
    if (this.version && sameEntries(this.rules, desired)) return false;
    this.rules = desired;
    this.version = newVersion();
    this.writes += 1;
    return true;
  }
}
