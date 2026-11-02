import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { AuthenticatedUser, EventStream, InMemoryTokenStateStore, TokenStateStore } from '@banksphere/common';
import { RealtimeStore } from '../../src/redis/realtime-store';
import { SubscriptionHub } from '../../src/redis/subscription-hub';
import { StreamManager, StreamSettings } from '../../src/stream/stream-manager';
import { FakeRedisClient, FakeRedisServer, settle } from './fake-redis';

export const SETTINGS: StreamSettings = {
  maxConnections: 100,
  maxStreamsPerUser: 5,
  heartbeatSeconds: 20,
  staleStreamSeconds: 60,
  revalidateSeconds: 60,
  maxBufferedBytes: 1_048_576,
};

/** An EventStream that records what is sent instead of writing HTTP */
export class RecordingStream implements EventStream {
  readonly sent: Array<{ event: string; data: any; id?: string }> = [];
  private isClosed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(readonly res: FakeResponse) {
    res.once('close', () => this.finish());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(event: string, data: unknown, id?: string): boolean {
    if (this.isClosed) return false;
    this.sent.push({ event, data: JSON.parse(JSON.stringify(data)), id });
    return true;
  }

  comment(): void {}

  close(): void {
    if (this.isClosed) return;
    this.res.end();
    this.finish();
  }

  onClose(listener: () => void): void {
    if (this.isClosed) listener();
    else this.listeners.push(listener);
  }

  /** Domain events only (no ready / reauth / reconnect) */
  get events() {
    return this.sent.filter((s) => !['ready', 'reauth', 'reconnect'].includes(s.event));
  }

  private finish(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const listener of this.listeners.splice(0)) listener();
  }
}

export class FakeResponse extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  readonly headers: Record<string, string> = {};
  readonly socket = { end: jest.fn() };

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(): void {
    setImmediate(() => this.emit('finish'));
  }

  /** The client goes away */
  disconnect(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

export function aUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'cust-1',
    email: 'customer@example.com',
    role: 'CUSTOMER',
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    tokenVersion: 1,
    sessionId: 'sid-1',
    mfa: false,
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

export interface Rig {
  server: FakeRedisServer;
  redis: FakeRedisClient;
  subscriber: FakeRedisClient;
  store: RealtimeStore;
  hub: SubscriptionHub;
  manager: StreamManager;
  tokenState: TokenStateStore;
  streams: RecordingStream[];
  /** Opens a stream; resolves with it, or with the error the handler passed on */
  connect(user?: AuthenticatedUser, headers?: Record<string, string>, res?: FakeResponse): Promise<{ stream?: RecordingStream; error?: any; res: FakeResponse }>;
}

/** A replica: its own Redis connections and stream manager, on a (possibly shared) fake Redis */
export function rig(options: { server?: FakeRedisServer; settings?: Partial<StreamSettings>; tokenState?: TokenStateStore } = {}): Rig {
  const server = options.server ?? new FakeRedisServer();
  const redis = server.client();
  const subscriber = server.client();
  const store = new RealtimeStore(redis);
  const hub = new SubscriptionHub(subscriber);
  const tokenState = options.tokenState ?? new InMemoryTokenStateStore();
  const streams: RecordingStream[] = [];
  const manager = new StreamManager({
    store,
    hub,
    tokenState,
    settings: { ...SETTINGS, ...options.settings },
    openStream: (_req, res) => {
      const stream = new RecordingStream(res as unknown as FakeResponse);
      streams.push(stream);
      return stream;
    },
  });

  const connect: Rig['connect'] = async (user = aUser(), headers = {}, res = new FakeResponse()) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { user, header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
    const before = streams.length;
    let error: any;
    manager.handler(req, res as unknown as Response, (err?: unknown) => {
      error = err;
    });
    for (let i = 0; i < 50 && streams.length === before && error === undefined; i++) await settle(1);
    return { stream: streams.length > before ? streams[streams.length - 1] : undefined, error, res };
  };

  return { server, redis, subscriber, store, hub, manager, tokenState, streams, connect };
}
