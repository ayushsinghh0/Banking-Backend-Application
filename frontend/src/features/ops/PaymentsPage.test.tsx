import { delay, http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS } from '@/test/fixtures';
import { makeAccessToken } from '@/test/tokens';
import { asStaff, resetToasts } from '@/features/staff/testing';
import type { TopUp } from './api';
import { aSummary, aTopUp, cursorPage, summaryHandler, topUpHandler, topUpsHandler } from './test/handlers';
import { emitRealtime } from './test/realtime';
import PaymentsPage from './PaymentsPage';

vi.mock('@/lib/realtime', async () => (await import('./test/realtime')).realtimeModule);

afterEach(resetToasts);

const many = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => aTopUp({ id: `top-${start + i}`, amountPaise: String((start + i + 1) * 10000) }));

interface Setup {
  rows?: TopUp[] | ((query: Record<string, string>) => Response | Promise<Response>);
  summary?: Parameters<typeof summaryHandler>[0];
  detail?: Parameters<typeof topUpHandler>[0];
}

function setup({ rows = [aTopUp()], summary, detail }: Setup = {}) {
  const calls: Array<Record<string, string>> = [];
  let summaryCalls = 0;
  server.use(
    topUpsHandler((query) => (typeof rows === 'function' ? rows(query) : cursorPage(rows)), calls),
    summaryHandler((request) => {
      summaryCalls++;
      const handler = summary ?? aSummary();
      return typeof handler === 'function' ? (handler as (r: Request) => Response)(request) : handler;
    }),
    topUpHandler(detail)
  );
  return { calls, summaryCalls: () => summaryCalls };
}

const render = (role: 'BANK_ADMIN' | 'SUPPORT' | 'FRAUD_ANALYST' = 'BANK_ADMIN', route = '/payments') =>
  renderWithApp(<PaymentsPage />, { ...asStaff(role), route, path: '/payments' });

const openTopUp = (amount = '₹2,500.00') => screen.findByRole('button', { name: new RegExp(`^Open top-up: ${amount.replace(/[.]/g, '\\.')}`) });

describe('PaymentsPage — summary and list', () => {
  it('shows today’s key figures and the newest top-ups', async () => {
    const { calls } = setup();
    render();
    expect(screen.getByRole('heading', { level: 1, name: 'Payments' })).toBeInTheDocument();
    const today = screen.getByRole('region', { name: 'Today' });
    await waitFor(() => expect(today).toHaveTextContent('₹45,250.00'));
    expect(today).toHaveTextContent('Credited today');
    expect(today).toHaveTextContent(/Top-ups today\s*21/);
    expect(today).toHaveTextContent('94.7%');
    expect(today).toHaveTextContent('38 s');

    const row = (await openTopUp()).closest('tr') as HTMLElement;
    expect(within(row).getByText('Credited')).toBeInTheDocument();
    expect(within(row).getAllByText(/••••6789/).length).toBeGreaterThan(0);
    expect(within(row).getAllByText('UPI').length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ limit: '25' });
  });

  it('abbreviates a day’s volume from a crore up, keeping the exact amount for screen readers', async () => {
    setup({ summary: aSummary({ byStatus: { CREDITED: { count: 1834, amountPaise: '987654321098' } } }) });
    render();
    const today = screen.getByRole('region', { name: 'Today' });
    await waitFor(() => expect(today).toHaveTextContent('₹987.65 Cr'));
    expect(today).toHaveTextContent('₹9,87,65,43,210.98');
    expect(today).toHaveTextContent('1,834 top-ups');
  });

  it('says when nothing has happened yet today', async () => {
    setup({ rows: [], summary: aSummary({ byStatus: {}, successRate: null, medianSecondsToCredit: null }) });
    render();
    expect(await screen.findByText('No top-ups yet')).toBeInTheDocument();
    const today = screen.getByRole('region', { name: 'Today' });
    await waitFor(() => expect(today).toHaveTextContent('Nothing finished yet'));
  });

  it('keeps the list when today’s figures fail, with a retry', async () => {
    let attempt = 0;
    setup({ summary: () => (attempt++ === 0 ? fail(503, 'SERVICE_BUSY') : ok(aSummary())) });
    const { user } = render();
    await openTopUp();
    await user.click(await screen.findByRole('button', { name: /try again loading today’s figures/i }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('94.7%'));
  });

  it('shows a list error with a working retry', async () => {
    let attempt = 0;
    setup({ rows: () => (attempt++ === 0 ? fail(503, 'SERVICE_UNAVAILABLE') : cursorPage([aTopUp()])) });
    const { user } = render();
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await openTopUp()).toBeInTheDocument();
  });

  it('announces loading', async () => {
    setup({
      rows: async () => {
        await delay('infinite');
        return cursorPage([]);
      },
    });
    render();
    expect(await screen.findByText('Loading top-ups…')).toBeInTheDocument();
  });

  it('points at credits that couldn’t land and filters to them', async () => {
    const { calls } = setup({ summary: aSummary({ byStatus: { CREDIT_BLOCKED: { count: 2, amountPaise: '20000' } } }) });
    const { user } = render();
    expect(await screen.findByText('2 top-ups couldn’t be credited')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ status: 'CREDIT_BLOCKED', limit: '25' }));
    expect(screen.getByLabelText('Status')).toHaveValue('CREDIT_BLOCKED');
  });
});

describe('PaymentsPage — filters and paging', () => {
  it('filters by status, customer and dates', async () => {
    const { calls } = setup();
    const { user } = render();
    await openTopUp();
    await user.selectOptions(screen.getByLabelText('Status'), 'FAILED');
    await waitFor(() => expect(calls.at(-1)).toEqual({ status: 'FAILED', limit: '25' }));

    await user.type(screen.getByLabelText('Customer ID'), IDS.customer);
    await waitFor(() => expect(calls.at(-1)).toEqual({ status: 'FAILED', customerId: IDS.customer, limit: '25' }));

    await user.type(screen.getByLabelText('From'), '2026-10-01');
    await user.type(screen.getByLabelText('To'), '2026-10-28');
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({ status: 'FAILED', customerId: IDS.customer, from: '2026-10-01', to: '2026-10-28', limit: '25' })
    );
  });

  it('folds the filters behind a button on phones, open when one is set', async () => {
    setup();
    const { user, unmount } = render();
    const toggle = screen.getByRole('button', { name: 'Filters' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    unmount();
    setup();
    render('BANK_ADMIN', '/payments?status=FAILED&from=2026-10-01');
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('asks for a whole customer ID and a range that runs forwards', async () => {
    const { calls } = setup();
    const { user } = render();
    await openTopUp();
    await user.type(screen.getByLabelText('Customer ID'), '1234');
    expect(await screen.findByText('Enter the full customer ID')).toBeInTheDocument();
    expect(calls.every((c) => !('customerId' in c))).toBe(true);

    await user.type(screen.getByLabelText('From'), '2026-10-20');
    await user.type(screen.getByLabelText('To'), '2026-10-10');
    expect(await screen.findByText('Choose a date on or after the start date')).toBeInTheDocument();
    expect(calls.every((c) => !('to' in c))).toBe(true);
  });

  it('offers to clear filters when nothing matches', async () => {
    const { calls } = setup({ rows: (query) => cursorPage(query.status ? [] : [aTopUp()]) });
    const { user } = render('BANK_ADMIN', `/payments?status=EXPIRED&customerId=${IDS.customer}`);
    expect(await screen.findByText('No top-ups match these filters')).toBeInTheDocument();
    expect(screen.getByLabelText('Customer ID')).toHaveValue(IDS.customer);
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await openTopUp()).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ limit: '25' });
    expect(screen.getByLabelText('Customer ID')).toHaveValue('');
    // Nothing typed is written back once the debounce settles
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.at(-1)).toEqual({ limit: '25' });
  });

  it('pages with the cursor and back again', async () => {
    const { calls } = setup({ rows: (query) => (query.cursor === 'c2' ? cursorPage(many(2, 25)) : cursorPage(many(25), 'c2')) });
    const { user } = render();
    await openTopUp('₹100.00');
    expect(screen.getByText('Showing 1–25')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ limit: '25', cursor: 'c2' }));
    expect(await screen.findByText('Showing 26–27')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('Showing 1–25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });
});

describe('PaymentsPage — detail', () => {
  const history = [
    { from: null, to: 'CREATED' as const, source: 'customer', at: '2026-10-28T04:30:00.000Z' },
    { from: 'CREATED' as const, to: 'PENDING' as const, source: 'customer', at: '2026-10-28T04:30:05.000Z' },
    { from: 'PENDING' as const, to: 'CAPTURED' as const, source: 'webhook', at: '2026-10-28T04:30:30.000Z' },
    { from: 'CAPTURED' as const, to: 'CREDITED' as const, source: 'webhook', at: '2026-10-28T04:30:41.000Z' },
  ];

  it('opens a top-up with its status history', async () => {
    setup({ detail: { topUp: aTopUp({ history }) } });
    const { user } = render();
    await user.click(await openTopUp());
    const sheet = await screen.findByRole('dialog', { name: 'Top-up details' });
    expect(within(sheet).getByText('order_P1x2')).toBeInTheDocument();
    expect(within(sheet).getByText('pay_Q9z8')).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: /open customer/i })).toHaveAttribute('href', `/customers/${IDS.customer}`);
    const timeline = await within(sheet).findByRole('list', { name: 'Status history' });
    const steps = within(timeline).getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    expect(steps[3]).toHaveTextContent('Credited');
    expect(steps[3]).toHaveTextContent('Razorpay webhook');
  });

  it('opens straight from a link and closes back to the list', async () => {
    setup({ detail: { topUp: aTopUp({ id: 'top-9', amountPaise: '99900', history: [] }) } });
    const { user } = render('SUPPORT', '/payments?topUp=top-9');
    const sheet = await screen.findByRole('dialog', { name: 'Top-up details' });
    expect(await within(sheet).findByText('No status changes recorded yet.')).toBeInTheDocument();
    expect(sheet).toHaveTextContent('₹999.00');
    await user.click(within(sheet).getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('explains why a payment failed', async () => {
    const failed = aTopUp({ id: 'top-2', status: 'FAILED', failureReason: 'Payment declined by the bank', creditedAt: null, history: [] });
    setup({ rows: [failed], detail: { topUp: failed } });
    const { user } = render();
    await user.click(await openTopUp());
    const sheet = await screen.findByRole('dialog', { name: 'Top-up details' });
    expect(within(sheet).getByText('Payment declined by the bank')).toBeInTheDocument();
    // Nothing was taken, so nothing can be refunded
    expect(within(sheet).queryByRole('button', { name: 'Refund top-up' })).not.toBeInTheDocument();
  });

  it('shows a retry when the detail can’t be loaded', async () => {
    let attempt = 0;
    setup({ detail: () => (attempt++ === 0 ? fail(503, 'SERVICE_BUSY') : ok({ topUp: aTopUp({ history }) })) });
    const { user } = render();
    await user.click(await openTopUp());
    const sheet = await screen.findByRole('dialog', { name: 'Top-up details' });
    await user.click(await within(sheet).findByRole('button', { name: /try again/i }));
    expect(await within(sheet).findByRole('list', { name: 'Status history' })).toBeInTheDocument();
  });
});

describe('PaymentsPage — refunds', () => {
  const refundable = aTopUp({ history: [] });

  async function startRefund(user: ReturnType<typeof render>['user']) {
    await user.click(await openTopUp());
    const sheet = await screen.findByRole('dialog', { name: 'Top-up details' });
    await user.click(await within(sheet).findByRole('button', { name: 'Refund top-up' }));
    return screen.findByRole('dialog', { name: 'Refund this top-up' });
  }

  it('asks for a reason, confirms, steps up and refunds with one idempotency key', async () => {
    setup({ rows: [refundable], detail: { topUp: refundable } });
    const keys: Array<string | null> = [];
    const bodies: unknown[] = [];
    let attempt = 0;
    const fresh = makeAccessToken({ role: 'BANK_ADMIN', mfa: true, stepUpAt: Math.floor(Date.now() / 1000) });
    server.use(
      http.post(apiUrl('/payments/admin/top-ups/:id/refund'), async ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key'));
        bodies.push(await request.json());
        return attempt++ === 0
          ? fail(403, 'STEP_UP_REQUIRED', 'Step-up required')
          : ok({ topUp: aTopUp({ status: 'REFUND_PENDING', refundReason: 'Duplicate top-up by mistake', history: [] }) });
      }),
      http.post(apiUrl('/auth/mfa/step-up'), () => ok({ accessToken: fresh, expiresInSeconds: 900 }))
    );
    const { user } = render();
    const dialog = await startRefund(user);

    await user.type(within(dialog).getByLabelText('Reason'), 'Too short');
    await user.click(within(dialog).getByRole('button', { name: 'Review refund' }));
    expect(await within(dialog).findByText('Write at least 10 characters')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Reason'));
    await user.type(within(dialog).getByLabelText('Reason'), 'Duplicate top-up by mistake');
    await user.click(within(dialog).getByRole('button', { name: 'Review refund' }));

    const confirm = await screen.findByRole('dialog', { name: 'Refund ₹2,500.00?' });
    expect(confirm).toHaveTextContent('Duplicate top-up by mistake');
    expect(confirm).toHaveTextContent('••••6789');
    await user.click(within(confirm).getByRole('button', { name: 'Refund ₹2,500.00' }));

    await user.type(await screen.findByLabelText(/authenticator code/i), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));

    expect(await screen.findByText('Refund started')).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toEqual({ reason: 'Duplicate top-up by mistake' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /refund/i })).not.toBeInTheDocument());
  });

  it('explains a refund the API refuses and keeps the dialog open', async () => {
    setup({ rows: [refundable], detail: { topUp: refundable } });
    server.use(http.post(apiUrl('/payments/admin/top-ups/:id/refund'), () => fail(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds')));
    const { user } = render();
    const dialog = await startRefund(user);
    await user.type(within(dialog).getByLabelText('Reason'), 'Customer asked for their money back');
    await user.click(within(dialog).getByRole('button', { name: 'Review refund' }));
    await user.click(await screen.findByRole('button', { name: 'Refund ₹2,500.00' }));
    expect(await screen.findByText('Not enough balance to refund')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Refund ₹2,500.00?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Reason')).toHaveValue('Customer asked for their money back');
  });

  it('says a blocked credit is refunded without touching the account', async () => {
    const blocked = aTopUp({ status: 'CREDIT_BLOCKED', creditedAt: null, history: [] });
    setup({ rows: [blocked], detail: { topUp: blocked } });
    const { user } = render();
    const dialog = await startRefund(user);
    expect(dialog).toHaveTextContent(/never reached the account/i);
  });

  it.each(['SUPPORT', 'FRAUD_ANALYST'] as const)('is read-only for %s', async (role) => {
    setup({ rows: [refundable], detail: { topUp: refundable } });
    const { user } = render(role);
    await user.click(await openTopUp());
    const sheet = await screen.findByRole('dialog', { name: 'Top-up details' });
    await within(sheet).findByText('order_P1x2');
    expect(within(sheet).queryByRole('button', { name: 'Refund top-up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconcile now' })).not.toBeInTheDocument();
  });
});

describe('PaymentsPage — reconciliation and live updates', () => {
  it('runs the reconciler and shows its report', async () => {
    setup();
    server.use(http.post(apiUrl('/payments/admin/reconcile'), () => ok({ checked: 14, settled: 2, expired: 3, errors: [] })));
    const { user } = render();
    await user.click(screen.getByRole('button', { name: 'Reconcile now' }));
    const report = await screen.findByRole('dialog', { name: 'Reconciliation finished' });
    expect(within(report).getByText('Checked')).toBeInTheDocument();
    expect(within(report).getByText('14')).toBeInTheDocument();
    expect(within(report).getByText('Expired')).toBeInTheDocument();
  });

  it('says so when the reconciler had nothing to report', async () => {
    setup();
    server.use(http.post(apiUrl('/payments/admin/reconcile'), () => new HttpResponse(null, { status: 204 })));
    const { user } = render();
    await user.click(screen.getByRole('button', { name: 'Reconcile now' }));
    expect(await screen.findByText('Nothing needed attention.')).toBeInTheDocument();
  });

  it('reports a reconciler failure', async () => {
    setup();
    server.use(http.post(apiUrl('/payments/admin/reconcile'), () => fail(409, 'RECONCILE_IN_PROGRESS', 'A run is in progress')));
    const { user } = render();
    await user.click(screen.getByRole('button', { name: 'Reconcile now' }));
    expect(await screen.findByText('Already reconciling')).toBeInTheDocument();
  });

  it('refreshes the list and figures when a top-up changes', async () => {
    const { calls, summaryCalls } = setup();
    render();
    await openTopUp();
    await waitFor(() => expect(summaryCalls()).toBe(1));
    const before = calls.length;
    emitRealtime('payment.updated', { topUpId: 'top-1', status: 'REFUNDED', amountInPaise: '250000', accountId: IDS.savings });
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(summaryCalls()).toBe(2));
  });
});
