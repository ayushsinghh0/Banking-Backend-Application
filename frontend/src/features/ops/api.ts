import { useMemo } from 'react';
import type { ApiClient, QueryValue } from '@/lib/api/client';
import { useApiClient } from '@/lib/auth/AuthProvider';

/*
 * Endpoints the operations pages use (platform design, sections 6, 9 and 12). They live here rather than in
 * lib/api so the operations area can evolve without touching the shared client.
 */

// --- payments (payment-service, /api/v1/payments) -----------------------------------------------

export const TOP_UP_STATUSES = [
  'CREATED',
  'PENDING',
  'CAPTURED',
  'CREDITED',
  'CREDIT_BLOCKED',
  'REFUND_PENDING',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
] as const;
export type TopUpStatus = (typeof TOP_UP_STATUSES)[number];

/** Only these can be refunded: the customer's money was taken */
export const REFUNDABLE: readonly TopUpStatus[] = ['CREDITED', 'CREDIT_BLOCKED'];

export interface TopUpHistoryEntry {
  from: TopUpStatus | null;
  to: TopUpStatus;
  /** What moved it: 'customer', 'webhook', 'reconciler', 'admin', ... */
  source: string;
  at: string;
}

export interface TopUp {
  id: string;
  /** Present in staff views */
  customerId?: string | null;
  accountId: string;
  accountNumberLast4: string;
  amountPaise: string;
  currency: string;
  status: TopUpStatus;
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
  /** Oldest first; included when one top-up is read */
  history?: TopUpHistoryEntry[];
}

export interface TopUpFilters {
  status?: TopUpStatus;
  customerId?: string;
  /** Calendar days (YYYY-MM-DD), inclusive */
  from?: string;
  to?: string;
}

export interface StatusTotals {
  count: number;
  amountPaise: string;
}

/** Today's top-ups (IST business day) */
export interface PaymentsSummary {
  day: string | null;
  byStatus: Partial<Record<TopUpStatus, StatusTotals>>;
  /** 0 to 1, or null before anything has finished today */
  successRate: number | null;
  medianSecondsToCredit: number | null;
}

/** Whatever the reconciler counted on this run; rendered generically */
export type ReconcileReport = Record<string, unknown>;

// --- account security (auth-service, /api/v1/auth) -------------------------------------------------

export interface UserSession {
  id: string;
  current?: boolean;
  deviceLabel: string;
  /** Network part only, exactly as the API masks it ("203.0.113.x") */
  ipMasked: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** Signed in with the second factor */
  mfa: boolean;
}

export interface SecurityEvent {
  id: string;
  type: string;
  userId?: string | null;
  deviceLabel?: string | null;
  ipMasked?: string | null;
  at: string;
  details?: Record<string, unknown> | null;
}

export interface SecurityEventFilters {
  type?: string;
  userId?: string;
}

export interface IpRule {
  id: string;
  cidr: string;
  action: 'DENY';
  reason: string;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface IpRuleInput {
  cidr: string;
  reason: string;
  expiresInMinutes?: number;
}

export interface IpBan {
  /** Opaque key for lifting the ban; never shown */
  ipKey: string;
  ipMasked: string;
  reason?: string | null;
  bannedAt?: string | null;
  expiresAt?: string | null;
}

// --- audit (section 12) --------------------------------------------------------------------------

export interface AuditVerification {
  ok: boolean;
  checked: number;
  /** The first record whose hash doesn't follow from the one before */
  brokenAt?: string | number | null;
}

// --- paging --------------------------------------------------------------------------------------

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

type Body = Record<string, unknown> | undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const cursorOf = (...candidates: unknown[]): string | null => {
  for (const c of candidates) if (typeof c === 'string' && c) return c;
  return null;
};

/**
 * A cursor-paged list. The envelope carries the rows in `data` and the next cursor in `pagination.nextCursor`
 * (or top-level `nextCursor`); `data: { items, nextCursor }` is read too.
 */
export function toCursorPage<T>(body: unknown): CursorPage<T> {
  const envelope = asRecord(body);
  const data = envelope?.data;
  const pagination = asRecord(envelope?.pagination);
  if (Array.isArray(data)) {
    return { items: data as T[], nextCursor: cursorOf(pagination?.nextCursor, envelope?.nextCursor) };
  }
  const inner = asRecord(data);
  const items = Array.isArray(inner?.items) ? (inner.items as T[]) : [];
  return { items, nextCursor: cursorOf(inner?.nextCursor, pagination?.nextCursor, envelope?.nextCursor) };
}

/** Lists may arrive bare or as `{ items }` */
export function listOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const items = asRecord(data)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

/** `{ topUp }` or the top-up itself */
export function unwrapTopUp(data: unknown): TopUp {
  const record = asRecord(data);
  return (asRecord(record?.topUp) ?? record) as unknown as TopUp;
}

const isStatus = (value: unknown): value is TopUpStatus => (TOP_UP_STATUSES as readonly unknown[]).includes(value);

const toTotals = (value: unknown): StatusTotals => {
  const record = asRecord(value);
  const amount = record?.amountPaise ?? record?.sumPaise ?? record?.amount;
  return {
    count: Number(record?.count ?? 0) || 0,
    amountPaise: typeof amount === 'string' && /^\d+$/.test(amount) ? amount : typeof amount === 'number' ? String(Math.trunc(amount)) : '0',
  };
};

const toRate = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value > 1 ? value / 100 : value;
};

/** The summary with every status keyed by name, whether the API sends a map or a list */
export function normaliseSummary(data: unknown): PaymentsSummary {
  const record = asRecord(data) ?? {};
  const byStatus: PaymentsSummary['byStatus'] = {};
  const raw = record.byStatus;
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const status = asRecord(row)?.status;
      if (isStatus(status)) byStatus[status] = toTotals(row);
    }
  } else {
    for (const [status, totals] of Object.entries(asRecord(raw) ?? {})) {
      if (isStatus(status)) byStatus[status] = toTotals(totals);
    }
  }
  const median = record.medianSecondsToCredit;
  return {
    day: typeof record.day === 'string' ? record.day : typeof record.date === 'string' ? record.date : null,
    byStatus,
    successRate: toRate(record.successRate),
    medianSecondsToCredit: typeof median === 'number' && Number.isFinite(median) && median >= 0 ? median : null,
  };
}

const enc = encodeURIComponent;

export function createOpsApi(client: ApiClient) {
  const read = <T>(path: string, query?: Record<string, QueryValue>) => client.request<Body>(path, { query }).then((body) => body?.data as T);
  const page = <T>(path: string, query: Record<string, QueryValue>) => client.request<Body>(path, { query }).then((body) => toCursorPage<T>(body));
  const send = <T>(method: 'POST' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string) =>
    client.request<Body>(path, { method, body, idempotencyKey }).then((response) => response?.data as T);

  return {
    payments: {
      list: (filters: TopUpFilters & { limit: number; cursor?: string }) =>
        page<TopUp>('/payments/admin/top-ups', { ...filters }),
      get: (topUpId: string) => read<unknown>(`/payments/top-ups/${enc(topUpId)}`).then(unwrapTopUp),
      summary: () => read<unknown>('/payments/admin/summary').then(normaliseSummary),
      /** Bank-initiated; carries an idempotency key so a retry after step-up can never refund twice */
      refund: (topUpId: string, reason: string, idempotencyKey: string) =>
        send<unknown>('POST', `/payments/admin/top-ups/${enc(topUpId)}/refund`, { reason }, idempotencyKey).then(unwrapTopUp),
      reconcile: () => send<ReconcileReport>('POST', '/payments/admin/reconcile').then((report) => asRecord(report) ?? {}),
    },
    security: {
      sessions: (userId: string) => read<unknown>(`/auth/admin/users/${enc(userId)}/sessions`).then(listOf<UserSession>),
      revokeSession: (userId: string, sessionId: string) =>
        send<undefined>('DELETE', `/auth/admin/users/${enc(userId)}/sessions/${enc(sessionId)}`),
      events: (filters: SecurityEventFilters & { limit: number; cursor?: string }) =>
        page<SecurityEvent>('/auth/admin/security-events', { ...filters }),
      ipRules: () => read<unknown>('/auth/admin/ip-rules').then(listOf<IpRule>),
      addIpRule: (input: IpRuleInput) => send<IpRule>('POST', '/auth/admin/ip-rules', input),
      removeIpRule: (ruleId: string) => send<undefined>('DELETE', `/auth/admin/ip-rules/${enc(ruleId)}`),
      bans: () => read<unknown>('/auth/admin/ip-bans').then(listOf<IpBan>),
      liftBan: (ipKey: string) => send<undefined>('DELETE', `/auth/admin/ip-bans/${enc(ipKey)}`),
    },
    audit: {
      ledger: () => read<AuditVerification>('/transactions/audit/verify'),
      auth: () => read<AuditVerification>('/auth/admin/audit/verify'),
    },
  };
}

export type OpsApi = ReturnType<typeof createOpsApi>;

export function useOpsApi(): OpsApi {
  const client = useApiClient();
  return useMemo(() => createOpsApi(client), [client]);
}

/** Query keys for the operations pages, under one root so a sign-out or a live event can clear them together */
export const opsKeys = {
  all: ['ops'] as const,
  payments: ['ops', 'payments'] as const,
  paymentList: (filters: TopUpFilters, cursor: string | undefined) => ['ops', 'payments', 'list', filters, cursor ?? null] as const,
  paymentSummary: ['ops', 'payments', 'summary'] as const,
  payment: (topUpId: string) => ['ops', 'payments', 'detail', topUpId] as const,
  sessions: (userId: string) => ['ops', 'sessions', userId] as const,
  ipRules: ['ops', 'ip-rules'] as const,
  bans: ['ops', 'ip-bans'] as const,
  events: (filters: SecurityEventFilters, cursor: string | undefined) => ['ops', 'security-events', filters, cursor ?? null] as const,
  eventsAll: ['ops', 'security-events'] as const,
  audit: (log: 'ledger' | 'auth') => ['ops', 'audit', log] as const,
};
