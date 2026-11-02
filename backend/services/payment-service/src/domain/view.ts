import { HistoryEntry, TopUp } from './types';

export interface TopUpView {
  id: string;
  customerId?: string;
  accountId: string;
  accountNumberLast4: string;
  amountPaise: string;
  currency: string;
  status: TopUp['status'];
  method: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  creditedAt: string | null;
  expiresAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  history?: Array<{ from: string | null; to: string; source: string; at: string }>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The top-up as the API shows it (design section 6). Internal bookkeeping (idempotency key, request hash,
 * refund saga ids, ledger posting ids) never leaves the service; staff views add the customer id.
 */
export function toTopUpView(topUp: TopUp, options: { history?: HistoryEntry[]; staff?: boolean } = {}): TopUpView {
  return {
    id: topUp.id,
    ...(options.staff ? { customerId: topUp.customerId } : {}),
    accountId: topUp.accountId,
    accountNumberLast4: topUp.accountNumberLast4,
    amountPaise: topUp.amountPaise.toString(),
    currency: topUp.currency,
    status: topUp.status,
    method: topUp.method,
    providerOrderId: topUp.providerOrderId,
    providerPaymentId: topUp.providerPaymentId,
    failureReason: topUp.failureReason,
    createdAt: topUp.createdAt.toISOString(),
    updatedAt: topUp.updatedAt.toISOString(),
    creditedAt: iso(topUp.creditedAt),
    expiresAt: iso(topUp.expiresAt),
    refundedAt: iso(topUp.refundedAt),
    refundReason: topUp.refundReason,
    ...(options.history
      ? { history: options.history.map((h) => ({ from: h.from, to: h.to, source: h.source, at: h.at.toISOString() })) }
      : {}),
  };
}

/** Opaque keyset cursor over (createdAt DESC, id DESC) */
export function encodeCursor(topUp: Pick<TopUp, 'createdAt' | 'id'>): string {
  return Buffer.from(`${topUp.createdAt.toISOString()}|${topUp.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const [at, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  if (rest.length || !id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}
