import { EventEmitter } from 'events';
import { RealtimeRedisClient } from '../../src/redis/realtime-store';
import { PubSubClient } from '../../src/redis/subscription-hub';

/**
 * An in-memory Redis for the real-time tests: streams with real "<ms>-<seq>" ids, pub/sub delivered
 * asynchronously (like a network), sorted sets, and TypeScript mirrors of the two Lua scripts
 * (src/redis/realtime-store.ts; the scripts themselves run against a real Redis in redis-lua.spec.ts).
 * Hooks let a test interleave publishes with a stream's catch-up.
 */
export class FakeRedisServer {
  readonly streams = new Map<string, Array<[string, string[]]>>();
  readonly ttls = new Map<string, number>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly clients = new Set<FakeRedisClient>();
  readonly commands: string[] = [];
  private readonly lastIds = new Map<string, { ms: number; seq: number }>();
  /** Runs inside XREVRANGE before it reads: the place to publish "while the stream is catching up" */
  beforeRead: (() => Promise<void> | void) | null = null;
  /** A coming call of the named command fails with this error (after `after` successful calls) */
  readonly failures = new Map<string, { error: Error; after: number }>();
  now: () => number = () => Date.now();

  client(): FakeRedisClient {
    return new FakeRedisClient(this);
  }

  nextId(key: string): string {
    const last = this.lastIds.get(key) ?? { ms: 0, seq: -1 };
    const ms = Math.max(this.now(), last.ms);
    const seq = ms === last.ms ? last.seq + 1 : 0;
    this.lastIds.set(key, { ms, seq });
    return `${ms}-${seq}`;
  }

  /** XADD (exact trimming; real Redis trims approximately, never below maxlen) */
  xadd(key: string, fields: string[], maxlen = Infinity): string {
    const id = this.nextId(key);
    const entries = this.streams.get(key) ?? [];
    entries.push([id, fields]);
    while (entries.length > maxlen) entries.shift();
    this.streams.set(key, entries);
    return id;
  }

  publish(channel: string, message: string): number {
    let receivers = 0;
    for (const client of this.clients) {
      if (!client.channels.has(channel)) continue;
      receivers++;
      setImmediate(() => client.emit('message', channel, message));
    }
    return receivers;
  }

  failNext(command: string, error: Error, after = 0): void {
    this.failures.set(command, { error, after });
  }

  takeFailure(command: string): void {
    this.commands.push(command);
    const failure = this.failures.get(command);
    if (!failure) return;
    if (failure.after > 0) {
      failure.after--;
      return;
    }
    this.failures.delete(command);
    throw failure.error;
  }
}

const compareIds = (a: string, b: string) => {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am !== bm ? am - bm : as - bs;
};

export class FakeRedisClient extends EventEmitter implements RealtimeRedisClient, PubSubClient {
  status = 'ready';
  readonly channels = new Set<string>();

  constructor(private readonly server: FakeRedisServer) {
    super();
    server.clients.add(this);
  }

  async rtDeliver(key: string, channel: string, maxlen: number, ttl: number, body: string, dedupeKey: string, window: number): Promise<[string, number]> {
    this.server.takeFailure('rtDeliver');
    const recent = (this.server.streams.get(key) ?? []).slice(-window);
    const seen = recent.find(([, fields]) => fields[fields.indexOf('k') + 1] === dedupeKey);
    if (seen) return [seen[0], 1];
    const id = this.server.xadd(key, ['e', body, 'k', dedupeKey], maxlen);
    this.server.ttls.set(key, ttl);
    this.server.publish(channel, `{"id":"${id}",${body.slice(1)}`);
    return [id, 0];
  }

  async rtAdmit(key: string, now: number, staleBefore: number, limit: number, connectionId: string, ttl: number): Promise<number> {
    this.server.takeFailure('rtAdmit');
    const set = this.server.zsets.get(key) ?? new Map<string, number>();
    for (const [member, score] of set) if (score <= staleBefore) set.delete(member);
    if (set.size >= limit) return 0;
    set.set(connectionId, now);
    this.server.zsets.set(key, set);
    this.server.ttls.set(key, ttl);
    return 1;
  }

  async xrevrange(key: string, end: string, start: string, _count: 'COUNT', count: number): Promise<Array<[string, string[]]>> {
    if (this.server.beforeRead) await this.server.beforeRead();
    this.server.takeFailure('xrevrange');
    const exclusive = start.startsWith('(');
    const from = exclusive ? start.slice(1) : start;
    return (this.server.streams.get(key) ?? [])
      .filter(([id]) => from === '-' || (exclusive ? compareIds(id, from) > 0 : compareIds(id, from) >= 0))
      .filter(([id]) => end === '+' || compareIds(id, end) <= 0)
      .reverse()
      .slice(0, count)
      .map(([id, fields]) => [id, [...fields]]);
  }

  async publish(channel: string, message: string): Promise<number> {
    this.server.takeFailure('publish');
    return this.server.publish(channel, message);
  }

  async zrem(key: string, member: string): Promise<number> {
    this.server.takeFailure('zrem');
    return this.server.zsets.get(key)?.delete(member) ? 1 : 0;
  }

  pipeline() {
    const ops: Array<() => unknown> = [];
    const pipeline = {
      zadd: (key: string, score: number, member: string) => {
        ops.push(() => {
          const set = this.server.zsets.get(key) ?? new Map<string, number>();
          set.set(member, score);
          this.server.zsets.set(key, set);
          return 1;
        });
        return pipeline;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => this.server.ttls.set(key, seconds) && 1);
        return pipeline;
      },
      exec: async (): Promise<Array<[Error | null, unknown]>> => {
        this.server.takeFailure('exec');
        return ops.map((op) => [null, op()]);
      },
    };
    return pipeline;
  }

  async ping(): Promise<string> {
    this.server.takeFailure('ping');
    return 'PONG';
  }

  async subscribe(...channels: string[]): Promise<number> {
    this.server.takeFailure('subscribe');
    if (this.status !== 'ready') throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    // Effective as soon as the server has processed it; the reply reaches the client a moment later
    for (const channel of channels) this.channels.add(channel);
    await new Promise((resolve) => setImmediate(resolve));
    return this.channels.size;
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    this.server.takeFailure('unsubscribe');
    if (this.status !== 'ready') throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    for (const channel of channels) this.channels.delete(channel);
    return this.channels.size;
  }

  async quit(): Promise<string> {
    this.status = 'end';
    this.channels.clear();
    this.server.clients.delete(this);
    return 'OK';
  }

  /** The connection drops (ioredis: 'close', then reconnecting) */
  drop(): void {
    this.status = 'reconnecting';
    this.emit('close');
  }

  /** The connection is back; like ioredis, existing subscriptions are kept */
  recover(): void {
    this.status = 'ready';
    this.emit('ready');
  }
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}
