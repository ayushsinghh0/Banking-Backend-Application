import crypto from 'crypto';
import { EventPublisher } from '../kafka/event-publisher';
import { logger } from '../logger/logger';
import { counter, gauge } from '../observability/metrics';

/**
 * Minimal shape of a Prisma client whose schema contains the standard `outbox_events` table:
 *   id, seq (bigserial), aggregate_id, event_type, payload (jsonb), status ("OutboxStatus":
 *   PENDING/PUBLISHED/FAILED), retry_count, last_error, next_attempt_at, locked_until, locked_by,
 *   created_at, published_at
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

export interface OutboxRelayOptions {
  /** Rows claimed per batch; small, so a batch always finishes well inside its lease */
  batchSize?: number;
  /** Lease per claim; must exceed batchSize * publishTimeoutMs */
  leaseSeconds?: number;
  publishTimeoutMs?: number;
  /** Publish attempts before a row is parked as FAILED (with an alert) so it stops blocking its aggregate */
  maxAttempts?: number;
  /** PUBLISHED rows older than this are purged */
  retentionDays?: number;
  /** Rows deleted per purge statement: each statement stays short (far below the app role's statement_timeout) */
  purgeBatchSize?: number;
  /** Time budget of one purge run; whatever is left is deleted by the next run */
  purgeBudgetMs?: number;
}

const MAX_BACKOFF_SECONDS = 300;

const pendingGauge = gauge('outbox_pending_events', 'Outbox events waiting to be published');
const lagGauge = gauge('outbox_oldest_pending_seconds', 'Age of the oldest unpublished outbox event');
const parkedGauge = gauge('outbox_failed_events', 'Outbox events parked as FAILED (need a re-drive)');
const published = counter('outbox_published_total', 'Outbox events published to Kafka', ['event_type']);
const publishFailures = counter('outbox_publish_failures_total', 'Failed outbox publish attempts', ['event_type']);

/**
 * Transactional-outbox relay. Rows are written in the same DB transaction as the business change;
 * this relay publishes them to Kafka.
 *
 * - Rows are CLAIMED with a lease and a fencing token (locked_by) in one quick statement, PUBLISHED with
 *   no DB transaction held open, then marked PUBLISHED only if this relay still holds the claim.
 * - Only the lowest-seq unpublished event of each aggregate is claimable, so events for one aggregate are
 *   delivered in insertion order.
 * - Failed publishes back off exponentially (capped at 5 min); after maxAttempts the row is parked as
 *   FAILED and an alert is logged, so one poison event can't block its aggregate forever.
 * - Delivery is at-least-once; consumers deduplicate on eventId.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly opts: Required<OutboxRelayOptions>;

  constructor(
    private readonly prisma: OutboxPrismaClient,
    private readonly publisher: EventPublisher,
    options: OutboxRelayOptions = {}
  ) {
    this.opts = {
      batchSize: options.batchSize ?? 20,
      publishTimeoutMs: options.publishTimeoutMs ?? 10_000,
      leaseSeconds: options.leaseSeconds ?? 300,
      maxAttempts: options.maxAttempts ?? Number(process.env.OUTBOX_MAX_ATTEMPTS || 60),
      retentionDays: options.retentionDays ?? Number(process.env.OUTBOX_RETENTION_DAYS || 7),
      purgeBatchSize: options.purgeBatchSize ?? 5_000,
      purgeBudgetMs: options.purgeBudgetMs ?? 5 * 60_000,
    };
  }

  public start(intervalMs = 1000): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.purgeTimer = setInterval(() => void this.purgePublished().catch((err) => logger.warn({ err }, 'Outbox purge failed')), 3600_000);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.timer = null;
    this.purgeTimer = null;
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
      const { pending, lagSeconds: lag } = await this.backlog();
      pendingGauge.set(pending);
      lagGauge.set(lag);
      if (lag > 300) logger.error({ lagSeconds: lag, alert: 'OUTBOX_LAG' }, 'Outbox events are not being published');
      const parked = await this.failedCount();
      parkedGauge.set(parked);
      if (parked > 0) logger.error({ parked, alert: 'OUTBOX_EVENTS_PARKED' }, 'Outbox events are parked as FAILED and need a re-drive');
    } catch (err) {
      logger.error({ err }, 'Outbox relay batch failed');
    } finally {
      this.running = false;
    }
  }

  /** Age in seconds of the oldest unpublished event (0 when empty); exposed for health checks/alerting */
  public async lagSeconds(): Promise<number> {
    return (await this.backlog()).lagSeconds;
  }

  /** Unpublished events and the age of the oldest, in one statement */
  public async backlog(): Promise<{ pending: number; lagSeconds: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint | number | null; age: number | null }>>`
      SELECT count(*)::bigint AS n, EXTRACT(EPOCH FROM (now() - min(created_at)))::float8 AS age
      FROM outbox_events WHERE status = 'PENDING'
    `;
    return { pending: Number(rows[0]?.n ?? 0), lagSeconds: Math.max(0, Math.floor(rows[0]?.age ?? 0)) };
  }

  public async processPendingEvents(): Promise<number> {
    const claim = crypto.randomUUID();
    const rows = await this.prisma.$queryRaw<OutboxRow[]>`
      UPDATE outbox_events o
      SET locked_until = now() + make_interval(secs => ${this.opts.leaseSeconds}), locked_by = ${claim}
      WHERE o.id IN (
        SELECT c.id FROM outbox_events c
        WHERE c.status = 'PENDING'
          AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
          AND (c.locked_until IS NULL OR c.locked_until < now())
          AND NOT EXISTS (
            SELECT 1 FROM outbox_events e
            WHERE e.aggregate_id = c.aggregate_id AND e.status = 'PENDING' AND e.seq < c.seq
          )
        ORDER BY c.seq ASC
        LIMIT ${this.opts.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.retry_count
    `;

    for (const row of rows) {
      if (this.stopped) break; // unprocessed rows are released when the lease expires
      try {
        // Topic = event type (e.g. transaction.completed.v1); key = aggregate id keeps per-aggregate ordering
        await this.withTimeout(this.publisher.publish(row.event_type, row.aggregate_id, row.payload), this.opts.publishTimeoutMs);
        await this.prisma.$executeRaw`
          UPDATE outbox_events
          SET status = 'PUBLISHED', published_at = now(), last_error = NULL, locked_until = NULL, locked_by = NULL
          WHERE id = ${row.id} AND locked_by = ${claim}
        `;
        published.inc({ event_type: row.event_type });
      } catch (err: any) {
        publishFailures.inc({ event_type: row.event_type });
        const attempts = row.retry_count + 1;
        const message = String(err?.message || 'Unknown publish failure').slice(0, 500);
        // Only a message the broker will NEVER accept is parked; an unavailable broker (however long the
        // outage) just backs off, so events are never lost to an outage and per-aggregate order holds
        if (isPoisonPublishError(err) && attempts >= this.opts.maxAttempts) {
          logger.error({ id: row.id, eventType: row.event_type, attempts, alert: 'OUTBOX_EVENT_FAILED' }, 'Outbox event parked as FAILED');
          await this.prisma.$executeRaw`
            UPDATE outbox_events
            SET status = 'FAILED', retry_count = ${attempts}, last_error = ${message}, locked_until = NULL, locked_by = NULL
            WHERE id = ${row.id} AND locked_by = ${claim}
          `;
          continue;
        }
        const backoffSeconds = Math.min(2 ** Math.min(row.retry_count, 16), MAX_BACKOFF_SECONDS);
        logger.warn({ eventType: row.event_type, id: row.id, attempt: attempts }, 'Outbox publish failed, will retry');
        await this.prisma.$executeRaw`
          UPDATE outbox_events
          SET retry_count = ${attempts}, last_error = ${message}, locked_until = NULL, locked_by = NULL,
              next_attempt_at = now() + make_interval(secs => ${backoffSeconds})
          WHERE id = ${row.id} AND locked_by = ${claim}
        `;
      }
    }
    return rows.length;
  }

  /**
   * Re-queues parked FAILED events (after the cause was fixed). Returns how many were re-queued.
   * Operators can also do this in SQL: UPDATE outbox_events SET status='PENDING', retry_count=0 WHERE status='FAILED'.
   */
  public async redriveFailed(eventIds?: string[]): Promise<number> {
    if (eventIds?.length) {
      return this.prisma.$executeRaw`
        UPDATE outbox_events SET status = 'PENDING', retry_count = 0, next_attempt_at = NULL
        WHERE status = 'FAILED' AND id = ANY(${eventIds}::text[])
      `;
    }
    return this.prisma.$executeRaw`
      UPDATE outbox_events SET status = 'PENDING', retry_count = 0, next_attempt_at = NULL WHERE status = 'FAILED'
    `;
  }

  /** Number of parked events: anything above 0 needs a person (alerted on every batch) */
  public async failedCount(): Promise<number> {
    const [{ n }] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM outbox_events WHERE status = 'FAILED'`;
    return Number(n);
  }

  /**
   * Deletes PUBLISHED rows past the retention window in batches of `purgeBatchSize` rows per statement, so a
   * large backlog never becomes one long-running DELETE (statement_timeout, lock and WAL spikes). Stops when
   * a batch comes back short, the relay stops, or the time budget is used up. Returns the rows deleted.
   */
  public async purgePublished(): Promise<number> {
    const deadline = Date.now() + this.opts.purgeBudgetMs;
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM outbox_events
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE status = 'PUBLISHED' AND published_at < now() - make_interval(days => ${this.opts.retentionDays})
          LIMIT ${this.opts.purgeBatchSize}
        )
      `;
      total += deleted;
      if (deleted < this.opts.purgeBatchSize || this.stopped || Date.now() >= deadline) break;
    }
    if (total > 0) logger.info({ deleted: total }, 'Purged published outbox events');
    return total;
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

/** Errors that are about the message itself (the broker will reject it every time), not about availability */
const POISON_KAFKA_ERRORS = new Set(['MESSAGE_TOO_LARGE', 'RECORD_LIST_TOO_LARGE', 'INVALID_RECORD', 'CORRUPT_MESSAGE', 'INVALID_TOPIC_EXCEPTION']);
export function isPoisonPublishError(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  if (e instanceof TypeError || e instanceof RangeError) return true; // e.g. payload can't be serialised
  return POISON_KAFKA_ERRORS.has(e.type) || POISON_KAFKA_ERRORS.has(e.cause?.type);
}
