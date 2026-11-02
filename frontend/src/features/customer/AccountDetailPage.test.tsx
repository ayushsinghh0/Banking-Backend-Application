import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, anAccount, anEntry } from '@/test/fixtures';
import type { BankAccount } from '@/lib/api/types';
import { daysAgo, mockCustomerApi } from './testing';
import { dayHeading, formatTime } from './lib';
import AccountDetailPage from './AccountDetailPage';

const savings = anAccount();
const PATH = '/accounts/:accountId';
const render = (id: string = IDS.savings) => renderWithApp(<AccountDetailPage />, { route: `/accounts/${id}`, path: PATH });

function mockAccount(account: BankAccount, history = [anEntry()], balance = '12550075') {
  mockCustomerApi({ accounts: [account], balances: { [account.id]: balance }, history: { [account.id]: history } });
}

describe('AccountDetailPage', () => {
  it('shows the account, its balance, daily limit and statement', async () => {
    const debit = anEntry({ balanceAfterInPaise: '12300075' });
    const deposit = anEntry({
      entryId: 'entry-2',
      referenceId: 'TXN-DEP-2',
      type: 'DEPOSIT',
      entryType: 'CREDIT',
      amountInPaise: '5000000',
      balanceAfterInPaise: '12550075',
      description: null,
      createdAt: '2026-10-20T06:15:00.000Z',
    });
    mockAccount(savings, [debit, deposit]);
    render();
    expect(await screen.findByRole('heading', { level: 1, name: 'Savings account' })).toBeInTheDocument();
    expect(screen.getByText('1001 2345 6789')).toBeInTheDocument();
    const overview = screen.getByRole('region', { name: 'Account overview' });
    await waitFor(() => expect(overview).toHaveTextContent('₹1,25,500.75'));
    expect(within(overview).getByText('₹1,00,000.00')).toBeInTheDocument();

    const statement = screen.getByRole('region', { name: 'Statement' });
    await within(statement).findByText('Rent October');
    const rows = within(statement).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Rent October');
    expect(rows[0]).toHaveTextContent('REF-20261027-0001');
    expect(rows[0]).toHaveTextContent('-₹2,500.00');
    expect(rows[0]).toHaveTextContent('Balance after: ₹1,23,000.75');
    expect(rows[0]).toHaveTextContent(formatTime(debit.createdAt));
    expect(rows[1]).toHaveTextContent('Cash deposit');
    expect(rows[1]).toHaveTextContent('+₹50,000.00');
    // Rows are grouped under the day they happened
    expect(within(statement).getByRole('heading', { name: dayHeading(debit.createdAt) })).toBeInTheDocument();
    expect(within(statement).getByRole('heading', { name: dayHeading(deposit.createdAt) })).toBeInTheDocument();
  });

  it('draws how the balance moved once there is a week of history', async () => {
    mockAccount(savings, [anEntry({ createdAt: daysAgo(10), balanceAfterInPaise: '12550075' })]);
    render();
    const overview = await screen.findByRole('region', { name: 'Account overview' });
    expect(await within(overview).findByRole('img', { name: /balance from .* to .*₹1,25,500\.75/i })).toBeInTheDocument();
  });

  it('leaves the line out for an account with less than a week behind it', async () => {
    mockAccount(anAccount({ createdAt: daysAgo(2) }), [anEntry({ createdAt: daysAgo(1) })]);
    render();
    const statement = await screen.findByRole('region', { name: 'Statement' });
    await within(statement).findByText('Rent October');
    expect(within(screen.getByRole('region', { name: 'Account overview' })).queryByRole('img')).not.toBeInTheDocument();
  });

  it('pages through the statement twenty entries at a time', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => anEntry({ entryId: `e${i}`, description: `Payment ${i + 1}` }));
    const offsets: string[] = [];
    mockAccount(savings);
    server.use(
      http.get(apiUrl('/transactions/accounts/:id/history'), ({ request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        offsets.push(`${offset}/${url.searchParams.get('limit')}`);
        return ok(entries.slice(offset, offset + 20));
      })
    );
    const { user } = render();
    const statement = await screen.findByRole('region', { name: 'Statement' });
    await within(statement).findByText('Payment 1');
    expect(within(statement).getAllByRole('listitem')).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await within(statement).findByText('Payment 21')).toBeInTheDocument();
    await waitFor(() => expect(within(statement).getAllByRole('listitem')).toHaveLength(5));
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /previous/i })).toBeEnabled();
    expect(offsets).toEqual(['0/20', '20/20']);
  });

  it('shows an empty statement for a new account', async () => {
    mockAccount(savings, []);
    render();
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
  });

  it('shows a statement error with a retry', async () => {
    let calls = 0;
    mockCustomerApi({ accounts: [savings], balances: { [IDS.savings]: '1' } });
    server.use(
      http.get(apiUrl('/transactions/accounts/:id/history'), () => {
        calls += 1;
        return calls === 1 ? fail(503, 'SERVICE_BUSY', 'busy') : ok([anEntry()]);
      })
    );
    const { user } = render();
    expect(await screen.findByText('Busy right now')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Rent October')).toBeInTheDocument();
  });

  it('shows a friendly not-found state for an account that is not the customer’s', async () => {
    mockCustomerApi({ accounts: [] });
    render(IDS.current);
    expect(await screen.findByRole('heading', { name: 'Account not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to accounts/i })).toHaveAttribute('href', '/accounts');
  });

  it('does not call the API for a malformed account link', async () => {
    render('not-an-account');
    expect(await screen.findByRole('heading', { name: 'Account not found' })).toBeInTheDocument();
  });

  it('offers a transfer from this account and the account controls', async () => {
    mockAccount(savings);
    render();
    expect(await screen.findByRole('link', { name: /transfer from this account/i })).toHaveAttribute('href', `/transfer?from=${IDS.savings}`);
    expect(screen.getByRole('button', { name: /change daily limit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /freeze account/i })).toBeInTheDocument();
  });

  it('explains a frozen account and that only the bank can unfreeze it', async () => {
    mockAccount(anAccount({ status: 'FROZEN' }));
    render();
    expect(await screen.findByText('This account is frozen')).toBeInTheDocument();
    expect(screen.getByText(/only the bank can unfreeze it/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /transfer from this account/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /freeze account/i })).not.toBeInTheDocument();
  });

  it('offers transfers and adding money from an active account', async () => {
    mockAccount(savings);
    render();
    const actions = await screen.findByRole('region', { name: 'Account actions' });
    expect(within(actions).getByRole('link', { name: 'Transfer from this account' })).toHaveAttribute('href', `/transfer?from=${IDS.savings}`);
    expect(within(actions).getByRole('link', { name: 'Add money to this account' })).toHaveAttribute('href', `/add-money?account=${IDS.savings}`);
  });

  it('explains a closed account and offers no actions', async () => {
    mockAccount(anAccount({ status: 'CLOSED' }));
    render();
    expect(await screen.findByText('This account is closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change daily limit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add money/i })).not.toBeInTheDocument();
  });

  it('explains a daily limit ceiling set by the bank', async () => {
    mockAccount(anAccount({ dailyLimitPaise: '2000000', bankLimitCeilingPaise: '5000000' }));
    render();
    expect(await screen.findByText('Limit set by the bank: you can lower it, or raise it up to ₹50,000.00')).toBeInTheDocument();
  });

  it('changes the daily limit', async () => {
    let body: unknown;
    mockAccount(savings);
    server.use(
      http.patch(apiUrl(`/accounts/${IDS.savings}/daily-limit`), async ({ request }) => {
        body = await request.json();
        return ok(anAccount({ dailyLimitPaise: '5000000', version: 2 }));
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /change daily limit/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Change daily limit' });
    const input = within(dialog).getByLabelText('New daily limit');
    expect(input).toHaveValue('100000.00');
    await user.clear(input);
    await user.type(input, '50,000');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText('Daily limit updated')).toBeInTheDocument();
    expect(body).toEqual({ dailyLimitPaise: '5000000' });
    const overview = screen.getByRole('region', { name: 'Account overview' });
    expect(within(overview).getByText('₹50,000.00')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a new limit within the ceiling set by the bank', async () => {
    mockAccount(anAccount({ dailyLimitPaise: '2000000', bankLimitCeilingPaise: '5000000' }));
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /change daily limit/i }));
    const input = await screen.findByLabelText('New daily limit');
    await user.clear(input);
    await user.type(input, '60000');
    await user.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText('You can set up to ₹50,000.00, the limit set by the bank')).toBeInTheDocument();
  });

  it('explains when a limit is above what the customer may set', async () => {
    mockAccount(savings);
    server.use(
      http.patch(apiUrl(`/accounts/${IDS.savings}/daily-limit`), () =>
        fail(403, 'FORBIDDEN', 'Daily limits above 10000000 paise require bank approval')
      )
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /change daily limit/i }));
    const input = await screen.findByLabelText('New daily limit');
    await user.clear(input);
    await user.type(input, '200000');
    await user.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(
      await screen.findByText('That’s above the most you can set yourself (₹1,00,000.00). Contact the bank to raise it.')
    ).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('freezes the account after an explicit confirmation', async () => {
    let body: unknown;
    mockAccount(savings);
    server.use(
      http.patch(apiUrl(`/accounts/${IDS.savings}/status`), async ({ request }) => {
        body = await request.json();
        return ok(anAccount({ status: 'FROZEN', version: 2 }));
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /freeze account/i }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Freeze this account?' });
    expect(within(dialog).getByText(/you can’t unfreeze it yourself/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Freeze account' }));
    expect(await screen.findByText('This account is frozen')).toBeInTheDocument();
    expect(body).toEqual({ status: 'FROZEN' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('keeps the freeze dialog open when freezing fails', async () => {
    mockAccount(savings);
    server.use(http.patch(apiUrl(`/accounts/${IDS.savings}/status`), () => fail(503, 'SERVICE_UNAVAILABLE', 'down')));
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /freeze account/i }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Freeze this account?' });
    await user.click(within(dialog).getByRole('button', { name: 'Freeze account' }));
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: 'Freeze this account?' })).toBeInTheDocument();
  });
});
