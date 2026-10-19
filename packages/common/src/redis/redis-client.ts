import Redis from 'ioredis';
import { logger } from '../logger/logger';

export class RedisService {
  private client: Redis | null = null;
  private readonly redisUrl: string;

  constructor(redisUrl?: string) {
    this.redisUrl = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
  }

  public getClient(): Redis {
    if (!this.client) {
      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 100, 3000);
          return delay;
        },
        reconnectOnError(err) {
          logger.warn({ err }, 'Redis connection error, reconnecting...');
          return true;
        },
      });

      this.client.on('connect', () => {
        logger.info('Connected to Redis');
      });

      this.client.on('error', (err) => {
        logger.error({ err }, 'Redis client runtime error');
      });
    }

    return this.client;
  }

  public async ping(): Promise<boolean> {
    try {
      const res = await this.getClient().ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}

export const defaultRedisService = new RedisService();
