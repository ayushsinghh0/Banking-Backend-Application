import { delay, http } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { anAlert, IDS } from '@/test/fixtures';
import { STAFF, asStaff, queryOf, resetToasts } from './testing';
import { emitRealtime } from '@/features/ops/test/realtime';
import FraudAlertsPage from './FraudAlertsPage';

vi.mock('@/lib/realtime', async () => (await import('@/features/ops/test/realtime')).realtimeModule);

afterEach(resetToasts);

function alertsHandler(respond: (query: Record<string, string>) => Response | Promise<Response>) {
  const calls: Array<Record<string, string>> = [];
  server.use(
    http.get(apiUrl('/fraud/alerts'), ({ request }) => {
      const query = queryOf(request);
      calls.push(query);
      return respond(query);
    })
  );
  return calls;
}

const many = (n: number) => Array.from({ length: n }, (_, i) => anAlert({ id: `alert-${i}`, reason: `[OUTBOUND] Reason ${i}` }));

describe('FraudAlertsPage', () => {
  it('shows open alerts by default with severity in words', async () => {
    const calls = alertsHandler(() => ok([anAlert({ reason: '[OUTBOUND] Amount ₹2,50,000.00 exceeds the high-value threshold' })]));
    renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    expect(screen.getByRole('heading', { name: 'Fraud alerts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Open' })).toHaveAttribute('aria-selected', 'true');
    const open = await screen.findByRole('button', { name: /open alert: amount ₹2,50,000.00 exceeds the high-value threshold/i });
    const row = open.closest('tr') as HTMLElement;
    expect(within(row).getByText('High')).toBeInTheDocument();
    expect(within(row).getByText('Outgoing')).toBeInTheDocument();
    expect(within(row).getByText('aaaaaaaa…')).toBeInTheDocument();
    expect(within(row).getByText('11111111…')).toBeInTheDocument();
    expect(calls[0]).toEqual({ status: 'OPEN', limit: '20', offset: '0' });
  });

  it('flags alerts waiting for a second analyst', async () => {
    alertsHandler(() =>
      ok([anAlert({ status: 'UNDER_REVIEW', closeRequestedBy: STAFF.analyst2, closeRequestedStatus: 'RESOLVED' }), anAlert({ id: 'alert-2', reason: 'Velocity' })])
    );
    renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud?status=under_review', path: '/fraud' });
    const flagged = (await screen.findByRole('button', { name: /open alert: amount/i })).closest('tr') as HTMLElement;
    // Shown in the Review column, and under the reason on small screens (CSS shows one of them)
    expect(within(flagged).getAllByText('Awaiting second analyst')).toHaveLength(2);
    const plain = screen.getByRole('button', { name: /open alert: velocity/i }).closest('tr') as HTMLElement;
    expect(within(plain).queryByText('Awaiting second analyst')).not.toBeInTheDocument();
  });

  it('marks the analyst’s own proposals', async () => {
    alertsHandler(() => ok([anAlert({ status: 'UNDER_REVIEW', closeRequestedBy: STAFF.analyst, closeRequestedStatus: 'DISMISSED' })]));
    renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud?status=under_review', path: '/fraud' });
    expect(await screen.findAllByText('Your proposal')).toHaveLength(2);
  });

  it('announces loading', async () => {
    alertsHandler(async () => {
      await delay('infinite');
      return ok([]);
    });
    renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    expect(await screen.findByText('Loading alerts…')).toBeInTheDocument();
  });

  it('says when the queue is clear', async () => {
    alertsHandler(() => ok([]));
    renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    expect(await screen.findByText('No open alerts')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let attempt = 0;
    alertsHandler(() => (attempt++ === 0 ? fail(503, 'SERVICE_BUSY') : ok([anAlert()])));
    const { user } = renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    expect(await screen.findByText('Busy right now')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: /open alert: amount/i })).toBeInTheDocument();
  });

  it('switches between statuses', async () => {
    const calls = alertsHandler((query) => ok(query.status === 'RESOLVED' ? [anAlert({ status: 'RESOLVED', reason: 'Closed one' })] : []));
    const { user } = renderWithApp(<FraudAlertsPage />, { ...asStaff('SUPPORT'), route: '/fraud' });
    await screen.findByText('No open alerts');
    await user.click(screen.getByRole('tab', { name: 'Resolved' }));
    expect(await screen.findByRole('button', { name: /open alert: closed one/i })).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ status: 'RESOLVED', limit: '20', offset: '0' });
    await user.click(screen.getByRole('tab', { name: 'Dismissed' }));
    expect(await screen.findByText('No dismissed alerts')).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ status: 'DISMISSED', limit: '20', offset: '0' });
  });

  it('pages through alerts', async () => {
    const calls = alertsHandler((query) => ok(query.offset === '20' ? many(2) : many(20)));
    const { user } = renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    await screen.findByRole('button', { name: /open alert: reason 19/i });
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ status: 'OPEN', limit: '20', offset: '20' }));
    expect(await screen.findByText('Showing 21–22')).toBeInTheDocument();
  });

  it('opens an alert and hands it to the detail page', async () => {
    alertsHandler(() => ok([anAlert()]));
    const { user } = renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    await user.click(await screen.findByRole('button', { name: /open alert: amount/i }));
    const location = screen.getByTestId('location');
    expect(location).toHaveTextContent('/fraud/alert-1');
    expect(JSON.parse(location.getAttribute('data-state') ?? 'null')).toMatchObject({ alert: { id: 'alert-1', accountId: IDS.savings } });
  });

  it.each(['SUPPORT', 'BANK_ADMIN'] as const)('tells %s the view is read-only', async (role) => {
    alertsHandler(() => ok([]));
    renderWithApp(<FraudAlertsPage />, { ...asStaff(role), route: '/fraud' });
    expect(await screen.findByText(/only fraud analysts can triage alerts/i)).toBeInTheDocument();
  });

  it('does not show the read-only note to analysts', async () => {
    alertsHandler(() => ok([]));
    renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    await screen.findByText('No open alerts');
    expect(screen.queryByText(/only fraud analysts can triage alerts/i)).not.toBeInTheDocument();
  });

  it('refreshes the queue live and tells the analyst, with a way to the new alert', async () => {
    const calls = alertsHandler(() => ok([anAlert()]));
    renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    await screen.findByRole('button', { name: /open alert: amount/i });
    const before = calls.length;
    emitRealtime('fraud.alert', { alertId: 'alert-9', severity: 'HIGH', accountId: IDS.savings });
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('New alert')).toBeInTheDocument();
    expect(screen.getByText('High severity')).toBeInTheDocument();
    // A plain click: the toast's swipe handling wants pointer capture, which jsdom lacks
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/fraud/alert-9');
  });

  it('counts a burst of alerts into one toast', async () => {
    alertsHandler(() => ok([]));
    renderWithApp(<FraudAlertsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud' });
    await screen.findByText('No open alerts');
    emitRealtime('fraud.alert', { alertId: 'alert-8', severity: 'LOW', accountId: IDS.savings });
    expect(await screen.findByText('New alert')).toBeInTheDocument();
    emitRealtime('fraud.alert', { alertId: 'alert-9', severity: 'CRITICAL', accountId: IDS.savings });
    expect(await screen.findByText('2 new alerts')).toBeInTheDocument();
    expect(screen.queryByText('New alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View queue' })).toBeInTheDocument();
  });

  it('refreshes quietly for colleagues who don’t triage', async () => {
    const calls = alertsHandler(() => ok([]));
    renderWithApp(<FraudAlertsPage />, { ...asStaff('SUPPORT'), route: '/fraud' });
    await screen.findByText('No open alerts');
    const before = calls.length;
    emitRealtime('fraud.alert', { alertId: 'alert-9', severity: 'HIGH', accountId: IDS.savings });
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(screen.queryByText('New alert')).not.toBeInTheDocument();
  });
});
