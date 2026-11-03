import 'dotenv/config';
import { Request, Response } from 'express';
import {
  assertJwtVerificationConfigured,
  assertNoPlaceholders,
  connectRedis,
  createAuthenticate,
  createBaseApp,
  createEventPublisher,
  errorHandlerMiddleware,
  isSwaggerEnabled,
  KafkaService,
  logger,
  notFoundHandler,
  RedisTokenStateStore,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
} from '@banksphere/common';
import { loadConfig } from './config';
import { KafkaRealtimeConsumer } from './consumers/realtime.consumer';
import { RealtimeStore, withRealtimeScripts } from './redis/realtime-store';
import { SubscriptionHub } from './redis/subscription-hub';
import { createRealtimeRouter } from './routes/realtime.routes';
import { StreamManager, StreamManagerDeps, StreamSettings } from './stream/stream-manager';

export interface RealtimeAppDeps {
  /** Read-only token state on the security Redis (REDIS_URL) */
  tokenState: TokenStateStore;
  store: RealtimeStore;
  hub: SubscriptionHub;
  settings: StreamSettings;
  /** Readiness checks beyond the cache Redis and the subscriber connection */
  health?: {
    securityRedis?: { ping(): Promise<unknown> };
    kafka?: Pick<KafkaService, 'consumersHealthy'> | null;
  };
  openStream?: StreamManagerDeps['openStream'];
}

export function createApp(deps: RealtimeAppDeps) {
  assertJwtVerificationConfigured(); // Fail fast on missing/invalid JWT public keys
  const app = createBaseApp();
  const streams = new StreamManager({
    store: deps.store,
    hub: deps.hub,
    tokenState: deps.tokenState,
    settings: deps.settings,
    openStream: deps.openStream,
  });

  // createAuthenticate also refuses staff tokens from outside STAFF_ALLOWED_CIDRS and staff without MFA
  app.use('/api/v1/realtime', createRealtimeRouter({ stream: streams.handler }, createAuthenticate(deps.tokenState)));

  if (isSwaggerEnabled()) {
    setupSwagger(app, {
      title: 'BankSphere - Real-time Service',
      version: '1.0.0',
      description: 'Server-Sent Events: live account, payment and fraud-queue updates fanned out through Kafka and Redis',
      paths: {
        '/api/v1/realtime/stream': {
          get: {
            summary:
              'text/event-stream. `ready`, then `{ id, type, at, data }` events; `reauth` at token expiry; `reconnect` on shutdown. Last-Event-ID replays up to 100 missed events (24 h).',
          },
        },
      },
    });
  }

  // Readiness: both Redis connections, the token store and the Kafka consumer
  app.get('/health', async (req: Request, res: Response) => {
    try {
      if (streams.isDraining) throw new Error('Shutting down');
      await deps.store.ping();
      if (!deps.hub.healthy) throw new Error('Redis subscriber connection is not ready');
      if (deps.health?.securityRedis) await deps.health.securityRedis.ping();
      if (deps.health?.kafka && !deps.health.kafka.consumersHealthy()) throw new Error('Kafka consumer is not running');
      res.json({ status: 'UP', service: 'realtime-service', connections: streams.size, timestamp: new Date().toISOString() });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'realtime-service' });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandlerMiddleware);

  return { app, streams };
}

export interface ShutdownParts {
  streams: Pick<StreamManager, 'drain'>;
  hub: Pick<SubscriptionHub, 'close'>;
  kafka?: Pick<KafkaService, 'disconnect'> | null;
  redis: Array<{ quit(): Promise<unknown> }>;
}

/**
 * Shutdown in order: (1) `drain` runs first on SIGTERM, before the HTTP server stops listening: new streams
 * are refused and every open stream gets `reconnect` and is closed, so the server isn't held open by
 * long-lived responses; (2) once the server has closed, the consumer stops, the subscriber unsubscribes and
 * the Redis connections are closed.
 */
export function shutdownSteps(parts: ShutdownParts): { drain: () => void; cleanup: Array<() => Promise<unknown>> } {
  let drained = false;
  return {
    drain: () => {
      if (drained) return;
      drained = true;
      const count = parts.streams.drain();
      logger.info({ streams: count }, 'Real-time streams told to reconnect elsewhere');
    },
    cleanup: [
      async () => parts.kafka?.disconnect(),
      async () => parts.hub.close(),
      ...parts.redis.map((r) => async () => r.quit()),
    ],
  };
}

async function main(): Promise<void> {
  assertNoPlaceholders(['CACHE_REDIS_URL', 'REDIS_URL', 'KAFKA_PASSWORD', 'JWT_VERIFY_KEYS']);
  const config = loadConfig();
  const securityRedis = await connectRedis(); // REDIS_URL: read-only token state
  const cacheRedis = await connectRedis(config.cacheRedisUrl);
  // The one subscriber connection of this replica (a connection in subscriber mode can't run other commands)
  const subscriber = await connectRedis(config.cacheRedisUrl);

  const store = new RealtimeStore(withRealtimeScripts(cacheRedis));
  const hub = new SubscriptionHub(subscriber);
  const { kafka } = createEventPublisher(config.kafkaClientId);
  const { app, streams } = createApp({
    tokenState: new RedisTokenStateStore(securityRedis),
    store,
    hub,
    settings: config,
    health: { securityRedis, kafka },
  });
  streams.start();
  if (kafka) {
    new KafkaRealtimeConsumer(kafka, store, { groupId: config.kafkaConsumerGroup, maxEventAgeMs: config.maxEventAgeSeconds * 1000 }).start();
  }

  const steps = shutdownSteps({ streams, hub, kafka, redis: [cacheRedis, securityRedis] });
  // Ahead of startHttpServer's own handler, which waits for open connections before running the cleanup
  process.prependListener('SIGTERM', steps.drain);
  process.prependListener('SIGINT', steps.drain);
  startHttpServer(app, config.port, 'realtime-service', steps.cleanup);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'realtime-service failed to start');
    process.exit(1);
  });
}
