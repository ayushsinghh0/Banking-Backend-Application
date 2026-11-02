import { z } from 'zod';

/**
 * Real-time service settings. The replay window (100 events, 24 hours) is part of the platform contract
 * (design section 8), so it is a constant here rather than a setting.
 */
export const REPLAY_LIMIT = 100;
export const REPLAY_LOG_MAXLEN = 100;
export const REPLAY_LOG_TTL_SECONDS = 86_400;

const int = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  PORT: int(1, 65_535, 8009),
  /** Cache Redis (ACL user realtime-svc: ~rt:* keys, &rt:* channels): pub/sub fan-out, replay logs, stream registry */
  CACHE_REDIS_URL: z.string().min(1).optional(),
  /** Per-replica cap on open streams; above it new streams get 503 SERVER_BUSY */
  REALTIME_MAX_CONNECTIONS: int(1, 1_000_000, 10_000),
  /** Concurrent streams per user across all replicas; above it 429 TOO_MANY_STREAMS */
  REALTIME_MAX_STREAMS_PER_USER: int(1, 100, 5),
  /** Comment heartbeat on every stream, and how often each replica refreshes its streams in the registry */
  REALTIME_HEARTBEAT_SECONDS: int(5, 300, 20),
  /** How often an open stream re-checks that its access token has not been revoked (logout, session revoked) */
  REALTIME_REVALIDATE_SECONDS: int(5, 3_600, 60),
  /** Kafka events older than this are not pushed (a new consumer group or a long outage must not replay history as live news) */
  REALTIME_MAX_EVENT_AGE_SECONDS: int(60, REPLAY_LOG_TTL_SECONDS, 3_600),
  /** A client that stops reading has its stream closed once this much output is waiting for it */
  REALTIME_MAX_BUFFERED_BYTES: int(16_384, 64 * 1024 * 1024, 1_048_576),
  KAFKA_CONSUMER_GROUP: z.string().min(1).default('realtime-service-group'),
  KAFKA_CLIENT_ID: z.string().min(1).default('realtime-service'),
});

export interface RealtimeConfig {
  port: number;
  cacheRedisUrl: string;
  maxConnections: number;
  maxStreamsPerUser: number;
  heartbeatSeconds: number;
  /** A registry entry not refreshed for this long belongs to a dead replica and no longer counts */
  staleStreamSeconds: number;
  revalidateSeconds: number;
  maxEventAgeSeconds: number;
  maxBufferedBytes: number;
  kafkaConsumerGroup: string;
  kafkaClientId: string;
}

/** Dev default: the cache Redis published on the host by docker-compose.dev.yml */
export const DEV_CACHE_REDIS_URL = 'redis://127.0.0.1:6382';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid realtime-service configuration: ${fields}`);
  }
  const c = parsed.data;
  if (!c.CACHE_REDIS_URL && env.NODE_ENV === 'production') {
    throw new Error('CACHE_REDIS_URL must be set in production (the cache Redis, ACL user realtime-svc)');
  }
  return {
    port: c.PORT,
    cacheRedisUrl: c.CACHE_REDIS_URL || DEV_CACHE_REDIS_URL,
    maxConnections: c.REALTIME_MAX_CONNECTIONS,
    maxStreamsPerUser: c.REALTIME_MAX_STREAMS_PER_USER,
    heartbeatSeconds: c.REALTIME_HEARTBEAT_SECONDS,
    staleStreamSeconds: c.REALTIME_HEARTBEAT_SECONDS * 3,
    revalidateSeconds: c.REALTIME_REVALIDATE_SECONDS,
    maxEventAgeSeconds: c.REALTIME_MAX_EVENT_AGE_SECONDS,
    maxBufferedBytes: c.REALTIME_MAX_BUFFERED_BYTES,
    kafkaConsumerGroup: c.KAFKA_CONSUMER_GROUP,
    kafkaClientId: c.KAFKA_CLIENT_ID,
  };
}
