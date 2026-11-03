import http from 'http';
import { AddressInfo } from 'net';
import { generateJwtKeyPair, InMemoryTokenStateStore, signAccessToken, UserRole } from '@banksphere/common';
import { createApp } from '../../src/app';
import { RealtimeStore } from '../../src/redis/realtime-store';
import { SubscriptionHub } from '../../src/redis/subscription-hub';
import { StreamSettings } from '../../src/stream/stream-manager';
import { FakeRedisClient, FakeRedisServer } from './fake-redis';
import { SETTINGS } from './harness';

let keysReady = false;

/** Real ES256 keys for the tests: tokens are signed and verified exactly as in production */
export function useTestJwtKeys(): void {
  if (keysReady) return;
  const { privateKeyB64, publicKeyB64 } = generateJwtKeyPair();
  process.env.JWT_SIGNING_KEY = privateKeyB64;
  process.env.JWT_SIGNING_KEY_ID = 'test-key';
  process.env.JWT_VERIFY_KEYS = `test-key:${publicKeyB64}`;
  keysReady = true;
}

export function tokenFor(userId: string, role: UserRole = 'CUSTOMER', options: { mfa?: boolean; expiresIn?: string; sessionId?: string } = {}): string {
  useTestJwtKeys();
  return signAccessToken(
    { sub: userId, email: `${userId}@example.com`, role, tokenVersion: 1, mfa: options.mfa ?? role !== 'CUSTOMER', sessionId: options.sessionId ?? `sid-${userId}` },
    options.expiresIn ?? '15m'
  );
}

export interface HttpRig {
  url: string;
  server: http.Server;
  redis: FakeRedisServer;
  subscriber: FakeRedisClient;
  store: RealtimeStore;
  hub: SubscriptionHub;
  tokenState: InMemoryTokenStateStore;
  app: ReturnType<typeof createApp>;
  stop(): Promise<void>;
}

/** The real app (authentication, router, SSE over HTTP) on a fake Redis, listening on a random port */
export async function startHttpRig(settings: Partial<StreamSettings> = {}, health: Parameters<typeof createApp>[0]['health'] = undefined): Promise<HttpRig> {
  useTestJwtKeys();
  const redis = new FakeRedisServer();
  const subscriber = redis.client();
  const store = new RealtimeStore(redis.client());
  const hub = new SubscriptionHub(subscriber);
  const tokenState = new InMemoryTokenStateStore();
  const app = createApp({ tokenState, store, hub, settings: { ...SETTINGS, ...settings }, health });
  const server = http.createServer(app.app);
  // Same timeouts as startHttpServer in production
  server.requestTimeout = 30_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    redis,
    subscriber,
    store,
    hub,
    tokenState,
    app,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
