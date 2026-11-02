/**
 * Readiness (/health) and configuration.
 */
import { DEV_CACHE_REDIS_URL, loadConfig } from '../src/config';
import { HttpRig, startHttpRig } from './support/http-app';

describe('/health', () => {
  let rig: HttpRig;
  const securityRedis = { ping: jest.fn() };
  const kafka = { consumersHealthy: jest.fn() };

  beforeEach(async () => {
    securityRedis.ping.mockResolvedValue('PONG');
    kafka.consumersHealthy.mockReturnValue(true);
    rig = await startHttpRig({}, { securityRedis, kafka });
  });
  afterEach(() => rig.stop());

  const health = async () => {
    const res = await fetch(`${rig.url}/health`);
    return { status: res.status, body: await res.json() };
  };

  it('UP when the cache Redis, the subscriber connection, the token store and the Kafka consumer are fine', async () => {
    expect(await health()).toEqual({ status: 200, body: { status: 'UP', service: 'realtime-service', connections: 0, timestamp: expect.any(String) } });
  });

  it.each([
    ['the cache Redis does not answer', (r: HttpRig) => r.redis.failNext('ping', new Error('Connection is closed.'))],
    ['the subscriber connection is down', (r: HttpRig) => r.subscriber.drop()],
    ['the security Redis does not answer', () => securityRedis.ping.mockRejectedValue(new Error('Connection is closed.'))],
    ['the Kafka consumer is not running', () => kafka.consumersHealthy.mockReturnValue(false)],
  ])('DOWN (503) when %s', async (_label, breakIt) => {
    breakIt(rig);
    expect(await health()).toEqual({ status: 503, body: { status: 'DOWN', service: 'realtime-service' } });
  });

  it('liveness stays up regardless (the process is serving)', async () => {
    rig.subscriber.drop();
    expect((await fetch(`${rig.url}/health/live`)).status).toBe(200);
  });
});

describe('loadConfig', () => {
  it('has the documented defaults', () => {
    expect(loadConfig({ NODE_ENV: 'development' })).toEqual({
      port: 8009,
      cacheRedisUrl: DEV_CACHE_REDIS_URL,
      maxConnections: 10_000,
      maxStreamsPerUser: 5,
      heartbeatSeconds: 20,
      staleStreamSeconds: 60,
      revalidateSeconds: 60,
      maxEventAgeSeconds: 3_600,
      maxBufferedBytes: 1_048_576,
      kafkaConsumerGroup: 'realtime-service-group',
      kafkaClientId: 'realtime-service',
    });
  });

  it('reads overrides', () => {
    const config = loadConfig({ CACHE_REDIS_URL: 'redis://realtime-svc:pw@redis-cache:6379', REALTIME_MAX_CONNECTIONS: '20000', REALTIME_HEARTBEAT_SECONDS: '15' });
    expect(config).toMatchObject({ cacheRedisUrl: 'redis://realtime-svc:pw@redis-cache:6379', maxConnections: 20_000, heartbeatSeconds: 15, staleStreamSeconds: 45 });
  });

  it('requires CACHE_REDIS_URL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/CACHE_REDIS_URL/);
  });

  it.each([
    ['REALTIME_MAX_CONNECTIONS', '0'],
    ['REALTIME_MAX_STREAMS_PER_USER', 'many'],
    ['REALTIME_HEARTBEAT_SECONDS', '1'],
  ])('refuses an invalid %s, naming the variable but not echoing values', (name, value) => {
    expect(() => loadConfig({ [name]: value, CACHE_REDIS_URL: 'redis://u:secret@h:6379' })).toThrow(new RegExp(name));
    expect(() => loadConfig({ [name]: value, CACHE_REDIS_URL: 'redis://u:secret@h:6379' })).not.toThrow(/secret/);
  });
});
