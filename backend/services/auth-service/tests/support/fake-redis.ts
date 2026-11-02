/**
 * The slice of ioredis that RedisEdgeSecurityStore uses, in memory and with a controllable clock, so the
 * edge key contract shared with the gateway (edge:ban:<ipKey>, edge:ip-rules, edge:ip-rules:version, the
 * auth:stuffing:* HyperLogLogs) can be asserted by key name and TTL without a Redis. HyperLogLogs count
 * exactly here; the real ones are approximate, which only matters far above the thresholds in play.
 */
type Entry = { kind: 'string'; value: string } | { kind: 'hash'; value: Map<string, string> } | { kind: 'hll'; value: Set<string> };

type Op = () => unknown;

class FakeMulti {
  private readonly ops: Op[] = [];

  constructor(private readonly redis: FakeRedis) {}

  public pfadd(key: string, ...members: string[]): this {
    this.ops.push(() => this.redis.pfadd(key, ...members));
    return this;
  }

  public pexpire(key: string, ms: number): this {
    this.ops.push(() => this.redis.pexpire(key, ms));
    return this;
  }

  public pfcount(...keys: string[]): this {
    this.ops.push(() => this.redis.pfcount(...keys));
    return this;
  }

  public del(...keys: string[]): this {
    this.ops.push(() => this.redis.del(...keys));
    return this;
  }

  public hset(key: string, value: Record<string, string>): this {
    this.ops.push(() => this.redis.hset(key, value));
    return this;
  }

  public set(key: string, value: string, ...options: unknown[]): this {
    this.ops.push(() => this.redis.set(key, value, ...options));
    return this;
  }

  public get(key: string): this {
    this.ops.push(() => this.redis.get(key));
    return this;
  }

  public pttl(key: string): this {
    this.ops.push(() => this.redis.pttl(key));
    return this;
  }

  public async exec(): Promise<Array<[Error | null, unknown]>> {
    const results: Array<[Error | null, unknown]> = [];
    for (const op of this.ops) {
      try {
        results.push([null, await op()]);
      } catch (err) {
        results.push([err as Error, null]);
      }
    }
    return results;
  }
}

export class FakeRedis {
  private readonly entries = new Map<string, Entry>();
  private readonly expiry = new Map<string, number>();

  constructor(public now: () => number = Date.now) {}

  /** Live keys (expired ones are dropped lazily, as Redis does) */
  public keys(): string[] {
    for (const key of [...this.entries.keys()]) this.live(key);
    return [...this.entries.keys()];
  }

  private live(key: string): Entry | undefined {
    const expiresAt = this.expiry.get(key);
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      this.entries.delete(key);
      this.expiry.delete(key);
      return undefined;
    }
    return this.entries.get(key);
  }

  public async get(key: string): Promise<string | null> {
    const entry = this.live(key);
    return entry?.kind === 'string' ? entry.value : null;
  }

  public async set(key: string, value: string, ...options: unknown[]): Promise<'OK' | null> {
    const flags = options.map((o) => String(o).toUpperCase());
    if (flags.includes('NX') && this.live(key)) return null;
    this.entries.set(key, { kind: 'string', value });
    this.expiry.delete(key);
    const ex = flags.indexOf('EX');
    if (ex >= 0) this.expiry.set(key, this.now() + Number(options[ex + 1]) * 1000);
    const px = flags.indexOf('PX');
    if (px >= 0) this.expiry.set(key, this.now() + Number(options[px + 1]));
    return 'OK';
  }

  public async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.live(key)) deleted += 1;
      this.entries.delete(key);
      this.expiry.delete(key);
    }
    return deleted;
  }

  public async pttl(key: string): Promise<number> {
    if (!this.live(key)) return -2;
    const expiresAt = this.expiry.get(key);
    return expiresAt === undefined ? -1 : Math.max(0, expiresAt - this.now());
  }

  public async pexpire(key: string, ms: number): Promise<number> {
    if (!this.live(key)) return 0;
    this.expiry.set(key, this.now() + ms);
    return 1;
  }

  public async hgetall(key: string): Promise<Record<string, string>> {
    const entry = this.live(key);
    return entry?.kind === 'hash' ? Object.fromEntries(entry.value) : {};
  }

  public async hset(key: string, value: Record<string, string>): Promise<number> {
    const entry = this.live(key);
    const hash = entry?.kind === 'hash' ? entry.value : new Map<string, string>();
    let added = 0;
    for (const [field, v] of Object.entries(value)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, v);
    }
    this.entries.set(key, { kind: 'hash', value: hash });
    return added;
  }

  public async pfadd(key: string, ...members: string[]): Promise<number> {
    const entry = this.live(key);
    const set = entry?.kind === 'hll' ? entry.value : new Set<string>();
    const before = set.size;
    members.forEach((m) => set.add(m));
    this.entries.set(key, { kind: 'hll', value: set });
    return set.size > before ? 1 : 0;
  }

  public async pfcount(...keys: string[]): Promise<number> {
    const union = new Set<string>();
    for (const key of keys) {
      const entry = this.live(key);
      if (entry?.kind === 'hll') entry.value.forEach((m) => union.add(m));
    }
    return union.size;
  }

  /** One full pass per call (cursor "0" back), like a small Redis would answer */
  public async scan(_cursor: string, _match: 'MATCH', pattern: string, _count: 'COUNT', _n: number): Promise<[string, string[]]> {
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return ['0', this.keys().filter((key) => regex.test(key))];
  }

  public multi(): FakeMulti {
    return new FakeMulti(this);
  }

  public pipeline(): FakeMulti {
    return new FakeMulti(this);
  }
}
