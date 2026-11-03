import { KafkaService, TransientError, isDependencyUnavailableError, isTransientError, logger } from '@banksphere/common';
import { mapEvent } from '../events/mapping';
import { REALTIME_TOPICS, typeLabel } from '../events/types';
import { RealtimeStore } from '../redis/realtime-store';
import { realtimeMetrics } from '../metrics';

/**
 * Real-time events are hints for open pages: a few minutes of retries is worth it, hours are not (the
 * replay log only covers 24 h and the page will have refetched long before). After the last hop the message
 * goes to `<topic>.dlq` like any other consumer's.
 */
export const REALTIME_RETRY_DELAYS_MS = [15_000, 60_000, 300_000];

export interface RealtimeConsumerOptions {
  groupId: string;
  /** Events older than this are not pushed live (see REALTIME_MAX_EVENT_AGE_SECONDS) */
  maxEventAgeMs: number;
  now?: () => number;
}

/**
 * Consumer group `realtime-service-group`: turns domain events into real-time events (events/mapping.ts) and
 * hands them to Redis. Malformed or stale events are logged and skipped (a retry can't fix them). A Redis
 * connection problem is a TransientError, so the shared consumer retries in place and then through this
 * service's own retry topics (`realtime.<topic>.retry`). Any other Redis error (refused command, wrong key
 * type) is not transient: a few attempts, then the dead-letter topic.
 */
export class KafkaRealtimeConsumer {
  private readonly now: () => number;

  constructor(
    private readonly kafka: Pick<KafkaService, 'subscribe'>,
    private readonly store: RealtimeStore,
    private readonly options: RealtimeConsumerOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  public start(): void {
    this.kafka.subscribe(this.options.groupId, [...REALTIME_TOPICS], (topic, payload) => this.handle(topic, payload), {
      retryNamespace: 'realtime',
      retryDelaysMs: REALTIME_RETRY_DELAYS_MS,
    });
  }

  public async handle(topic: string, payload: unknown): Promise<void> {
    const result = mapEvent(topic, payload, new Date(this.now()));
    if (!result.ok) {
      realtimeMetrics.skipped.inc({ reason: 'malformed' });
      // Field names only: payloads can carry customer-chosen text
      logger.warn({ topic, eventId: result.eventId, reason: result.reason }, 'Malformed event skipped by the real-time consumer');
      return;
    }
    if (result.occurredAt && this.now() - result.occurredAt.getTime() > this.options.maxEventAgeMs) {
      realtimeMetrics.skipped.inc({ reason: 'stale' });
      logger.debug({ topic, eventId: result.eventId }, 'Stale event not pushed live');
      return;
    }

    // User deliveries first: they are idempotent (deduplicated in the replay log), so if a later step fails
    // and the message is retried, nobody gets a user event twice. Role events carry an id derived from the
    // Kafka event, so clients drop a repeat.
    const ordered = [...result.deliveries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'user' ? -1 : 1));
    for (const delivery of ordered) {
      try {
        if (delivery.kind === 'user') {
          const { duplicate } = await this.store.deliverToUser(delivery.userId, delivery.event, delivery.dedupeKey);
          if (duplicate) continue;
        } else {
          await this.store.publishToRole(delivery.role, { id: delivery.envelopeId, ...delivery.event });
        }
        realtimeMetrics.published.inc({ type: typeLabel(delivery.event.type) });
      } catch (err) {
        if (isTransientError(err) || isDependencyUnavailableError(err)) {
          throw new TransientError(`Real-time Redis unavailable: ${(err as Error)?.message ?? err}`);
        }
        throw err;
      }
    }
  }
}
