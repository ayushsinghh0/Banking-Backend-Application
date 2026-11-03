import type Redis from 'ioredis';
import { Cache, NoopCache, createCache, deserialize, serialize } from '../src';

/** Just enough of ioredis for the cache: strings with expiry, NX, INCR, DEL, the unlock script, pipelines */
class FakeRedis {
  store = new Map<string, string>();
  down = false;
  gets = 0;

  private check() {
    if (this.down) throw Object.assign(new Error('Connection is closed.'), { code: 'ECONNREFUSED' });
  }
  async get(key: string) {
    this.check();
    this.gets += 1;
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: unknown[]) {
    this.check();
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async del(...keys: string[]) {
    this.check();
    keys.forEach((k) => this.store.delete(k));
    return keys.length;
  }
  async eval(_script: string, _n: number, key: string, token: string) {
    this.check();
    if (this.store.get(key) === token) this.store.delete(key);
    return 1;
  }
  pipeline() {
    const ops: Array<() => void> = [];
    const chain = {
      incr: (key: string) => {
        ops.push(() => this.store.set(key, String(Number(this.store.get(key) ?? 0) + 1)));
        return chain;
      },
      expire: () => chain,
      exec: async () => {
        this.check();
        ops.forEach((op) => op());
        return [];
      },
    };
    return chain;
  }
}

const make = (redis = new FakeRedis(), options: Partial<ConstructorParameters<typeof Cache>[1]> = {}) => ({
  redis,
  cache: new Cache(redis as unknown as Redis, { namespace: 'ledger', random: () => 0, ...options }),
});

describe('Cache', () => {
  it('loads on a miss, then serves the cached value without calling the loader', async () => {
    const { cache, redis } = make();
    const loader = jest.fn(async () => ({ balance: 1_000n, at: new Date('2026-10-28T10:00:00.000Z') }));

    const first = await cache.getOrLoad('bal:a1', loader, { ttlSeconds: 30 });
    const second = await cache.getOrLoad('bal:a1', loader, { ttlSeconds: 30 });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.balance).toBe(1_000n);
    expect(second.at).toBeInstanceOf(Date);
    expect([...redis.store.keys()]).toEqual(['cache:ledger:bal:a1']);
  });

  it('loads a key once for concurrent requests in the same process', async () => {
    const { cache } = make();
    let resolve!: (v: number) => void;
    const loader = jest.fn(() => new Promise<number>((r) => (resolve = r)));

    const pending = Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
    await new Promise((r) => setImmediate(r));
    resolve(7);

    expect(await pending).toEqual([7, 7, 7]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('waits for another replica that holds the load lock, then uses its value', async () => {
    const { cache, redis } = make(new FakeRedis(), { lockWaitMs: 500 });
    redis.store.set('cache:ledger:k:lock', 'other-replica');
    setTimeout(() => redis.store.set('cache:ledger:k', serialize(42)), 60);
    const loader = jest.fn(async () => 1);

    await expect(cache.getOrLoad('k', loader)).resolves.toBe(42);
    expect(loader).not.toHaveBeenCalled();
  });

  it('loads it anyway if the lock holder takes too long', async () => {
    const { cache, redis } = make(new FakeRedis(), { lockWaitMs: 60 });
    redis.store.set('cache:ledger:k:lock', 'stuck-replica');
    await expect(cache.getOrLoad('k', async () => 5)).resolves.toBe(5);
  });

  it('serves from the source when Redis is down (never fails the request)', async () => {
    const { cache, redis } = make();
    redis.down = true;
    await expect(cache.getOrLoad('k', async () => 'fresh')).resolves.toBe('fresh');
    await expect(cache.get('k')).resolves.toBeUndefined();
    await expect(cache.invalidate('k')).resolves.toBeUndefined();
  });

  it('does not cache undefined, but does cache null', async () => {
    const { cache } = make();
    const undef = jest.fn(async () => undefined);
    await cache.getOrLoad('u', undef);
    await cache.getOrLoad('u', undef);
    expect(undef).toHaveBeenCalledTimes(2);

    const nil = jest.fn(async () => null);
    await cache.getOrLoad('n', nil);
    await cache.getOrLoad('n', nil);
    expect(nil).toHaveBeenCalledTimes(1);
  });

  it('invalidates every view built on a tag by bumping its version', async () => {
    const { cache } = make();
    let balance = 100;
    const read = async () => cache.getOrLoad(await cache.versioned('acct:a1', 'hist:a1:20:0'), async () => balance);

    expect(await read()).toBe(100);
    balance = 250;
    expect(await read()).toBe(100);
    await cache.bumpVersion('acct:a1');
    expect(await read()).toBe(250);
  });

  it('bypasses cached views when the version cannot be read', async () => {
    const { cache, redis } = make();
    await cache.set('hist:a1:v0', 'stale');
    redis.down = true;
    const key = await cache.versioned('acct:a1', 'hist:a1');
    expect(key).toMatch(/^hist:a1:vunknown-/);
  });

  it('jitters TTLs downwards so entries written together expire apart', async () => {
    const redis = new FakeRedis();
    const set = jest.spyOn(redis, 'set');
    const cache = new Cache(redis as unknown as Redis, { namespace: 'ledger', jitter: 0.1, random: () => 1 });
    await cache.set('k', 1, 100);
    expect(set).toHaveBeenCalledWith('cache:ledger:k', '1', 'PX', 90_000);
  });

  it('rejects namespaces that could escape the service prefix', () => {
    expect(() => new Cache(new FakeRedis() as unknown as Redis, { namespace: 'ledger:*' })).toThrow();
  });
});

describe('NoopCache and createCache', () => {
  it('without CACHE_REDIS_URL every read goes to the loader', async () => {
    const { cache, redis } = createCache({ namespace: 'customer' }, undefined);
    expect(redis).toBeNull();
    expect(cache).toBeInstanceOf(NoopCache);
    const loader = jest.fn(async () => 1);
    await cache.getOrLoad('k', loader);
    await cache.getOrLoad('k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await cache.versioned('t', 'k')).toBe('k');
  });
});

describe('serialisation', () => {
  it('round-trips BigInt and Date values inside nested data', () => {
    const value = { items: [{ amount: 12_345n, at: new Date('2026-01-02T03:04:05.006Z') }], note: 'x', n: 1 };
    expect(deserialize(serialize(value))).toEqual(value);
  });
});
