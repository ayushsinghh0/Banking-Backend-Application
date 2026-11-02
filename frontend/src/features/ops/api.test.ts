import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, ok } from '@/test/render';
import { createServices } from '@/lib/api';
import { makeAccessToken } from '@/test/tokens';
import { createOpsApi, listOf, normaliseSummary, toCursorPage, unwrapTopUp } from './api';
import { aTopUp } from './test/handlers';

const opsApi = () => {
  const services = createServices();
  services.session.setAccessToken(makeAccessToken({ role: 'BANK_ADMIN', mfa: true }));
  return createOpsApi(services.client);
};

describe('toCursorPage', () => {
  it('reads rows from data and the cursor from pagination', () => {
    expect(toCursorPage({ success: true, data: [1, 2], pagination: { limit: 2, nextCursor: 'c2' } })).toEqual({ items: [1, 2], nextCursor: 'c2' });
  });

  it('reads a top-level cursor', () => {
    expect(toCursorPage({ success: true, data: [1], nextCursor: 'next' })).toEqual({ items: [1], nextCursor: 'next' });
  });

  it('reads { items, nextCursor } inside data', () => {
    expect(toCursorPage({ success: true, data: { items: ['a'], nextCursor: 'n' } })).toEqual({ items: ['a'], nextCursor: 'n' });
  });

  it('treats a missing or empty cursor as the last page', () => {
    expect(toCursorPage({ success: true, data: [], pagination: { nextCursor: '' } })).toEqual({ items: [], nextCursor: null });
    expect(toCursorPage(undefined)).toEqual({ items: [], nextCursor: null });
    expect(toCursorPage({ data: { nothing: true } })).toEqual({ items: [], nextCursor: null });
  });
});

describe('listOf', () => {
  it('accepts a bare list or { items }, and nothing else', () => {
    expect(listOf([1, 2])).toEqual([1, 2]);
    expect(listOf({ items: ['a'] })).toEqual(['a']);
    expect(listOf({ items: 'nope' })).toEqual([]);
    expect(listOf(undefined)).toEqual([]);
  });
});

describe('unwrapTopUp', () => {
  it('accepts { topUp } or the top-up itself', () => {
    const topUp = aTopUp();
    expect(unwrapTopUp({ topUp })).toEqual(topUp);
    expect(unwrapTopUp(topUp)).toEqual(topUp);
  });
});

describe('normaliseSummary', () => {
  it('keys a list of status totals by status', () => {
    const summary = normaliseSummary({
      day: '2026-10-28',
      byStatus: [
        { status: 'CREDITED', count: 3, amountPaise: '150000' },
        { status: 'NOT_A_STATUS', count: 9, amountPaise: '1' },
      ],
      successRate: 0.75,
      medianSecondsToCredit: 41,
    });
    expect(summary).toEqual({ day: '2026-10-28', byStatus: { CREDITED: { count: 3, amountPaise: '150000' } }, successRate: 0.75, medianSecondsToCredit: 41 });
  });

  it('accepts a map, percentages and missing figures', () => {
    const summary = normaliseSummary({ date: '2026-10-28', byStatus: { FAILED: { count: '2', sumPaise: 500 } }, successRate: 80 });
    expect(summary.byStatus.FAILED).toEqual({ count: 2, amountPaise: '500' });
    expect(summary.successRate).toBeCloseTo(0.8);
    expect(summary.medianSecondsToCredit).toBeNull();
    expect(summary.day).toBe('2026-10-28');
  });

  it('survives an unexpected body', () => {
    expect(normaliseSummary([])).toEqual({ day: null, byStatus: {}, successRate: null, medianSecondsToCredit: null });
    expect(normaliseSummary({ successRate: -1, medianSecondsToCredit: -5, byStatus: { CREDITED: { amountPaise: 'abc' } } })).toEqual({
      day: null,
      byStatus: { CREDITED: { count: 0, amountPaise: '0' } },
      successRate: null,
      medianSecondsToCredit: null,
    });
  });
});

describe('createOpsApi', () => {
  it('lists top-ups with filters and a cursor', async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl('/payments/admin/top-ups'), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ success: true, data: [aTopUp()], pagination: { limit: 25, nextCursor: 'abc' } });
      })
    );
    const page = await opsApi().payments.list({ status: 'CREDITED', customerId: undefined, from: '2026-10-01', limit: 25, cursor: 'xyz' });
    expect(page.nextCursor).toBe('abc');
    expect(page.items).toHaveLength(1);
    expect(Object.fromEntries(url!.searchParams)).toEqual({ status: 'CREDITED', from: '2026-10-01', limit: '25', cursor: 'xyz' });
  });

  it('refunds with the reason and an idempotency key', async () => {
    let seen: { key: string | null; body: unknown } | undefined;
    server.use(
      http.post(apiUrl('/payments/admin/top-ups/:id/refund'), async ({ request, params }) => {
        seen = { key: request.headers.get('Idempotency-Key'), body: await request.json() };
        return ok({ topUp: aTopUp({ id: String(params.id), status: 'REFUND_PENDING' }) });
      })
    );
    const topUp = await opsApi().payments.refund('top-1', 'Customer asked twice', 'key-1');
    expect(topUp.status).toBe('REFUND_PENDING');
    expect(seen).toEqual({ key: 'key-1', body: { reason: 'Customer asked twice' } });
  });

  it('returns an empty report when the reconciler says nothing', async () => {
    server.use(http.post(apiUrl('/payments/admin/reconcile'), () => new HttpResponse(null, { status: 204 })));
    expect(await opsApi().payments.reconcile()).toEqual({});
  });

  it('encodes path parameters', async () => {
    let path = '';
    server.use(
      http.delete(apiUrl('/auth/admin/ip-bans/:key'), ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      })
    );
    await opsApi().security.liftBan('ip4:198.51.100.0/24');
    expect(path).toBe('/api/v1/auth/admin/ip-bans/ip4%3A198.51.100.0%2F24');
  });
});
