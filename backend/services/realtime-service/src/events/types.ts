import { UserRole } from '@banksphere/common';

/** Kafka topics this service turns into real-time events (design section 8) */
export const REALTIME_TOPICS = [
  'transaction.completed.v1',
  'payment.updated.v1',
  'fraud.alert.created.v1',
  'account.status.changed.v1',
  'beneficiary.added.v1',
] as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

export const REALTIME_EVENT_TYPES = ['transaction.posted', 'payment.updated', 'fraud.alert', 'account.status', 'payee.added'] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/** Metric label for an event type: anything unexpected is folded into 'other' (bounded series count) */
export function typeLabel(type: string): string {
  return (REALTIME_EVENT_TYPES as readonly string[]).includes(type) ? type : 'other';
}

/** What a stream receives: `id` is the Redis stream id for user events (usable as Last-Event-ID) */
export interface RealtimeEnvelope {
  id: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/** An event before it has an id (the replay log assigns one) */
export interface RealtimeEventBody {
  type: RealtimeEventType;
  at: string;
  data: Record<string, unknown>;
}

/**
 * One recipient of one Kafka event.
 * - user: appended to the user's replay log and published on `rt:user:<userId>`; `dedupeKey` makes a
 *   redelivered Kafka message land only once.
 * - role: published on `rt:role:<ROLE>` only (staff queues; not replayable). `envelopeId` is derived from the
 *   Kafka event id, so a redelivery carries the same id and clients drop it.
 */
export type Delivery =
  | { kind: 'user'; userId: string; dedupeKey: string; event: RealtimeEventBody }
  | { kind: 'role'; role: UserRole; envelopeId: string; event: RealtimeEventBody };

export type MappingResult =
  | { ok: true; eventId: string; deliveries: Delivery[]; occurredAt: Date | null }
  | { ok: false; eventId?: string; reason: string };

export const userChannel = (userId: string) => `rt:user:${userId}`;
export const roleChannel = (role: UserRole) => `rt:role:${role}`;
export const userLogKey = (userId: string) => `rt:log:user:${userId}`;
export const userStreamsKey = (userId: string) => `rt:streams:user:${userId}`;
