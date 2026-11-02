import crypto from 'crypto';
import { HttpError, isAddressAllowed, logger, normaliseClientIp } from '@banksphere/common';
import { RazorpayApi, RazorpayRequestError } from '../clients/razorpay.client';
import { PaymentConfig } from '../config';
import { verifyWebhookSignature } from '../domain/signatures';
import { webhookDeliveries } from '../metrics';
import { PaymentStore } from '../store/payment-store';
import { RefundService } from './refund.service';
import { SettlementService } from './settlement.service';

export const HANDLED_EVENTS = ['payment.authorized', 'payment.captured', 'order.paid', 'payment.failed', 'refund.processed', 'refund.failed'] as const;
type HandledEvent = (typeof HANDLED_EVENTS)[number];

export const MAX_WEBHOOK_BYTES = 64 * 1024;
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface WebhookDelivery {
  rawBody: Buffer | undefined;
  body: unknown;
  signature: string | undefined;
  eventId: string | undefined;
  ip: string | undefined;
  correlationId?: string;
}

export type WebhookResult = 'processed' | 'duplicate' | 'ignored';

const isHandled = (event: string): event is HandledEvent => (HANDLED_EVENTS as readonly string[]).includes(event);
const eventLabel = (event: unknown) => (typeof event === 'string' && isHandled(event) ? event : 'other');

function entity(body: any, name: 'payment' | 'order' | 'refund'): Record<string, unknown> | null {
  const value = body?.payload?.[name]?.entity;
  return value && typeof value === 'object' ? value : null;
}

const str = (value: unknown) => (typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null);

/**
 * POST /webhooks/razorpay. The order of checks matters:
 *   source allowlist (optional) -> size -> HMAC over the raw bytes (constant time) -> event id -> inbox dedupe
 * Only then is the event acted on, and even then never on the payload's word alone: payments are re-fetched
 * from Razorpay's API and go through the same settlement code as confirm; refunds resume the refund saga, which
 * reads the refund from Razorpay. A redelivered event (same X-Razorpay-Event-Id) is answered 200 and not
 * applied again. Unknown event types are acknowledged and ignored.
 */
export class WebhookService {
  constructor(
    private readonly store: PaymentStore,
    private readonly settlement: SettlementService,
    private readonly refunds: RefundService,
    private readonly razorpay: RazorpayApi,
    private readonly config: PaymentConfig
  ) {}

  public async handle(delivery: WebhookDelivery): Promise<WebhookResult> {
    const ip = normaliseClientIp(delivery.ip);
    if (this.config.webhookAllowedCidrs && !isAddressAllowed(this.config.webhookAllowedCidrs, delivery.ip)) {
      webhookDeliveries.inc({ event: 'unverified', result: 'rejected_source' });
      logger.warn({ alert: 'RAZORPAY_WEBHOOK_SOURCE_REJECTED', ip }, 'Razorpay webhook from an address outside RAZORPAY_WEBHOOK_ALLOWED_CIDRS');
      throw new HttpError(403, 'WEBHOOK_SOURCE_NOT_ALLOWED', 'Webhook source address is not allowed');
    }
    if (delivery.rawBody && delivery.rawBody.length > MAX_WEBHOOK_BYTES) {
      webhookDeliveries.inc({ event: 'unverified', result: 'too_large' });
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Webhook body exceeds 64 KB');
    }
    if (!verifyWebhookSignature(delivery.rawBody, delivery.signature, this.config.razorpay.webhookSecret)) {
      webhookDeliveries.inc({ event: 'unverified', result: 'invalid_signature' });
      // Security log: who tried, never what signature they sent
      logger.warn(
        { alert: 'RAZORPAY_WEBHOOK_SIGNATURE_INVALID', ip, eventId: str(delivery.eventId), hasSignature: Boolean(delivery.signature), bytes: delivery.rawBody?.length ?? 0 },
        'Rejected a Razorpay webhook with a missing or invalid signature'
      );
      throw new HttpError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature');
    }

    const body = delivery.body as { event?: unknown } | undefined;
    const event = typeof body?.event === 'string' ? body.event : '';
    const label = eventLabel(event);
    if (!delivery.eventId || !EVENT_ID.test(delivery.eventId) || !event) {
      webhookDeliveries.inc({ event: label, result: 'bad_request' });
      throw new HttpError(400, 'INVALID_WEBHOOK', 'Missing X-Razorpay-Event-Id or event type');
    }

    const claim = await this.store.claimWebhook({
      id: delivery.eventId,
      eventType: event.slice(0, 64),
      payloadHash: crypto.createHash('sha256').update(delivery.rawBody!).digest('hex'),
    });
    if (claim.outcome === 'duplicate') {
      webhookDeliveries.inc({ event: label, result: 'duplicate' });
      return 'duplicate';
    }
    if (claim.outcome === 'conflict') {
      webhookDeliveries.inc({ event: label, result: 'conflict' });
      logger.error(
        { alert: 'RAZORPAY_WEBHOOK_EVENT_ID_REUSED', eventId: delivery.eventId, event },
        'A signed webhook reused an event id with a different body; not applied'
      );
      return 'ignored';
    }

    try {
      const applied = isHandled(event) ? await this.dispatch(event, body, delivery.correlationId) : false;
      await this.store.finishWebhook(delivery.eventId, applied ? 'PROCESSED' : 'IGNORED');
      webhookDeliveries.inc({ event: label, result: applied ? 'processed' : 'ignored' });
      return applied ? 'processed' : 'ignored';
    } catch (error) {
      // A refusal of OUR making (e.g. a payment for another order) won't change on redelivery: ignore it.
      // Anything else (database, Razorpay or ledger unavailable) is retried by Razorpay: answer 5xx.
      // Razorpay refusing our follow-up call (e.g. an id it doesn't know) is just as final.
      const permanent = (error instanceof HttpError && error.statusCode < 500) || error instanceof RazorpayRequestError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.finishWebhook(delivery.eventId, permanent ? 'IGNORED' : 'FAILED', message).catch(() => undefined);
      webhookDeliveries.inc({ event: label, result: permanent ? 'ignored' : 'failed' });
      if (permanent) {
        logger.warn({ eventId: delivery.eventId, event, code: (error as HttpError).errorCode }, 'Razorpay webhook not applicable; ignored');
        return 'ignored';
      }
      logger.error({ eventId: delivery.eventId, event, err: message }, 'Razorpay webhook processing failed; Razorpay will redeliver');
      throw new HttpError(503, 'WEBHOOK_PROCESSING_FAILED', 'Webhook could not be processed; please retry');
    }
  }

  /** true when the event concerned one of our top-ups */
  private async dispatch(event: HandledEvent, body: unknown, correlationId?: string): Promise<boolean> {
    if (event === 'refund.processed' || event === 'refund.failed') {
      const refund = entity(body, 'refund');
      const providerRefundId = str(refund?.id);
      const notes = refund?.notes as Record<string, unknown> | undefined;
      const refundId = str(notes && !Array.isArray(notes) ? notes.refundId : null);
      if (!providerRefundId && !refundId) return false;
      const topUp = await this.store.findByRefund({ providerRefundId: providerRefundId ?? undefined, refundId: refundId ?? undefined });
      if (!topUp) return false;
      if (topUp.status === 'REFUND_PENDING') await this.refunds.advance(topUp, { source: 'webhook', correlationId });
      return true;
    }

    const payment = entity(body, 'payment');
    const order = entity(body, 'order');
    const paymentId = str(payment?.id);
    const orderId = str(payment?.order_id) ?? str(order?.id);
    if (!paymentId || !orderId) return false;
    const topUp = await this.store.findByProviderOrderId(orderId);
    if (!topUp) return false; // not one of ours (another integration on the same Razorpay account)
    // The signed payload says which payment changed; what it is now comes from Razorpay's API
    const fresh = await this.razorpay.fetchPayment(paymentId);
    await this.settlement.applyPayment(topUp.id, fresh, { source: 'webhook', correlationId });
    return true;
  }
}
