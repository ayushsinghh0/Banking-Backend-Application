"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutboxService = void 0;
class OutboxService {
    prisma;
    kafkaPublisher;
    batchSize;
    maxRetries;
    isPolling = false;
    pollIntervalTimer = null;
    constructor(prisma, kafkaPublisher, batchSize = 50, maxRetries = 5) {
        this.prisma = prisma;
        this.kafkaPublisher = kafkaPublisher;
        this.batchSize = batchSize;
        this.maxRetries = maxRetries;
    }
    /**
     * Starts the background outbox polling loop
     */
    start(intervalMs = 2000) {
        if (this.pollIntervalTimer)
            return;
        this.pollIntervalTimer = setInterval(async () => {
            if (this.isPolling)
                return; // Prevent overlapping ticks
            this.isPolling = true;
            try {
                await this.processPendingEvents();
            }
            catch (error) {
                console.error('[OutboxService] Error processing outbox events:', error);
            }
            finally {
                this.isPolling = false;
            }
        }, intervalMs);
    }
    /**
     * Stops the background outbox polling loop cleanly
     */
    stop() {
        if (this.pollIntervalTimer) {
            clearInterval(this.pollIntervalTimer);
            this.pollIntervalTimer = null;
        }
    }
    /**
     * Reads pending outbox records using `FOR UPDATE SKIP LOCKED`
     * and publishes them to Apache Kafka.
     */
    async processPendingEvents() {
        return await this.prisma.$transaction(async (tx) => {
            // Postgres concurrency feature: SKIP LOCKED allows multiple worker nodes
            // to process separate batches in parallel without lock contention
            const pendingEvents = await tx.$queryRaw `
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
                }
                catch (publishError) {
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
        });
    }
}
exports.OutboxService = OutboxService;
