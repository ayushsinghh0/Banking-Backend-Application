import crypto from 'crypto';
import Redis from 'ioredis';
import { logger } from '../logger/logger';
import { counter } from '../observability/metrics';

/**
 * Read-through cache on the cache Redis (CACHE_REDIS_URL, evictable, never the security store).
 *
 * - Keys live under `cache:<namespace>:`; the cache Redis gives each service an ACL user limited to its
 *   own namespace, so one service can neither read nor poison another's entries.
 * - TTLs are jittered so entries written together don't all expire in the same second.
 * - A miss is loaded once per process (single flight) and, across replicas, by whoever takes a short lock;
 *   the others wait briefly for the value instead of stampeding the database. If the lock holder is slow
 *   they stop waiting and load it themselves: the lock bounds load, it never blocks a request for long.
 * - Writers invalidate by deleting keys or by bumping a version that is part of the readers' keys
 *   (`versioned`), which is the safe pattern when one write affects many cached views.
 * - Redis problems never fail a request: the cache is bypassed and the loader runs.
 */
export interface CacheLike {
  readonly enabled: boolean;
  getOrLoad<T>(key: string, loader: () => Promise<T>, options?: { ttlSeconds?: number }): Promise<T>;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  invalidate(...keys: string[]): Promise<void>;
  /** Current version of a tag (0 when never bumped); include it in keys that depend on the tag */
  version(tag: string): Promise<number>;
  /** `<key>:v<version of tag>` */
  versioned(tag: string, key: string): Promise<string>;
  /** Invalidates every key built with `versioned(tag, ...)`; call it after the write has committed */
  bumpVersion(...tags: string[]): Promise<void>;
}

export interface CacheOptions {
  namespace: string;
  defaultTtlSeconds?: number;
  /** Fraction of the TTL removed at random (0.1 = up to 10 % shorter) */
  jitter?: number;
  /** How long the cross-replica load lock is held at most */
  lockTtlMs?: number;
  /** How long a replica that lost the lock waits for the value before loading it itself */
  lockWaitMs?: number;
  random?: () => number;
}

const NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/;
const requests = counter('cache_requests_total', 'Cache lookups by result', ['cache', 'result']);

// Only deletes the lock if this process still holds it (its token), so a slow loader can't release a lock
// that expired and was taken by someone else
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class Cache implements CacheLike {
  readonly enabled = true;
  private readonly prefix: string;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly defaultTtlSeconds: number;
  private readonly jitter: number;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private readonly random: () => number;

  constructor(
    private readonly redis: Redis,
    private readonly options: CacheOptions
  ) {
    if (!NAMESPACE.test(options.namespace)) throw new Error(`Invalid cache namespace '${options.namespace}'`);
    this.prefix = `cache:${options.namespace}:`;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 60;
    this.jitter = options.jitter ?? 0.1;
    this.lockTtlMs = options.lockTtlMs ?? 3_000;
    this.lockWaitMs = options.lockWaitMs ?? 250;
    this.random = options.random ?? Math.random;
  }

  public async getOrLoad<T>(key: string, loader: () => Promise<T>, options: { ttlSeconds?: number } = {}): Promise<T> {
    const fullKey = this.prefix + key;
    const cached = await this.read<T>(fullKey);
    if (cached.hit) return cached.value;

    const pending = this.inflight.get(fullKey) as Promise<T> | undefined;
    if (pending) return pending;
    const load = this.loadOnce(fullKey, loader, options.ttlSeconds ?? this.defaultTtlSeconds).finally(() =>
      this.inflight.delete(fullKey)
    );
    this.inflight.set(fullKey, load);
    return load;
  }

  public async get<T>(key: string): Promise<T | undefined> {
    const result = await this.read<T>(this.prefix + key);
    return result.hit ? result.value : undefined;
  }

  public async set<T>(key: string, value: T, ttlSeconds = this.defaultTtlSeconds): Promise<void> {
    await this.write(this.prefix + key, value, ttlSeconds);
  }

  public async invalidate(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      await this.redis.del(...keys.map((k) => this.prefix + k));
    } catch (err) {
      // A failed invalidation leaves an entry that can be stale until its TTL: say so loudly
      logger.warn({ err: (err as Error).message, cache: this.options.namespace }, 'Cache invalidation failed');
    }
  }

  public async version(tag: string): Promise<number> {
    return Number((await this.redis.get(this.versionKey(tag))) ?? 0);
  }

  public async versioned(tag: string, key: string): Promise<string> {
    try {
      return `${key}:v${await this.version(tag)}`;
    } catch {
      // Version unknown: a key nobody will ever read again, so this request bypasses any cached value
      // rather than risk serving one written before the latest bump
      return `${key}:vunknown-${crypto.randomUUID()}`;
    }
  }

  public async bumpVersion(...tags: string[]): Promise<void> {
    if (!tags.length) return;
    try {
      const pipeline = this.redis.pipeline();
      // The version key outlives every entry built on it (entries expire long before a day)
      for (const tag of tags) pipeline.incr(this.versionKey(tag)).expire(this.versionKey(tag), 86_400);
      await pipeline.exec();
    } catch (err) {
      logger.warn({ err: (err as Error).message, cache: this.options.namespace }, 'Cache version bump failed');
    }
  }

  private versionKey(tag: string): string {
    return `${this.prefix}ver:${tag}`;
  }

  private async loadOnce<T>(fullKey: string, loader: () => Promise<T>, ttlSeconds: number): Promise<T> {
    const lockKey = `${fullKey}:lock`;
    const token = crypto.randomUUID();
    let locked = false;
    try {
      locked = (await this.redis.set(lockKey, token, 'PX', this.lockTtlMs, 'NX')) === 'OK';
    } catch {
      return loader();
    }

    if (!locked) {
      // Another replica is loading this key: give it a moment, then load it ourselves
      const deadline = Date.now() + this.lockWaitMs;
      while (Date.now() < deadline) {
        await sleep(25);
        const cached = await this.read<T>(fullKey, false);
        if (cached.hit) return cached.value;
      }
      return loader();
    }

    try {
      const value = await loader();
      await this.write(fullKey, value, ttlSeconds);
      return value;
    } finally {
      this.redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => undefined);
    }
  }

  private async read<T>(fullKey: string, count = true): Promise<{ hit: true; value: T } | { hit: false }> {
    try {
      const raw = await this.redis.get(fullKey);
      if (raw === null) {
        if (count) requests.inc({ cache: this.options.namespace, result: 'miss' });
        return { hit: false };
      }
      if (count) requests.inc({ cache: this.options.namespace, result: 'hit' });
      return { hit: true, value: deserialize<T>(raw) };
    } catch (err) {
      if (count) requests.inc({ cache: this.options.namespace, result: 'error' });
      logger.debug({ err: (err as Error).message, cache: this.options.namespace }, 'Cache read failed, loading');
      return { hit: false };
    }
  }

  private async write(fullKey: string, value: unknown, ttlSeconds: number): Promise<void> {
    // undefined means "nothing to cache" (null is a real, cacheable answer such as "no profile yet")
    if (value === undefined || ttlSeconds <= 0 || fullKey.includes(':vunknown-')) return;
    const ttlMs = Math.max(1_000, Math.round(ttlSeconds * 1000 * (1 - this.jitter * this.random())));
    try {
      await this.redis.set(fullKey, serialize(value), 'PX', ttlMs);
    } catch (err) {
      logger.debug({ err: (err as Error).message, cache: this.options.namespace }, 'Cache write failed');
    }
  }
}

/** Used when CACHE_REDIS_URL is unset (tests, native development): every read goes to the loader */
export class NoopCache implements CacheLike {
  readonly enabled = false;
  public getOrLoad<T>(_key: string, loader: () => Promise<T>): Promise<T> {
    return loader();
  }
  public async get<T>(): Promise<T | undefined> {
    return undefined;
  }
  public async set(): Promise<void> {}
  public async invalidate(): Promise<void> {}
  public async version(): Promise<number> {
    return 0;
  }
  public async versioned(_tag: string, key: string): Promise<string> {
    return key;
  }
  public async bumpVersion(): Promise<void> {}
}

/**
 * The cache for a service: a Cache on CACHE_REDIS_URL, or a NoopCache when it is unset. The client fails fast
 * while Redis is down (no offline queue), which the cache turns into a bypass.
 */
export function createCache(options: CacheOptions, url = process.env.CACHE_REDIS_URL): { cache: CacheLike; redis: Redis | null } {
  if (!url) return { cache: new NoopCache(), redis: null };
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 200, 3_000),
  });
  let lastLogged = 0;
  redis.on('error', (err) => {
    // A down cache produces an error per reconnect attempt: log at most once a minute
    if (Date.now() - lastLogged > 60_000) {
      lastLogged = Date.now();
      logger.warn({ err: err.message, cache: options.namespace }, 'Cache Redis unavailable; serving from the source');
    }
  });
  return { cache: new Cache(redis, options), redis };
}

/** JSON that round-trips BigInt (money in paise) and Date values */
export function serialize(value: unknown): string {
  return JSON.stringify(value, function replacer(this: Record<string, unknown>, key: string, current: unknown) {
    const original = this[key];
    if (original instanceof Date) return { __t: 'd', v: original.toISOString() };
    if (typeof current === 'bigint') return { __t: 'b', v: current.toString() };
    return current;
  });
}

export function deserialize<T>(raw: string): T {
  return JSON.parse(raw, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.v === 'string' && Object.keys(value).length === 2) {
      if (value.__t === 'b') return BigInt(value.v);
      if (value.__t === 'd') return new Date(value.v);
    }
    return value;
  }) as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
