import { http } from 'msw';
import { toast } from 'sonner';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, aCashOperation, aDirectoryUser, anAccount } from '@/test/fixtures';
import type { Role } from '@/lib/auth/session';
import type { CashOperation } from '@/lib/api/types';
import CashOperationsPage from './CashOperationsPage';

// Sonner replays still-active toasts into the next test's Toaster: clear them between tests
afterEach(() => {
  toast.dismiss();
});

function directory() {
  server.use(
    http.get(apiUrl('/auth/admin/users'), ({ request }) =>
      new URL(request.url).searchParams.get('role') === 'TELLER' ? ok([aDirectoryUser()]) : ok([])
    )
  );
}

function account({ fails = false } = {}) {
  server.use(http.get(apiUrl(`/accounts/${IDS.savings}`), () => (fails ? fail(404, 'NOT_FOUND') : ok(anAccount()))));
}

function operations(respond: (status: string | null) => CashOperation[] | Response) {
  const seen: Array<{ status: string | null; limit: string | null; offset: string | null }> = [];
  server.use(
    http.get(apiUrl('/transactions/cash-operations'), ({ request }) => {
      const p = new URL(request.url).searchParams;
      seen.push({ status: p.get('status'), limit: p.get('limit'), offset: p.get('offset') });
      const result = respond(p.get('status'));
      return result instanceof Response ? result : ok(result);
    })
  );
  return seen;
}

const renderPage = (role: Role = 'BANK_ADMIN') =>
  renderWithApp(<CashOperationsPage />, { role, claims: { sub: IDS.admin }, route: '/cash-operations' });

const pendingWithdrawal = () => aCashOperation({ id: 'cash-w', type: 'WITHDRAWAL', amountInPaise: '30000000', description: null });

const executedResult = () => ({
  status: 'EXECUTED',
  cashOperationId: 'cash-1',
  transaction: {
    transactionId: 'txn-1',
    referenceId: 'TXN-DEP-0042',
    type: 'DEPOSIT',
    status: 'COMPLETED',
    amountInPaise: '25000000',
    createdAt: '2026-10-27T10:00:00.000Z',
  },
});

async function openApprove(user: ReturnType<typeof renderPage>['user'], name = /approve deposit/i) {
  await user.click(await screen.findByRole('button', { name }));
  return screen.findByRole('alertdialog');
}

describe('CashOperationsPage — list', () => {
  it('defaults to pending approvals and shows who asked, for which account', async () => {
    directory();
    account();
    const seen = operations(() => [aCashOperation()]);
    renderPage();
    const table = await screen.findByRole('table', { name: 'Cash operations' });
    expect(await within(table).findByText('Deposit')).toBeInTheDocument();
    expect(within(table).getByText('₹2,50,000.00')).toBeInTheDocument();
    expect(await within(table).findByText('••••6789')).toBeInTheDocument();
    expect(await within(table).findByText('meera.teller@banksphere.local')).toBeInTheDocument();
    expect(within(table).getByText(/27 Oct 2026, 3:00 pm IST/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pending approval' })).toHaveAttribute('aria-selected', 'true');
    expect(seen[0]).toEqual({ status: 'PENDING_APPROVAL', limit: '20', offset: '0' });
  });

  it('falls back to a short account id when the account cannot be read', async () => {
    directory();
    account({ fails: true });
    operations(() => [aCashOperation()]);
    renderPage();
    const table = await screen.findByRole('table', { name: 'Cash operations' });
    expect(await within(table).findByText('aaaaaaaa…')).toBeInTheDocument();
  });

  it('shows decided operations without actions on the other tabs', async () => {
    directory();
    account();
    const seen = operations((status) =>
      status === 'EXECUTED' ? [aCashOperation({ status: 'EXECUTED', approvedBy: IDS.admin2, decidedAt: '2026-10-27T10:00:00.000Z' })] : []
    );
    const { user } = renderPage();
    await screen.findByText('Nothing waiting for approval');
    await user.click(screen.getByRole('tab', { name: 'Executed' }));
    const table = await screen.findByRole('table', { name: 'Cash operations' });
    expect(await within(table).findByText('Executed')).toBeInTheDocument();
    expect(within(table).getByText(/3:30 pm IST/)).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(seen.at(-1)?.status).toBe('EXECUTED');
  });

  it('shows all operations on the All tab', async () => {
    directory();
    account();
    const seen = operations(() => []);
    const { user } = renderPage();
    await screen.findByText('Nothing waiting for approval');
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(await screen.findByText('No cash operations yet')).toBeInTheDocument();
    expect(seen.at(-1)?.status).toBeNull();
  });

  it('shows an error with a working retry', async () => {
    directory();
    account();
    let calls = 0;
    operations(() => (++calls === 1 ? fail(500, 'INTERNAL_SERVER_ERROR') : [aCashOperation()]));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('table', { name: 'Cash operations' })).toBeInTheDocument();
  });

  it('is read-only for support staff', async () => {
    directory();
    account();
    operations(() => [aCashOperation()]);
    renderPage('SUPPORT');
    await screen.findByText('₹2,50,000.00');
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });
});

describe('CashOperationsPage — decisions', () => {
  it('approves after confirmation with an idempotency key, then refreshes the list', async () => {
    directory();
    account();
    let key: string | null = null;
    let decided = false;
    const seen = operations(() => (decided ? [] : [aCashOperation()]));
    server.use(
      http.post(apiUrl('/transactions/cash-operations/cash-1/approve'), ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        decided = true;
        return ok(executedResult(), 201);
      })
    );
    const { user } = renderPage();
    await screen.findByText('••••6789');
    const dialog = await openApprove(user);
    expect(within(dialog).getByText(/₹2,50,000\.00 cash deposit to ••••6789/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve deposit' }));
    expect(await screen.findByText('Deposit approved')).toBeInTheDocument();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('Nothing waiting for approval')).toBeInTheDocument();
    expect(seen.length).toBeGreaterThan(1);
  });

  it('retries an approval with the same idempotency key', async () => {
    directory();
    account();
    const keys: string[] = [];
    operations(() => [aCashOperation()]);
    server.use(
      http.post(apiUrl('/transactions/cash-operations/cash-1/approve'), ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');
        return keys.length === 1 ? fail(503, 'SERVICE_UNAVAILABLE', 'busy') : ok(executedResult(), 201);
      })
    );
    const { user } = renderPage();
    const dialog = await openApprove(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve deposit' }));
    expect(await within(dialog).findByText('Temporarily unavailable')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve deposit' }));
    expect(await screen.findByText('Deposit approved')).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([
    ['FORBIDDEN', 403, 'forbidden', /you can.t approve a request you made, or one on your own account/i],
    ['CONFLICT', 409, 'This approval request has expired; reject it and ask the teller to submit a new one', /has expired/i],
    ['NO_TELLER_SESSION', 409, 'no session', /the teller.s cash session isn.t open/i],
    ['STALE_TELLER_SESSION', 409, 'stale', /the teller.s session is from a previous day/i],
    ['INSUFFICIENT_FUNDS', 422, 'funds', /no longer has enough money for this withdrawal/i],
  ] as const)('explains %s when approving', async (code, status, message, text) => {
    directory();
    account();
    operations(() => [pendingWithdrawal()]);
    server.use(http.post(apiUrl('/transactions/cash-operations/cash-w/approve'), () => fail(status, code, message)));
    const { user } = renderPage();
    const dialog = await openApprove(user, /approve withdrawal/i);
    await user.click(within(dialog).getByRole('button', { name: 'Approve withdrawal' }));
    expect(await within(dialog).findByText(text)).toBeInTheDocument();
  });

  it('rejects after confirmation and refreshes the list', async () => {
    directory();
    account();
    let decided = false;
    operations(() => (decided ? [] : [pendingWithdrawal()]));
    server.use(
      http.post(apiUrl('/transactions/cash-operations/cash-w/reject'), () => {
        decided = true;
        return ok({ cashOperationId: 'cash-w', status: 'REJECTED' });
      })
    );
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /reject withdrawal/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/new withdrawal code/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reject withdrawal' }));
    expect(await screen.findByText('Withdrawal rejected')).toBeInTheDocument();
    expect(await screen.findByText('Nothing waiting for approval')).toBeInTheDocument();
  });

  it('explains when a request was already decided', async () => {
    directory();
    account();
    operations(() => [aCashOperation()]);
    server.use(http.post(apiUrl('/transactions/cash-operations/cash-1/reject'), () => fail(409, 'CONFLICT', 'Cash operation is not pending')));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /reject deposit/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject deposit' }));
    expect(await within(dialog).findByText(/cash operation is not pending/i)).toBeInTheDocument();
  });
});
