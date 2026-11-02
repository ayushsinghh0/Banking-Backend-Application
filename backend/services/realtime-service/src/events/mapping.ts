import { UserRole } from '@banksphere/common';
import { Delivery, MappingResult, RealtimeEventBody } from './types';

/**
 * Kafka event -> real-time events and their recipients (design section 8). Pure, so the whole table is
 * tested without Kafka or Redis.
 *
 * Events are hints (the browser refetches the truth), so they carry identifiers and a little context, and
 * only the fields the contract names: no names, emails, account numbers or free text from other services.
 * Everything is validated: ids end up in Redis key and channel names, so only plain identifiers pass.
 * A malformed event is reported, never thrown: it will not get better on a retry.
 */

/** UUIDs and similar opaque ids: no ':' or '*', so an id can never reach another key or channel */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Enum-like codes from the producers: TRANSFER, CREDITED, HIGH, FROZEN ... */
const CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
const PAISE = /^\d{1,18}$/;

const FRAUD_ALERT_ROLES: UserRole[] = ['FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT'];
const PAYMENT_ROLES: UserRole[] = ['BANK_ADMIN'];

const id = (value: unknown): string | null => (typeof value === 'string' && SAFE_ID.test(value) ? value : null);
const code = (value: unknown): string | null => (typeof value === 'string' && CODE.test(value) ? value : null);

function paise(value: unknown): string | null {
  if (typeof value === 'string' && PAISE.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A customer-chosen payee label made safe to show: no control or bidirectional-override characters (no
 * visual spoofing), collapsed whitespace, bounded length. Rendering escapes it again.
 */
export function plainLabel(value: unknown, maxLength = 64): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function body(type: RealtimeEventBody['type'], at: string, data: Record<string, unknown>): RealtimeEventBody {
  return { type, at, data };
}

function roleDeliveries(roles: UserRole[], eventId: string, event: RealtimeEventBody): Delivery[] {
  return roles.map((role) => ({ kind: 'role' as const, role, envelopeId: `r-${eventId}`, event }));
}

export function mapEvent(topic: string, payload: unknown, now: Date = new Date()): MappingResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'payload is not an object' };
  const p = payload as Record<string, unknown>;
  const eventId = id(p.eventId);
  if (!eventId) return { ok: false, reason: 'missing or invalid eventId' };
  const fail = (reason: string): MappingResult => ({ ok: false, eventId, reason });
  const occurred = isoDate(p.timestamp);
  const at = occurred ?? now.toISOString();
  const done = (deliveries: Delivery[]): MappingResult => ({ ok: true, eventId, deliveries, occurredAt: occurred ? new Date(occurred) : null });

  switch (topic) {
    case 'transaction.completed.v1': {
      const transactionId = id(p.transactionId);
      const type = code(p.type);
      const amountInPaise = paise(p.amountInPaise);
      if (!transactionId || !type || !amountInPaise) return fail('transactionId, type or amountInPaise missing or invalid');
      const deliveries: Delivery[] = [];
      // Both parties hear about their own side. A side without a customer (teller drawer, payment
      // clearing, vault) has nobody to tell.
      const sides = [
        { accountId: p.sourceAccountId, customerId: p.sourceCustomerId, direction: 'DEBIT', key: 'debit' },
        { accountId: p.destinationAccountId, customerId: p.destinationCustomerId, direction: 'CREDIT', key: 'credit' },
      ] as const;
      for (const side of sides) {
        if (side.customerId === undefined || side.customerId === null) continue;
        const customerId = id(side.customerId);
        const accountId = id(side.accountId);
        if (!customerId || !accountId) return fail(`${side.key} side has an invalid account or customer id`);
        deliveries.push({
          kind: 'user',
          userId: customerId,
          dedupeKey: `${eventId}:${side.key}`,
          event: body('transaction.posted', at, { transactionId, type, amountInPaise, accountId, direction: side.direction }),
        });
      }
      return done(deliveries);
    }

    case 'payment.updated.v1': {
      const topUpId = id(p.topUpId);
      const customerId = id(p.customerId);
      const accountId = id(p.accountId);
      const status = code(p.status);
      const amountInPaise = paise(p.amountInPaise);
      if (!topUpId || !customerId || !accountId || !status || !amountInPaise) return fail('payment fields missing or invalid');
      const event = body('payment.updated', at, { topUpId, status, amountInPaise, accountId });
      return done([{ kind: 'user', userId: customerId, dedupeKey: eventId, event }, ...roleDeliveries(PAYMENT_ROLES, eventId, event)]);
    }

    case 'fraud.alert.created.v1': {
      const alertId = id(p.alertId);
      const accountId = id(p.accountId);
      const severity = code(p.severity);
      if (!alertId || !accountId || !severity) return fail('alertId, accountId or severity missing or invalid');
      return done(roleDeliveries(FRAUD_ALERT_ROLES, eventId, body('fraud.alert', at, { alertId, severity, accountId })));
    }

    case 'account.status.changed.v1': {
      const accountId = id(p.accountId);
      const customerId = id(p.customerId);
      const status = code(p.status);
      if (!accountId || !customerId || !status) return fail('accountId, customerId or status missing or invalid');
      return done([{ kind: 'user', userId: customerId, dedupeKey: eventId, event: body('account.status', at, { accountId, status }) }]);
    }

    case 'beneficiary.added.v1': {
      const beneficiaryId = id(p.beneficiaryId);
      const customerId = id(p.customerId);
      const activatesAt = isoDate(p.activatesAt);
      const nickname = plainLabel(p.nickname) || 'Unnamed payee';
      if (!beneficiaryId || !customerId || !activatesAt) return fail('beneficiaryId, customerId or activatesAt missing or invalid');
      return done([
        { kind: 'user', userId: customerId, dedupeKey: eventId, event: body('payee.added', at, { beneficiaryId, nickname, activatesAt }) },
      ]);
    }

    default:
      return fail(`unexpected topic ${topic}`);
  }
}
