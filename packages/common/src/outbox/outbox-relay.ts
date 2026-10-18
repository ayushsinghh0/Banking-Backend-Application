import { EventPublisher } from '../kafka/event-publisher';
import { logger } from '../logger/logger';

/**
 * Minimal shape of a Prisma client whose schema contains the standard `outbox_events` table:
 *   id, aggregate_id, event_type, payload (jsonb), status ("OutboxStatus" enum: PENDING/PUBLISHED/FAILED),
 *   retry_count, last_error, next_attempt_at, created_at, published_at
 */
export interface OutboxPrismaClient {
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: { timeout?: number }): Promise<T>;
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
 * this relay publishes them to Kafka and marks them PUBLISHED.
 *
 * - FOR UPDATE SKIP LOCKED lets several replicas relay in parallel without double-claiming rows.
 * - A failed publish is retried forever with exponential backoff (capped at 5 min) instead of being
 *   dropped, so a Kafka outage delays events but never loses them.
 * - Delivery is at-least-once; consumers deduplicate on eventId.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: OutboxPrismaClient,
    private readonly publisher: EventPublisher,
    private readonly batchSize = 50
  ) {}

  public start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight batch finish so rows aren't left half-processed at shutdown
    while (this.running) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processPendingEvents();
    } catch (err) {
      logger.error({ err }, 'Outbox relay batch failed');
    } finally {
      this.running = false;
    }
  }

  public async processPendingEvents(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows: OutboxRow[] = await tx.$queryRaw`
          SELECT id, aggregate_id, event_type, payload, retry_count
          FROM outbox_events
          WHERE status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY created_at ASC
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED
        `;

        for (const row of rows) {
          try {
            // Topic name = event type (e.g. transaction.completed.v1); key = aggregate id keeps per-aggregate ordering
            await this.publisher.publish(row.event_type, row.aggregate_id, row.payload);
            await tx.$executeRaw`
              UPDATE outbox_events
              SET status = 'PUBLISHED', published_at = now(), last_error = NULL
              WHERE id = ${row.id}
            `;
          } catch (err: any) {
            const backoffSeconds = Math.min(2 ** Math.min(row.retry_count, 16), MAX_BACKOFF_SECONDS);
            const message = String(err?.message || 'Unknown publish failure').slice(0, 500);
            logger.warn({ eventType: row.event_type, id: row.id, retry: row.retry_count + 1 }, 'Outbox publish failed, will retry');
            await tx.$executeRaw`
              UPDATE outbox_events
              SET retry_count = retry_count + 1,
                  last_error = ${message},
                  next_attempt_at = now() + make_interval(secs => ${backoffSeconds})
              WHERE id = ${row.id}
            `;
          }
        }
        return rows.length;
      },
      { timeout: 60_000 }
    );
  }
}
