import { delay, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aCashOperation, anAdminRequest, anAlert, aTellerSession, IDS } from '@/test/fixtures';
import type { AdminRequest, CashOperation, FraudAlert, TellerSession } from '@/lib/api/types';
import { asAdmin, directoryLookupHandler, hoursAgo, hoursFromNow, ME } from './testData';
import { anAudit, auditHandlers } from '@/features/ops/test/handlers';
import { emitRealtime } from '@/features/ops/test/realtime';
import OverviewPage from './OverviewPage';

vi.mock('@/lib/realtime', async () => (await import('@/features/ops/test/realtime')).realtimeModule);

// sonner replays still-active toasts to every new Toaster, so clear them between tests
afterEach(() => {
  toast.dismiss();
});

type Reply<T> = T[] | (() => Response | Promise<Response>);

interface Queues {
  pendingRequests?: Reply<AdminRequest>;
  recentRequests?: Reply<AdminRequest>;
  pendingCash?: Reply<CashOperation>;
  allCash?: Reply<CashOperation>;
  closedSessions?: Reply<TellerSession>;
  openAlerts?: Reply<FraudAlert>;
  ledgerAudit?: Parameters<typeof auditHandlers>[0];
}

const reply = <T,>(value: Reply<T> | undefined) => (typeof value === 'function' ? value() : ok(value ?? []));

function setup(queues: Queues = {}) {
  const calls: Record<string, URLSearchParams[]> = { requests: [], cash: [], sessions: [], alerts: [] };
  const record = (name: string, request: Request) => {
    const params = new URL(request.url).searchParams;
    calls[name]?.push(params);
    return params;
  };
  server.use(
    http.get(apiUrl('/auth/admin/requests'), ({ request }) =>
      record('requests', request).get('status') === 'PENDING' ? reply(queues.pendingRequests) : reply(queues.recentRequests)
    ),
    http.get(apiUrl('/transactions/cash-operations'), ({ request }) =>
      record('cash', request).get('status') === 'PENDING_APPROVAL' ? reply(queues.pendingCash) : reply(queues.allCash)
    ),
    http.get(apiUrl('/transactions/teller/sessions'), ({ request }) => {
      record('sessions', request);
      return reply(queues.closedSessions);
    }),
    http.get(apiUrl('/fraud/alerts'), ({ request }) => {
      record('alerts', request);
      return reply(queues.openAlerts);
    }),
    directoryLookupHandler(),
    ...auditHandlers(queues.ledgerAudit)
  );
  const utils = renderWithApp(<OverviewPage />, { ...asAdmin, route: '/overview' });
  return { ...utils, calls };
}

const createStaff = anAdminRequest({ id: 'req-create', createdAt: hoursAgo(5), expiresAt: hoursFromNow(19) });
const mine = anAdminRequest({
  id: 'req-mine',
  requestedBy: ME.id,
  payload: { email: 'new.kyc@banksphere.local', role: 'KYC_OFFICER' },
  createdAt: hoursAgo(9),
});
const cash = aCashOperation({ id: 'cash-7', createdAt: hoursAgo(3) });
const closedSession = aTellerSession({ id: 'sess-9', status: 'CLOSED', closedAt: hoursAgo(8) });
const alert = anAlert({
  id: 'alert-1',
  createdAt: hoursAgo(1),
  reason: '[INBOUND] Transaction amount ₹6,00,000.00 exceeds threshold limit of ₹2,00,000.00 | Excessive transaction frequency: 4 transactions recorded within 60s',
});

describe('OverviewPage', () => {
  it('greets the administrator by name', async () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Priya$/ })).toBeInTheDocument();
    await screen.findByRole('link', { name: 'Open fraud alerts: 0' });
  });

  it('shows placeholders while the queues load', async () => {
    const slow = async () => {
      await delay(50);
      return ok([]);
    };
    setup({ pendingRequests: slow, pendingCash: slow, closedSessions: slow, openAlerts: slow, recentRequests: slow, allCash: slow });
    expect(screen.getAllByText('Loading').length).toBeGreaterThanOrEqual(4);
    expect(await screen.findByRole('link', { name: 'Open fraud alerts: 0' })).toBeInTheDocument();
  });

  it('counts each queue and links to it', async () => {
    const { calls } = setup({
      pendingRequests: [createStaff, mine],
      pendingCash: [cash],
      closedSessions: [],
      openAlerts: [alert, anAlert({ id: 'alert-2' }), anAlert({ id: 'alert-3' })],
    });
    expect(await screen.findByRole('link', { name: 'Pending four-eyes requests: 2' })).toHaveAttribute('href', '/approvals');
    expect(await screen.findByRole('link', { name: 'Cash awaiting approval: 1' })).toHaveAttribute('href', '/cash-operations');
    expect(await screen.findByRole('link', { name: 'Teller sessions to sign off: 0' })).toHaveAttribute('href', '/teller-sessions');
    expect(await screen.findByRole('link', { name: 'Open fraud alerts: 3' })).toHaveAttribute('href', '/fraud');

    const pending = calls.requests?.find((c) => c.get('status') === 'PENDING');
    expect(pending?.get('limit')).toBe('100');
    expect(calls.cash?.find((c) => c.get('status') === 'PENDING_APPROVAL')?.get('limit')).toBe('100');
    expect(calls.sessions?.[0]?.get('status')).toBe('CLOSED');
    expect(calls.sessions?.[0]?.get('limit')).toBe('100');
    expect(calls.alerts?.[0]?.get('status')).toBe('OPEN');
    expect(calls.alerts?.[0]?.get('limit')).toBe('100');
  });

  it('shows 100+ when a queue fills a whole page', async () => {
    setup({ openAlerts: Array.from({ length: 100 }, (_, i) => anAlert({ id: `alert-${i}` })) });
    expect(await screen.findByRole('link', { name: 'Open fraud alerts: 100+' })).toBeInTheDocument();
    expect(screen.getByText('100+')).toBeInTheDocument();
  });

  it('keeps the rest of the page working when one service fails, and retries it', async () => {
    let attempts = 0;
    const { user } = setup({
      pendingRequests: [createStaff],
      pendingCash: [cash],
      openAlerts: () => {
        attempts += 1;
        return attempts === 1 ? fail(503, 'SERVICE_UNAVAILABLE') : ok([alert]);
      },
    });
    const retry = await screen.findByRole('button', { name: 'Try again loading open fraud alerts' });
    expect(screen.getByRole('link', { name: 'Pending four-eyes requests: 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cash awaiting approval: 1' })).toBeInTheDocument();

    const attention = screen.getByRole('region', { name: 'Needs your attention' });
    expect(within(attention).getByText(/open fraud alerts couldn’t be loaded/i)).toBeInTheDocument();
    expect(within(attention).getByRole('link', { name: /create staff member/i })).toBeInTheDocument();

    await user.click(retry);
    expect(await screen.findByRole('link', { name: 'Open fraud alerts: 1' })).toBeInTheDocument();
    await waitFor(() => expect(within(attention).queryByText(/couldn’t be loaded/i)).not.toBeInTheDocument());
  });

  it('lists the oldest items across queues first, leaving out requests only someone else can decide', async () => {
    const expired = anAdminRequest({
      id: 'req-expired',
      payload: { email: 'late.teller@banksphere.local', role: 'TELLER' },
      createdAt: hoursAgo(30),
      expiresAt: hoursAgo(6),
    });
    setup({ pendingRequests: [createStaff, mine, expired], pendingCash: [cash], closedSessions: [closedSession], openAlerts: [alert] });
    const attention = screen.getByRole('region', { name: 'Needs your attention' });
    await waitFor(() => expect(within(attention).getAllByRole('listitem')).toHaveLength(4));

    const links = within(attention).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/teller-sessions', '/approvals', '/cash-operations', '/fraud/alert-1']);
    expect(links[0]).toHaveAccessibleName(/sign off teller session/i);
    expect(links[1]).toHaveAccessibleName(/create staff member/i);
    expect(links[2]).toHaveAccessibleName(/deposit of ₹2,50,000\.00/i);
    expect(links[3]).toHaveAccessibleName('Large amount and rapid transactions');
    expect(within(attention).getByText('Waiting 8 hours')).toBeInTheDocument();
    // The fraud service's raw reason is humanised: direction as a label, one sentence per signal, severity as a badge
    const fraud = within(attention).getAllByRole('listitem')[3] as HTMLElement;
    expect(within(fraud).getByText('Incoming')).toBeInTheDocument();
    expect(within(fraud).getByText('₹6,00,000.00 is over the ₹2,00,000.00 limit')).toBeInTheDocument();
    expect(within(fraud).getByText('4 transactions within 1 minute')).toBeInTheDocument();
    expect(within(fraud).getByText('High')).toBeInTheDocument();
    expect(within(fraud).queryByText(/\[INBOUND\]/)).not.toBeInTheDocument();
    // The staff request names the new colleague; the teller's sign-off names the teller (looked up by id)
    await waitFor(() => expect(within(attention).getAllByText(/meera\.teller@banksphere\.local/)).toHaveLength(2));
    // Not decidable here: my own request, and one that has already expired
    expect(within(attention).queryByText(/new\.kyc@banksphere\.local/)).not.toBeInTheDocument();
    expect(within(attention).queryByText(/late\.teller@banksphere\.local/)).not.toBeInTheDocument();
  });

  it('says when nothing needs attention', async () => {
    setup();
    const attention = screen.getByRole('region', { name: 'Needs your attention' });
    expect(await within(attention).findByText('You’re all caught up')).toBeInTheDocument();
  });

  it('shows the latest administrative requests', async () => {
    const approved = anAdminRequest({
      id: 'req-done',
      type: 'SET_USER_ACTIVE',
      status: 'APPROVED',
      payload: { userId: IDS.teller, isActive: false },
      targetUserId: IDS.teller,
      decidedBy: IDS.admin2,
      decidedAt: hoursAgo(2),
      createdAt: hoursAgo(4),
    });
    const { calls } = setup({ recentRequests: [createStaff, approved] });
    const recent = screen.getByRole('region', { name: 'Recent requests' });
    const items = await within(recent).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/create staff member/i);
    expect(items[0]).toHaveTextContent('Pending');
    expect(items[1]).toHaveTextContent(/disable sign-in/i);
    expect(items[1]).toHaveTextContent('Approved');
    expect(await within(items[1] as HTMLElement).findByText(/meera\.teller@banksphere\.local/)).toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'View all requests' })).toHaveAttribute('href', '/approvals');

    const latest = calls.requests?.find((c) => !c.has('status'));
    expect(latest?.get('limit')).toBe('5');
  });

  it('says when there are no administrative requests yet, and recovers from errors', async () => {
    let attempts = 0;
    const { user } = setup({
      recentRequests: () => {
        attempts += 1;
        return attempts === 1 ? fail(500, 'INTERNAL_SERVER_ERROR') : ok([]);
      },
    });
    const recent = screen.getByRole('region', { name: 'Recent requests' });
    await user.click(await within(recent).findByRole('button', { name: /try again/i }));
    expect(await within(recent).findByText('No administrative requests yet')).toBeInTheDocument();
  });

  it('summarises cash operations by status in text as well as a chart', async () => {
    setup({
      allCash: [
        aCashOperation({ id: 'c1' }),
        aCashOperation({ id: 'c2' }),
        aCashOperation({ id: 'c3', status: 'EXECUTED' }),
        aCashOperation({ id: 'c4', status: 'EXECUTED' }),
        aCashOperation({ id: 'c5', status: 'EXECUTED' }),
        aCashOperation({ id: 'c6', status: 'REJECTED' }),
      ],
    });
    const chart = screen.getByRole('region', { name: 'Cash operations by status' });
    const items = await within(chart).findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Awaiting approval2', 'Executed3', 'Rejected1']);
  });

  it('verifies the audit chains', async () => {
    setup();
    const card = await screen.findByRole('region', { name: 'Audit integrity' });
    await waitFor(() => expect(card).toHaveTextContent('12,840 records checked'));
    expect(card).toHaveTextContent('Sign-in and administration');
    expect(screen.queryByText('An audit log has been altered')).not.toBeInTheDocument();
  });

  it('raises a broken audit chain at the top of the page', async () => {
    setup({ ledgerAudit: anAudit({ ok: false, checked: 90, brokenAt: 'seq 77' }) });
    // A banner under the greeting; the card says which chain and where
    expect(await screen.findByText('An audit log has been altered')).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Audit integrity' });
    await waitFor(() => expect(card).toHaveTextContent('First broken link at record seq 77'));
  });

  it('refreshes the fraud alert count when a new alert arrives, without a toast', async () => {
    const { calls } = setup();
    await screen.findByRole('link', { name: 'Open fraud alerts: 0' });
    const before = calls.alerts!.length;
    emitRealtime('fraud.alert', { alertId: 'alert-5', severity: 'CRITICAL', accountId: IDS.savings });
    await waitFor(() => expect(calls.alerts!.length).toBeGreaterThan(before));
    expect(screen.queryByText('New alert')).not.toBeInTheDocument();
  });
});
