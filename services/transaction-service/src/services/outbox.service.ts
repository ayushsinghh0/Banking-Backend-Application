import { PrismaClient } from '../../generated/client';
import { logger } from '@banksphere/common';

export interface KafkaPublisher {
  publish(topic: string, key: string, payload: any): Promise<void>;
}

export class OutboxService {
  private isPolling = false;
  private pollIntervalTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly kafkaPublisher: KafkaPublisher,
    private readonly batchSize = 50,
    private readonly maxRetries = 5
  ) {}

  /**
   * Starts the background outbox polling loop
   */
  public start(intervalMs = 2000): void {
    if (this.pollIntervalTimer) return;

    this.pollIntervalTimer = setInterval(async () => {
      if (this.isPolling) return; // Prevent overlapping ticks
      this.isPolling = true;
      try {
        await this.processPendingEvents();
      } catch (error) {
        logger.error({ err: error }, 'Error processing outbox events');
      } finally {
        this.isPolling = false;
      }
    }, intervalMs);
  }

  /**
   * Stops the background outbox polling loop cleanly
   */
  public stop(): void {
    if (this.pollIntervalTimer) {
      clearInterval(this.pollIntervalTimer);
      this.pollIntervalTimer = null;
    }
  }

  /**
   * Reads pending outbox records using `FOR UPDATE SKIP LOCKED`
   * and publishes them to Apache Kafka.
   */
  public async processPendingEvents(): Promise<number> {
    return await this.prisma.$transaction(async (tx) => {
      // Postgres concurrency feature: SKIP LOCKED allows multiple worker nodes
      // to process separate batches in parallel without lock contention
      const pendingEvents = await tx.$queryRaw<
        Array<{
          id: string;
          aggregate_type: string;
          aggregate_id: string;
          event_type: string;
          payload: any;
          retry_count: number;
        }>
      >`
        SELECT id, aggregate_type, aggregate_id, event_type, payload, retry_count
        FROM outbox_events
        WHERE status = 'PENDING'
        ORDER BY created_at ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      if (pendingEvents.length === 0) {
        return 0;
      }

      for (const event of pendingEvents) {
        try {
          // Topic name convention matches event type (e.g., 'transaction.completed.v1')
          const topic = event.event_type;
          // Partition key is aggregate_id (e.g. transactionId) or accountId
          const partitionKey = event.aggregate_id;

          await this.kafkaPublisher.publish(topic, partitionKey, event.payload);

          // Mark published
          await tx.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: 'PUBLISHED',
              publishedAt: new Date(),
            },
          });
        } catch (publishError: any) {
          const newRetryCount = event.retry_count + 1;
          const isExhausted = newRetryCount >= this.maxRetries;

          await tx.outboxEvent.update({
            where: { id: event.id },
            data: {
              retryCount: newRetryCount,
              status: isExhausted ? 'FAILED' : 'PENDING',
              lastError: publishError?.message || 'Unknown Kafka dispatch failure',
            },
          });
        }
      }

      return pendingEvents.length;
    }, { timeout: 60000 }); // Kafka sends happen inside this tx; the default 5s would abort and re-publish the batch
  }
}
