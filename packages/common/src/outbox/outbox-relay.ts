import { EventPublisher } from '../kafka/event-publisher';
import { logger } from '../logger/logger';

/**
 * Minimal shape of a Prisma client whose schema contains the standard `outbox_events` table:
 *   id, aggregate_id, event_type, payload (jsonb), status ("OutboxStatus": PENDING/PUBLISHED/FAILED),
 *   retry_count, last_error, next_attempt_at, locked_until, created_at, published_at
 */
export interface OutboxPrismaClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: any[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: any[]): Promise<number>;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  retry_count: number;
}

const MAX_BACKOFF_SECONDS = 300;

/**
 * Transactional-outbox relay. Rows are written in the same DB transaction as the business change;
 * this relay publishes them to Kafka.
 *
 * - Rows are CLAIMED with a short lease in one quick statement, PUBLISHED with no DB transaction held
 *   open, then marked PUBLISHED. A crashed relay's lease simply expires and another replica takes over.
 * - Only the oldest unpublished event of each aggregate is claimable, so events for the same aggregate
 *   (e.g. FROZEN then ACTIVE for one account) are always delivered in order.
 * - Failed publishes are retried forever with exponential backoff (capped at 5 min): a Kafka outage
 *   delays events but never loses them.
 * - Delivery is at-least-once; consumers deduplicate on eventId.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: OutboxPrismaClient,
    private readonly publisher: EventPublisher,
    private readonly options: { batchSize?: number; leaseSeconds?: number; publishTimeoutMs?: number } = {}
  ) {}

  public start(intervalMs = 1000): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Keep draining while there is work, so a backlog clears without waiting for the next interval
      while (!this.stopped && (await this.processPendingEvents()) > 0) {
        /* continue */
      }
    } catch (err) {
      logger.error({ err }, 'Outbox relay batch failed');
    } finally {
      this.running = false;
    }
  }

  /** Age in seconds of the oldest unpublished event (0 when empty); exposed for health checks/alerting */
  public async lagSeconds(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ age: number | null }>>`
      SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::float8 AS age
      FROM outbox_events WHERE status = 'PENDING'
    `;
    return Math.max(0, Math.floor(rows[0]?.age ?? 0));
  }

  public async processPendingEvents(): Promise<number> {
    const batchSize = this.options.batchSize ?? 100;
    const leaseSeconds = this.options.leaseSeconds ?? 60;

    const rows = await this.prisma.$queryRaw<OutboxRow[]>`
      UPDATE outbox_events o
      SET locked_until = now() + make_interval(secs => ${leaseSeconds})
      WHERE o.id IN (
        SELECT c.id FROM outbox_events c
        WHERE c.status = 'PENDING'
          AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
          AND (c.locked_until IS NULL OR c.locked_until < now())
          AND NOT EXISTS (
            SELECT 1 FROM outbox_events e
            WHERE e.aggregate_id = c.aggregate_id AND e.status = 'PENDING'
              AND (e.created_at, e.id) < (c.created_at, c.id)
          )
        ORDER BY c.created_at ASC, c.id ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.retry_count
    `;

    for (const row of rows) {
      try {
        // Topic = event type (e.g. transaction.completed.v1); key = aggregate id keeps per-aggregate ordering
        await this.withTimeout(
          this.publisher.publish(row.event_type, row.aggregate_id, row.payload),
          this.options.publishTimeoutMs ?? 15_000
        );
        await this.prisma.$executeRaw`
          UPDATE outbox_events
          SET status = 'PUBLISHED', published_at = now(), last_error = NULL, locked_until = NULL
          WHERE id = ${row.id}
        `;
      } catch (err: any) {
        const backoffSeconds = Math.min(2 ** Math.min(row.retry_count, 16), MAX_BACKOFF_SECONDS);
        const message = String(err?.message || 'Unknown publish failure').slice(0, 500);
        logger.warn({ eventType: row.event_type, id: row.id, retry: row.retry_count + 1 }, 'Outbox publish failed, will retry');
        await this.prisma.$executeRaw`
          UPDATE outbox_events
          SET retry_count = retry_count + 1,
              last_error = ${message},
              locked_until = NULL,
              next_attempt_at = now() + make_interval(secs => ${backoffSeconds})
          WHERE id = ${row.id}
        `;
      }
    }
    return rows.length;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Publish timed out after ${ms}ms`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}
