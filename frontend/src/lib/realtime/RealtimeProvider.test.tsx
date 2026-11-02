import { useState } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { http } from 'msw';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { mockRealtimeStream } from '@/test/realtime';
import { IDS, anAccount } from '@/test/fixtures';
import { qk } from '@/lib/query';
import { useAuth } from '@/lib/auth/AuthProvider';
import { RealtimeProvider, useRealtimeEvent, useRealtimeStatus } from './index';

function Probe() {
  const status = useRealtimeStatus();
  const [seen, setSeen] = useState<string[]>([]);
  useRealtimeEvent<{ alertId: string }>('fraud.alert', (data) => setSeen((s) => [...s, data.alertId]));
  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="seen">{seen.join(',')}</p>
    </div>
  );
}

function SignOut() {
  const { endLocalSession } = useAuth();
  return (
    <button type="button" onClick={endLocalSession}>
      End session
    </button>
  );
}

function renderProvider(route = '/dashboard', options: { role?: 'CUSTOMER' | 'BANK_ADMIN'; hiddenPauseMs?: number } = {}) {
  return renderWithApp(
    <RealtimeProvider hiddenPauseMs={options.hiddenPauseMs}>
      <Probe />
      <SignOut />
    </RealtimeProvider>,
    { route, path: route, role: options.role ?? 'CUSTOMER' }
  );
}

const status = () => screen.getByTestId('status');

describe('RealtimeProvider', () => {
  it('opens the stream with the bearer token and hands events to subscribers', async () => {
    const stream = mockRealtimeStream();
    renderProvider();
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    expect(stream.connections[0]!.request.headers.get('authorization')).toMatch(/^Bearer /);
    expect(stream.connections[0]!.request.headers.get('accept')).toBe('text/event-stream');
    stream.send('fraud.alert', { alertId: 'al-1', severity: 'HIGH', accountId: IDS.savings });
    stream.send('fraud.alert', { alertId: 'al-2', severity: 'LOW', accountId: IDS.savings });
    await waitFor(() => expect(screen.getByTestId('seen')).toHaveTextContent('al-1,al-2'));
  });

  it('refreshes balances and history when money moves, and says when money arrives', async () => {
    const stream = mockRealtimeStream();
    const { queryClient } = renderProvider();
    queryClient.setQueryData(qk.accounts, [anAccount()]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    stream.send('transaction.posted', { transactionId: 'tx-1', type: 'TRANSFER', amountInPaise: '250000', accountId: IDS.savings, direction: 'CREDIT' });
    expect(await screen.findByText('₹2,500.00 received')).toBeInTheDocument();
    expect(screen.getByText('In Savings ••••6789')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.balances });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.historyAll });
  });

  it('stays quiet about money going out, and about top-ups already shown by a top-up', async () => {
    const stream = mockRealtimeStream();
    const { queryClient } = renderProvider();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    stream.send('transaction.posted', { transactionId: 'tx-2', type: 'TRANSFER', amountInPaise: '100', accountId: IDS.savings, direction: 'DEBIT' });
    stream.send('transaction.posted', { transactionId: 'tx-3', type: 'ONLINE_TOP_UP', amountInPaise: '100', accountId: IDS.savings, direction: 'CREDIT' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    expect(screen.queryByText(/received/)).not.toBeInTheDocument();
  });

  it('confirms a credited top-up and warns about a failed one', async () => {
    const stream = mockRealtimeStream();
    const { queryClient } = renderProvider();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    stream.send('payment.updated', { topUpId: 't1', status: 'CREDITED', amountInPaise: '50000', accountId: IDS.savings });
    expect(await screen.findByText('₹500.00 added')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.payments });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.balances });
    stream.send('payment.updated', { topUpId: 't2', status: 'FAILED', amountInPaise: '70000', accountId: IDS.savings });
    expect(await screen.findByText('Payment of ₹700.00 failed')).toBeInTheDocument();
    // In-between states only refresh the lists
    stream.send('payment.updated', { topUpId: 't3', status: 'PENDING', amountInPaise: '100', accountId: IDS.savings });
    await waitFor(() => expect(invalidate.mock.calls.filter(([f]) => f?.queryKey === qk.payments)).toHaveLength(3));
  });

  it('leaves top-up news to the Add money page while it is open', async () => {
    const stream = mockRealtimeStream();
    const { queryClient } = renderProvider('/add-money');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    stream.send('payment.updated', { topUpId: 't1', status: 'CREDITED', amountInPaise: '50000', accountId: IDS.savings });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.payments }));
    expect(screen.queryByText('₹500.00 added')).not.toBeInTheDocument();
  });

  it('keeps staff free of customer notifications but refreshes their queues', async () => {
    const stream = mockRealtimeStream();
    const { queryClient } = renderProvider('/overview', { role: 'BANK_ADMIN' });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    stream.send('payment.updated', { topUpId: 't1', status: 'CREDITED', amountInPaise: '50000', accountId: IDS.savings });
    stream.send('fraud.alert', { alertId: 'al-9', severity: 'HIGH', accountId: IDS.savings });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.alertsAll }));
    expect(screen.queryByText('₹500.00 added')).not.toBeInTheDocument();
  });

  it('refreshes accounts and payees when they change', async () => {
    const stream = mockRealtimeStream();
    const { queryClient } = renderProvider();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    stream.send('account.status', { accountId: IDS.savings, status: 'FROZEN' });
    stream.send('payee.added', { beneficiaryId: 'b1', nickname: 'Ravi', activatesAt: '2026-10-28T10:00:00Z' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.beneficiaries }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.accounts });
  });

  it('closes the stream when the session ends', async () => {
    const stream = mockRealtimeStream();
    const { user } = renderProvider();
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    await user.click(screen.getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(stream.openCount).toBe(0));
    expect(status()).toHaveTextContent('offline');
  });

  it('closes the stream on unmount', async () => {
    const stream = mockRealtimeStream();
    const { unmount } = renderProvider();
    await waitFor(() => expect(stream.openCount).toBe(1));
    unmount();
    await waitFor(() => expect(stream.openCount).toBe(0));
  });

  it('pauses while the tab is hidden for long and resumes where it left off', async () => {
    const stream = mockRealtimeStream();
    renderProvider('/dashboard', { hiddenPauseMs: 20 });
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    stream.send('fraud.alert', { alertId: 'al-1', severity: 'LOW', accountId: IDS.savings });
    await waitFor(() => expect(screen.getByTestId('seen')).toHaveTextContent('al-1'));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(status()).toHaveTextContent('offline'));
    expect(stream.openCount).toBe(0);
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    expect(stream.connections[1]!.request.headers.get('last-event-id')).toBe('1');
  });

  it('reconnects as soon as the device is back online', async () => {
    let calls = 0;
    const stream = mockRealtimeStream();
    server.use(
      http.get(apiUrl('/realtime/stream'), () => {
        calls += 1;
        // The first attempt fails; later ones fall through to the mock stream
        return calls === 1 ? fail(503, 'SERVICE_UNAVAILABLE', 'down') : undefined;
      })
    );
    renderProvider();
    await waitFor(() => expect(status()).toHaveTextContent('offline'));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    expect(stream.connections).toHaveLength(1);
  });

  it('lets a subscriber fail without stopping the others', async () => {
    const stream = mockRealtimeStream();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken() {
      useRealtimeEvent('fraud.alert', () => {
        throw new Error('boom');
      });
      return null;
    }
    renderWithApp(
      <RealtimeProvider>
        <Broken />
        <Probe />
      </RealtimeProvider>,
      { route: '/dashboard', path: '/dashboard' }
    );
    await waitFor(() => expect(status()).toHaveTextContent('open'));
    stream.send('fraud.alert', { alertId: 'al-5', severity: 'LOW', accountId: IDS.savings });
    await waitFor(() => expect(screen.getByTestId('seen')).toHaveTextContent('al-5'));
    expect(error).toHaveBeenCalled();
  });

  it('does nothing outside the provider', () => {
    server.use(http.get(apiUrl('/accounts'), () => ok([])));
    renderWithApp(<Probe />, { route: '/dashboard', path: '/dashboard' });
    expect(status()).toHaveTextContent('offline');
  });
});
