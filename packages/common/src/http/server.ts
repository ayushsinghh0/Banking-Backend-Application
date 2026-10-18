import http from 'http';
import { Express } from 'express';
import Redis from 'ioredis';
import { logger } from '../logger/logger';

/**
 * Starts the HTTP server with production timeouts and graceful shutdown:
 * on SIGTERM/SIGINT it stops accepting connections, waits for in-flight requests,
 * runs the cleanup hooks, and force-exits if that takes longer than 15 seconds.
 */
export function startHttpServer(
  app: Express,
  port: number | string,
  name: string,
  cleanup: Array<() => Promise<unknown> | unknown> = []
): http.Server {
  const server = app.listen(Number(port), () => {
    logger.info({ port: Number(port) }, `${name} listening`);
  });

  // Slow-loris protection and keep-alive tuned to sit behind a load balancer (LB idle timeout ~60s)
  server.requestTimeout = 30_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, `${name} shutting down`);

    const force = setTimeout(() => {
      logger.error(`${name} did not shut down in time, forcing exit`);
      process.exit(1);
    }, 15_000);
    force.unref();

    server.close(async () => {
      for (const fn of cleanup) {
        try {
          await fn();
        } catch (err) {
          logger.error({ err }, 'Shutdown cleanup step failed');
        }
      }
      logger.info(`${name} stopped`);
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  return server;
}

/**
 * Redis client for request-path use: commands fail fast while disconnected instead of queueing,
 * so callers can fail closed (auth) or open (rate limiting) deliberately.
 */
export async function connectRedis(url = process.env.REDIS_URL || 'redis://localhost:6379'): Promise<Redis> {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    // The ready check (INFO) waits out AOF loading after a Redis restart, and without it ioredis can end
    // up "ready" on a dead socket after a flapping reconnect. The ACL users are granted +info for it.
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 3_000),
  });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis connection error'));
  await redis.connect();
  return redis;
}

/**
 * Options for every PrismaClient. Prisma's default of 2s to obtain a connection for an interactive
 * transaction is too tight for real networks and bursts; contention beyond these bounds surfaces as a
 * retryable 503 (see isRetryableDatabaseError) instead of hanging.
 */
export function prismaClientOptions(): { transactionOptions: { maxWait: number; timeout: number } } {
  return {
    transactionOptions: {
      maxWait: Number(process.env.PRISMA_TX_MAX_WAIT_MS || 5_000),
      timeout: Number(process.env.PRISMA_TX_TIMEOUT_MS || 10_000),
    },
  };
}
