import { http } from 'msw';
import { toast } from 'sonner';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, aCashOperation } from '@/test/fixtures';
import type { CashOperation } from '@/lib/api/types';
import TellerOperationsPage from './TellerOperationsPage';

// Sonner replays still-active toasts into the next test's Toaster: clear them between tests
afterEach(() => {
  toast.dismiss();
});

interface Seen {
  status: string | null;
  limit: string | null;
  offset: string | null;
}

function operations(respond: (seen: Seen) => CashOperation[] | Response) {
  const seen: Seen[] = [];
  server.use(
    http.get(apiUrl('/transactions/cash-operations'), ({ request }) => {
      const params = new URL(request.url).searchParams;
      const entry = { status: params.get('status'), limit: params.get('limit'), offset: params.get('offset') };
      seen.push(entry);
      const result = respond(entry);
      return result instanceof Response ? result : ok(result);
    })
  );
  return seen;
}

const renderPage = () =>
  renderWithApp(<TellerOperationsPage />, { role: 'TELLER', claims: { sub: IDS.teller }, route: '/teller/operations' });

describe('TellerOperationsPage', () => {
  it('lists the teller’s operations, 20 at a time', async () => {
    const seen = operations(() => [
      aCashOperation({ id: 'c1', type: 'DEPOSIT', amountInPaise: '250000', status: 'EXECUTED', decidedAt: '2026-10-27T05:00:00.000Z' }),
      aCashOperation({ id: 'c2', type: 'WITHDRAWAL', amountInPaise: '30000000', status: 'PENDING_APPROVAL' }),
    ]);
    renderPage();
    const table = await screen.findByRole('table', { name: /your cash operations/i });
    expect(await within(table).findByText('₹2,500.00')).toBeInTheDocument();
    expect(within(table).getByText('₹3,00,000.00')).toBeInTheDocument();
    expect(within(table).getByText('Withdrawal')).toBeInTheDocument();
    expect(within(table).getByText('Pending approval')).toBeInTheDocument();
    expect(within(table).getByText('Executed')).toBeInTheDocument();
    expect(within(table).getAllByText('aaaaaaaa…')).toHaveLength(2);
    expect(within(table).getByText(/27 Oct 2026, 10:30 am IST/)).toBeInTheDocument();
    expect(seen[0]).toEqual({ status: null, limit: '20', offset: '0' });
  });

  it('filters by status and goes back to the first page', async () => {
    const seen = operations(({ status }) =>
      status === 'REJECTED'
        ? [aCashOperation({ id: 'r1', status: 'REJECTED' })]
        : Array.from({ length: 20 }, (_, i) => aCashOperation({ id: `c${i}`, status: 'EXECUTED' }))
    );
    const { user } = renderPage();
    await screen.findAllByText('Executed', { selector: 'td *' });
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(seen.at(-1)).toEqual({ status: null, limit: '20', offset: '20' }));
    await user.click(screen.getByRole('tab', { name: 'Rejected' }));
    await waitFor(() => expect(seen.at(-1)).toEqual({ status: 'REJECTED', limit: '20', offset: '0' }));
    expect(await screen.findByText('Rejected', { selector: 'td *' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Rejected' })).toHaveAttribute('aria-selected', 'true');
  });

  it('requests pending operations on the pending tab', async () => {
    const seen = operations(() => []);
    const { user } = renderPage();
    await screen.findByText('No cash operations yet');
    await user.click(screen.getByRole('tab', { name: 'Pending approval' }));
    expect(await screen.findByText('Nothing waiting for approval')).toBeInTheDocument();
    expect(seen.at(-1)?.status).toBe('PENDING_APPROVAL');
  });

  it('shows an empty state', async () => {
    operations(() => []);
    renderPage();
    expect(await screen.findByText('No cash operations yet')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let calls = 0;
    operations(() => (++calls === 1 ? fail(500, 'INTERNAL_SERVER_ERROR') : [aCashOperation({ status: 'EXECUTED' })]));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('table', { name: /your cash operations/i })).toBeInTheDocument();
  });
});
