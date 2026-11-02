import { logger } from '@banksphere/common';
import { razorpayId, webhookSignature } from './signatures';

export interface WebhookDispatcherOptions {
  /** Target; null means webhooks are logged and dropped (nothing to deliver to) */
  url: string | null;
  secret: string;
  fetchImpl?: typeof fetch;
  /** One wait per retry, so the length is the number of retries after the first attempt */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  now?: () => Date;
}

export type DeliveryOutcome = 'delivered' | 'rejected' | 'failed' | 'skipped';

export interface WebhookDelivery {
  eventId: string;
  event: string;
  attempts: number;
  /** Last HTTP status seen, or null when the target never answered */
  status: number | null;
  outcome: DeliveryOutcome;
}

const ACCOUNT_ID = 'acc_SimulatorBank00';
const MAX_HISTORY = 200;

/**
 * Delivers Razorpay-style webhooks the way Razorpay does: the body is signed over its exact bytes with the
 * webhook secret (X-Razorpay-Signature), each event has an id (X-Razorpay-Event-Id) that is kept across
 * retries so the receiver can dedupe, and a 5xx or an unreachable target is retried a couple of times
 * while a 4xx is taken as final (the receiver has decided). Deliveries run in the background: the API
 * answer that caused them never waits, which is also how a real webhook can race the browser's confirm.
 */
export class WebhookDispatcher {
  public readonly deliveries: WebhookDelivery[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: number[];
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: WebhookDispatcherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 5_000];
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Schedules one event and returns its id */
  public send(event: string, payload: Record<string, { entity: unknown }>): string {
    const eventId = razorpayId('evt');
    const body = JSON.stringify({
      entity: 'event',
      account_id: ACCOUNT_ID,
      event,
      contains: Object.keys(payload),
      payload,
      created_at: Math.floor(this.now().getTime() / 1000),
    });
    const record: WebhookDelivery = { eventId, event, attempts: 0, status: null, outcome: 'skipped' };
    this.remember(record);
    if (!this.options.url) {
      logger.debug({ event, eventId }, 'SIM_WEBHOOK_URL not set; webhook dropped');
      return eventId;
    }
    const task = this.deliver(this.options.url, body, record).finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
    return eventId;
  }

  /** Resolves once every scheduled delivery has finished (retries included); for tests and shutdown */
  public async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  private async deliver(url: string, body: string, record: WebhookDelivery): Promise<void> {
    const signature = webhookSignature(body, this.options.secret);
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt - 1]));
      record.attempts = attempt + 1;
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Razorpay-Webhook/simulator',
            'x-razorpay-signature': signature,
            'x-razorpay-event-id': record.eventId,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        record.status = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (response.ok) {
          record.outcome = 'delivered';
          logger.info({ event: record.event, eventId: record.eventId, status: response.status, attempt: record.attempts }, 'Webhook delivered');
          return;
        }
        if (response.status < 500) {
          record.outcome = 'rejected';
          logger.warn({ event: record.event, eventId: record.eventId, status: response.status }, 'Webhook rejected by the receiver; not retried');
          return;
        }
        logger.warn({ event: record.event, eventId: record.eventId, status: response.status, attempt: record.attempts }, 'Webhook receiver failed; will retry');
      } catch (error) {
        record.status = null;
        logger.warn({ event: record.event, eventId: record.eventId, attempt: record.attempts, err: (error as Error).message }, 'Webhook receiver unreachable; will retry');
      }
    }
    record.outcome = 'failed';
    logger.error({ event: record.event, eventId: record.eventId, attempts: record.attempts }, 'Webhook delivery gave up');
  }

  private remember(record: WebhookDelivery): void {
    this.deliveries.push(record);
    if (this.deliveries.length > MAX_HISTORY) this.deliveries.splice(0, this.deliveries.length - MAX_HISTORY);
  }
}
