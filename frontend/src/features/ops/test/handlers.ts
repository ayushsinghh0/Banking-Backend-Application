import { http, HttpResponse } from 'msw';
import { apiUrl, ok } from '@/test/render';
import { IDS } from '@/test/fixtures';
import type { AuditVerification, IpBan, IpRule, PaymentsSummary, SecurityEvent, TopUp, UserSession } from '../api';

/** Test data and MSW handlers for the operations pages. Register them per test with server.use(...). */

const AT = '2026-10-28T04:30:00.000Z';

export const aTopUp = (o: Partial<TopUp> = {}): TopUp => ({
  id: 'top-1',
  customerId: IDS.customer,
  accountId: IDS.savings,
  accountNumberLast4: '6789',
  amountPaise: '250000',
  currency: 'INR',
  status: 'CREDITED',
  method: 'upi',
  providerOrderId: 'order_P1x2',
  providerPaymentId: 'pay_Q9z8',
  failureReason: null,
  createdAt: AT,
  updatedAt: AT,
  creditedAt: '2026-10-28T04:30:41.000Z',
  expiresAt: '2026-10-28T05:00:00.000Z',
  refundedAt: null,
  refundReason: null,
  ...o,
});

export const aSummary = (o: Partial<PaymentsSummary> = {}): PaymentsSummary => ({
  day: '2026-10-28',
  byStatus: {
    CREDITED: { count: 18, amountPaise: '4525000' },
    PENDING: { count: 2, amountPaise: '300000' },
    FAILED: { count: 1, amountPaise: '50000' },
  },
  successRate: 0.947,
  medianSecondsToCredit: 38,
  ...o,
});

export const aSession = (o: Partial<UserSession> = {}): UserSession => ({
  id: 'sess-1',
  deviceLabel: 'Chrome on Windows',
  ipMasked: '203.0.113.x',
  createdAt: '2026-10-20T08:00:00.000Z',
  lastSeenAt: '2026-10-28T04:00:00.000Z',
  mfa: true,
  ...o,
});

export const aSecurityEvent = (o: Partial<SecurityEvent> = {}): SecurityEvent => ({
  id: 'evt-1',
  type: 'SIGN_IN_FAILED',
  userId: IDS.customer,
  deviceLabel: 'Safari on iPhone',
  ipMasked: '198.51.100.x',
  at: AT,
  details: null,
  ...o,
});

export const anIpRule = (o: Partial<IpRule> = {}): IpRule => ({
  id: 'rule-1',
  cidr: '203.0.113.0/24',
  action: 'DENY',
  reason: 'Card-testing traffic from this range',
  expiresAt: null,
  createdBy: IDS.admin2,
  createdAt: '2026-10-27T10:00:00.000Z',
  ...o,
});

export const aBan = (o: Partial<IpBan> = {}): IpBan => ({
  ipKey: 'ip4:198.51.100.23',
  ipMasked: '198.51.100.x',
  reason: 'Credential stuffing: 24 accounts in 10 minutes',
  bannedAt: '2026-10-28T04:10:00.000Z',
  expiresAt: '2026-10-28T04:40:00.000Z',
  ...o,
});

export const anAudit = (o: Partial<AuditVerification> = {}): AuditVerification => ({ ok: true, checked: 12840, ...o });

/** A JSON body (object or list), a whole Response, or a function of the request returning either */
export type Reply = object | ((request: Request) => object | Promise<object>);

const respond = async (reply: Reply, request: Request) => {
  const value = typeof reply === 'function' ? await reply(request) : reply;
  return value instanceof Response ? value.clone() : ok(value);
};

/** A cursor page envelope, as the list endpoints answer */
export const cursorPage = (data: unknown[], nextCursor: string | null = null) =>
  HttpResponse.json({ success: true, data, pagination: { limit: data.length, nextCursor } });

export const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams.entries());

/** GET /payments/admin/top-ups; `list` decides the page from the query */
export const topUpsHandler = (list: (query: Record<string, string>) => Response | Promise<Response>, calls?: Array<Record<string, string>>) =>
  http.get(apiUrl('/payments/admin/top-ups'), ({ request }) => {
    const query = queryOf(request);
    calls?.push(query);
    return list(query);
  });

export const summaryHandler = (reply: Reply = aSummary()) =>
  http.get(apiUrl('/payments/admin/summary'), ({ request }) => respond(reply, request));

export const topUpHandler = (reply: Reply = (request: Request) => ({ topUp: aTopUp({ id: new URL(request.url).pathname.split('/').pop() }) })) =>
  http.get(apiUrl('/payments/top-ups/:id'), ({ request }) => respond(reply, request));

export const sessionsHandler = (reply: Reply = [aSession()]) =>
  http.get(apiUrl('/auth/admin/users/:userId/sessions'), ({ request }) => respond(reply, request));

export const ipRulesHandler = (reply: Reply = [anIpRule()]) => http.get(apiUrl('/auth/admin/ip-rules'), ({ request }) => respond(reply, request));

export const bansHandler = (reply: Reply = [aBan()]) => http.get(apiUrl('/auth/admin/ip-bans'), ({ request }) => respond(reply, request));

export const eventsHandler = (list: (query: Record<string, string>) => Response | Promise<Response>, calls?: Array<Record<string, string>>) =>
  http.get(apiUrl('/auth/admin/security-events'), ({ request }) => {
    const query = queryOf(request);
    calls?.push(query);
    return list(query);
  });

export const auditHandlers = (ledger: Reply = anAudit(), auth: Reply = anAudit({ checked: 3120 })) => [
  http.get(apiUrl('/transactions/audit/verify'), ({ request }) => respond(ledger, request)),
  http.get(apiUrl('/auth/admin/audit/verify'), ({ request }) => respond(auth, request)),
];
