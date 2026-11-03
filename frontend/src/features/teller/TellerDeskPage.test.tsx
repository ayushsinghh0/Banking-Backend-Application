import { http } from 'msw';
import { toast } from 'sonner';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, aCashOperation, aProfile, aTellerSession } from '@/test/fixtures';
import type { AccountLookup, TellerSession, TransactionResult } from '@/lib/api/types';
import { formatBusinessDate, istToday } from '@/features/branch/components/cash';
import TellerDeskPage from './TellerDeskPage';

// Sonner replays still-active toasts into the next test's Toaster: clear them between tests
afterEach(() => {
  toast.dismiss();
  vi.useRealTimers();
});

// An open desk checks for the teller's operations still awaiting approval (they block closing)
beforeEach(() => {
  server.use(http.get(apiUrl('/transactions/cash-operations'), () => ok([])));
});

const today = istToday();
const session = (o: Partial<TellerSession> = {}) => aTellerSession({ businessDate: today, ...o });

const lookup = (o: Partial<AccountLookup> = {}): AccountLookup => ({
  id: IDS.savings,
  accountNumber: '100123456789',
  customerId: IDS.customer,
  accountType: 'SAVINGS',
  status: 'ACTIVE',
  ...o,
});

const aTransaction = (o: Partial<TransactionResult> = {}): TransactionResult => ({
  transactionId: 'txn-9',
  referenceId: 'TXN-DEP-20261027-0001',
  type: 'DEPOSIT',
  status: 'COMPLETED',
  amountInPaise: '250000',
  destinationAccountId: IDS.savings,
  createdAt: '2026-10-27T05:00:00.000Z',
  ...o,
});

const executed = (o: Partial<TransactionResult> = {}) =>
  ok({ status: 'EXECUTED', cashOperationId: 'cash-9', transaction: aTransaction(o) }, 201);

function currentSession(value: TellerSession | null) {
  server.use(http.get(apiUrl('/transactions/teller/sessions/current'), () => ok(value)));
}

/** An open desk with a findable, active account owned by Asha Rao */
function openDesk(account: AccountLookup = lookup()) {
  currentSession(session());
  server.use(
    http.get(apiUrl('/accounts/lookup'), ({ request }) =>
      new URL(request.url).searchParams.get('accountNumber') === account.accountNumber ? ok(account) : fail(404, 'NOT_FOUND')
    ),
    http.get(apiUrl(`/customers/${IDS.customer}`), () => ok(aProfile()))
  );
}

function renderDesk() {
  return renderWithApp(<TellerDeskPage />, {
    role: 'TELLER',
    claims: { sub: IDS.teller, email: 'meera.teller@banksphere.local' },
    route: '/teller',
  });
}

type User = ReturnType<typeof renderDesk>['user'];

async function findAccount(user: User, number = '1001 2345 6789') {
  await user.type(await screen.findByLabelText('Account number'), number);
  await user.click(screen.getByRole('button', { name: 'Find account' }));
}

async function reviewWithdrawal(user: User, amount = '2,500', code = '1234 5678') {
  await user.click(await screen.findByRole('tab', { name: 'Withdrawal' }));
  await findAccount(user);
  await screen.findByText('Asha Rao');
  await user.type(screen.getByLabelText('Amount'), amount);
  await user.type(screen.getByLabelText(/withdrawal code/i), code);
  await user.click(screen.getByRole('button', { name: 'Review withdrawal' }));
  await screen.findByRole('heading', { name: /check the details with the customer/i });
}

describe('TellerDeskPage — session states', () => {
  it('shows a loading state, then explains there is no float yet', async () => {
    currentSession(null);
    renderDesk();
    expect(screen.getByText(/loading your cash session/i)).toBeInTheDocument();
    expect(await screen.findByText('No float issued yet')).toBeInTheDocument();
    expect(screen.getByText(/ask your supervisor to issue today.s opening float/i)).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let calls = 0;
    server.use(
      http.get(apiUrl('/transactions/teller/sessions/current'), () => (++calls === 1 ? fail(500, 'INTERNAL_SERVER_ERROR') : ok(null)))
    );
    const { user } = renderDesk();
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('No float issued yet')).toBeInTheDocument();
  });

  it('checks for a float on demand', async () => {
    currentSession(null);
    const { user } = renderDesk();
    await screen.findByText('No float issued yet');
    currentSession(session({ status: 'ISSUED', acceptedAt: null }));
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('heading', { name: 'Count your opening float' })).toBeInTheDocument();
  });

  it('polls every 15 seconds while waiting for a float', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    currentSession(null);
    renderDesk();
    await screen.findByText('No float issued yet');
    currentSession(session({ status: 'ISSUED', acceptedAt: null }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await screen.findByRole('heading', { name: 'Count your opening float' })).toBeInTheDocument();
  });

  it('shows the business date', async () => {
    currentSession(session());
    renderDesk();
    expect(await screen.findByText(new RegExp(formatBusinessDate(today)))).toBeInTheDocument();
  });

  it('waits for sign-off after closing and never shows expected cash', async () => {
    currentSession(session({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z', expectedClosing: '7300000', declaredClosing: '7300000' }));
    renderDesk();
    expect(await screen.findByRole('heading', { name: 'Waiting for supervisor sign-off' })).toBeInTheDocument();
    expect(screen.getByText(/5:30 pm IST/)).toBeInTheDocument();
    expect(screen.queryByText(/73,000/)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Deposit' })).not.toBeInTheDocument();
  });

  it('lets the teller re-declare a miscounted closing count', async () => {
    let body: unknown;
    currentSession(session({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' }));
    server.use(
      http.post(apiUrl('/transactions/teller/sessions/close'), async ({ request }) => {
        body = await request.json();
        return ok({ id: 'sess-1', status: 'CLOSED', businessDate: today, closedAt: '2026-10-27T12:10:00.000Z' });
      })
    );
    const { user } = renderDesk();
    await user.click(await screen.findByRole('button', { name: /re-declare your count/i }));
    await user.type(screen.getByLabelText('Corrected cash count'), '72,950.50');
    await user.click(screen.getByRole('button', { name: 'Re-declare count' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/₹72,950\.50/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Replace count' }));
    await waitFor(() => expect(body).toEqual({ countedCashPaise: '7295050' }));
    expect(await screen.findByText('Count updated')).toBeInTheDocument();
  });

  it('shows the sign-off time once the day is reconciled', async () => {
    currentSession(
      session({
        status: 'RECONCILED',
        closedAt: '2026-10-27T12:00:00.000Z',
        signedOffAt: '2026-10-27T12:30:00.000Z',
        signedOffBy: IDS.admin,
        declaredClosing: '7300000',
        expectedClosing: '7320000',
        discrepancy: '-20000',
      })
    );
    renderDesk();
    expect(await screen.findByText(/day closed and signed off at 27 Oct 2026, 6:00 pm IST/i)).toBeInTheDocument();
    expect(screen.getByText('Short by ₹200.00')).toBeInTheDocument();
  });

  it('explains a cancelled float', async () => {
    currentSession(session({ status: 'CANCELLED', acceptedAt: null }));
    renderDesk();
    expect(await screen.findByRole('heading', { name: 'Float cancelled' })).toBeInTheDocument();
    expect(screen.getByText(/new float will appear here/i)).toBeInTheDocument();
  });

  it('blocks cash handling on a session from a previous business day', async () => {
    currentSession(session({ businessDate: '2020-01-01' }));
    renderDesk();
    expect(await screen.findByText(/this session is from a previous business day/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Deposit' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Cash in drawer')).toBeInTheDocument();
  });
});

describe('TellerDeskPage — opening float (blind count)', () => {
  it('never shows the issued amount, and accepts a matching count', async () => {
    let body: unknown;
    currentSession(session({ status: 'ISSUED', acceptedAt: null, openingFloat: '5000000' }));
    server.use(
      http.post(apiUrl('/transactions/teller/sessions/accept'), async ({ request }) => {
        body = await request.json();
        currentSession(session());
        return ok(session());
      })
    );
    const { user } = renderDesk();
    expect(await screen.findByRole('heading', { name: 'Count your opening float' })).toBeInTheDocument();
    expect(screen.queryByText(/50,000/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Total counted'), '50,000');
    await user.click(screen.getByRole('button', { name: 'Accept float' }));
    await waitFor(() => expect(body).toEqual({ countedFloatPaise: '5000000' }));
    expect(await screen.findByRole('tab', { name: 'Deposit' })).toBeInTheDocument();
  });

  it('validates the count and allows zero', async () => {
    let body: unknown;
    currentSession(session({ status: 'ISSUED', acceptedAt: null }));
    server.use(
      http.post(apiUrl('/transactions/teller/sessions/accept'), async ({ request }) => {
        body = await request.json();
        return ok(session());
      })
    );
    const { user } = renderDesk();
    await user.click(await screen.findByRole('button', { name: 'Accept float' }));
    expect(await screen.findByText('Enter an amount')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Total counted'), '0');
    await user.click(screen.getByRole('button', { name: 'Accept float' }));
    await waitFor(() => expect(body).toEqual({ countedFloatPaise: '0' }));
  });

  it('guides the teller to recount on FLOAT_MISMATCH and clears the count', async () => {
    currentSession(session({ status: 'ISSUED', acceptedAt: null }));
    server.use(http.post(apiUrl('/transactions/teller/sessions/accept'), () => fail(409, 'FLOAT_MISMATCH', 'mismatch')));
    const { user } = renderDesk();
    await user.type(await screen.findByLabelText('Total counted'), '49,500');
    await user.click(screen.getByRole('button', { name: 'Accept float' }));
    expect(await screen.findByText(/your count doesn.t match the float issued/i)).toBeInTheDocument();
    expect(screen.getByText(/ask your supervisor to cancel this float and issue a new one/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Total counted')).toHaveValue('');
  });

  it('explains a float issued for a previous day', async () => {
    currentSession(session({ status: 'ISSUED', acceptedAt: null }));
    server.use(http.post(apiUrl('/transactions/teller/sessions/accept'), () => fail(409, 'STALE_TELLER_SESSION', 'stale')));
    const { user } = renderDesk();
    await user.type(await screen.findByLabelText('Total counted'), '50,000');
    await user.click(screen.getByRole('button', { name: 'Accept float' }));
    expect(await screen.findByText(/this float is from a previous business day/i)).toBeInTheDocument();
  });
});

describe('TellerDeskPage — deposits', () => {
  it('finds the account, shows the holder and takes a deposit end to end', async () => {
    let body: unknown;
    let key: string | null = null;
    openDesk();
    server.use(
      http.post(apiUrl('/transactions/deposit'), async ({ request }) => {
        body = await request.json();
        key = request.headers.get('Idempotency-Key');
        return executed();
      })
    );
    const { user } = renderDesk();
    await findAccount(user);
    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('••••6789')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Amount'), '2,500');
    await user.type(screen.getByLabelText(/^Note/), 'Festival savings');
    await user.click(screen.getByRole('button', { name: 'Review deposit' }));
    const review = await screen.findByRole('region', { name: /check the details with the customer/i });
    expect(within(review).getByText('₹2,500.00')).toBeInTheDocument();
    expect(within(review).getByText('Festival savings')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm deposit' }));
    expect(await screen.findByRole('heading', { name: 'Deposit completed' })).toBeInTheDocument();
    expect(screen.getByText('TXN-DEP-20261027-0001')).toBeInTheDocument();
    expect(body).toEqual({ accountId: IDS.savings, amountInPaise: '250000', description: 'Festival savings' });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    await user.click(screen.getByRole('button', { name: 'New deposit' }));
    expect(screen.getByLabelText('Account number')).toHaveValue('');
  });

  it('validates the account number before looking it up', async () => {
    openDesk();
    const { user } = renderDesk();
    await findAccount(user, '1234');
    expect(await screen.findByText('Account numbers are 12 digits')).toBeInTheDocument();
  });

  it('says when no account has that number', async () => {
    openDesk();
    const { user } = renderDesk();
    await findAccount(user, '999999999999');
    expect(await screen.findByText(/no account has this number/i)).toBeInTheDocument();
  });

  it('still works when the holder name cannot be read', async () => {
    openDesk();
    server.use(http.get(apiUrl(`/customers/${IDS.customer}`), () => fail(404, 'NOT_FOUND')));
    const { user } = renderDesk();
    await findAccount(user);
    expect(await screen.findByText('Name unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();
  });

  it('blocks a frozen account', async () => {
    openDesk(lookup({ status: 'FROZEN' }));
    const { user } = renderDesk();
    await findAccount(user);
    expect(await screen.findByText(/this account is frozen/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
  });

  it('blocks the teller’s own account', async () => {
    openDesk(lookup({ customerId: IDS.teller }));
    server.use(http.get(apiUrl(`/customers/${IDS.teller}`), () => fail(404, 'NOT_FOUND')));
    const { user } = renderDesk();
    await findAccount(user);
    expect(await screen.findByText(/this is your own account/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
  });

  it('reuses the idempotency key when retrying, and makes a new one for a changed deposit', async () => {
    const keys: string[] = [];
    openDesk();
    server.use(
      http.post(apiUrl('/transactions/deposit'), ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');
        return keys.length < 3 ? fail(503, 'SERVICE_UNAVAILABLE', 'busy') : executed();
      })
    );
    const { user } = renderDesk();
    await findAccount(user);
    await screen.findByText('Asha Rao');
    await user.type(screen.getByLabelText('Amount'), '2,500');
    await user.click(screen.getByRole('button', { name: 'Review deposit' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm deposit' }));
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm deposit' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '3,000');
    await user.click(screen.getByRole('button', { name: 'Review deposit' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm deposit' }));
    expect(await screen.findByRole('heading', { name: 'Deposit completed' })).toBeInTheDocument();
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('explains when a deposit needs a supervisor’s approval', async () => {
    openDesk();
    server.use(http.post(apiUrl('/transactions/deposit'), () => ok({ status: 'PENDING_APPROVAL', cashOperationId: 'cash-7' }, 202)));
    const { user } = renderDesk();
    await findAccount(user);
    await screen.findByText('Asha Rao');
    await user.type(screen.getByLabelText('Amount'), '2,50,000');
    await user.click(screen.getByRole('button', { name: 'Review deposit' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm deposit' }));
    expect(await screen.findByRole('heading', { name: 'Sent to a supervisor for approval' })).toBeInTheDocument();
    expect(screen.getByText(/single-approval limit/i)).toBeInTheDocument();
    expect(screen.getByText(/keep the customer.s cash separate/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /my operations/i })).toHaveAttribute('href', '/teller/operations');
  });
});

describe('TellerDeskPage — withdrawals', () => {
  it('requires the customer’s 8-digit code and pays out', async () => {
    let body: unknown;
    openDesk();
    server.use(
      http.post(apiUrl('/transactions/withdraw'), async ({ request }) => {
        body = await request.json();
        return executed({ type: 'WITHDRAWAL', referenceId: 'TXN-WTH-0001' });
      })
    );
    const { user } = renderDesk();
    await user.click(await screen.findByRole('tab', { name: 'Withdrawal' }));
    await findAccount(user);
    await screen.findByText('Asha Rao');
    await user.type(screen.getByLabelText('Amount'), '2,500');
    await user.type(screen.getByLabelText(/withdrawal code/i), '1234');
    await user.click(screen.getByRole('button', { name: 'Review withdrawal' }));
    expect(await screen.findByText('Enter the customer’s 8-digit code')).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/withdrawal code/i));
    await user.type(screen.getByLabelText(/withdrawal code/i), '1234 5678');
    await user.click(screen.getByRole('button', { name: 'Review withdrawal' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm withdrawal' }));
    expect(await screen.findByRole('heading', { name: 'Withdrawal completed' })).toBeInTheDocument();
    expect(screen.getByText(/hand ₹2,500\.00 to the customer/i)).toBeInTheDocument();
    expect(body).toEqual({ accountId: IDS.savings, amountInPaise: '250000', authorizationCode: '12345678' });
  });

  it('explains a rejected withdrawal code and asks for it again', async () => {
    openDesk();
    server.use(http.post(apiUrl('/transactions/withdraw'), () => fail(403, 'WITHDRAWAL_NOT_AUTHORISED', 'bad code')));
    const { user } = renderDesk();
    await reviewWithdrawal(user);
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    expect(await screen.findByText(/the withdrawal code wasn.t accepted/i)).toBeInTheDocument();
    expect(screen.getByText(/exactly ₹2,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/repeated wrong codes cancel all of the customer.s codes/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/withdrawal code/i)).toHaveValue('');
  });

  it('tells the teller not to pay out while it waits for approval', async () => {
    openDesk();
    server.use(http.post(apiUrl('/transactions/withdraw'), () => ok({ status: 'PENDING_APPROVAL', cashOperationId: 'cash-8' }, 202)));
    const { user } = renderDesk();
    await reviewWithdrawal(user, '3,00,000');
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    expect(await screen.findByRole('heading', { name: 'Sent to a supervisor for approval' })).toBeInTheDocument();
    expect(screen.getByText(/don.t hand over any cash until it.s approved/i)).toBeInTheDocument();
  });

  it.each([
    ['NO_TELLER_SESSION', 409, /your cash session isn.t open/i],
    ['STALE_TELLER_SESSION', 409, /your session is from a previous business day/i],
    ['INSUFFICIENT_FUNDS', 422, /not enough balance/i],
    ['ACCOUNT_INACTIVE', 403, /this account is frozen or closed/i],
    ['FORBIDDEN', 403, /you can.t handle this transaction/i],
    ['DAILY_LIMIT_EXCEEDED', 422, /daily limit reached/i],
  ] as const)('explains %s', async (code, status, text) => {
    openDesk();
    server.use(http.post(apiUrl('/transactions/withdraw'), () => fail(status, code, code)));
    const { user } = renderDesk();
    await reviewWithdrawal(user);
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});

describe('TellerDeskPage — end of day', () => {
  it('closes with a blind count (zero allowed) after confirmation', async () => {
    let body: unknown;
    currentSession(session());
    server.use(
      http.post(apiUrl('/transactions/teller/sessions/close'), async ({ request }) => {
        body = await request.json();
        currentSession(session({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' }));
        return ok({ id: 'sess-1', status: 'CLOSED', businessDate: today, closedAt: '2026-10-27T12:00:00.000Z' });
      })
    );
    const { user } = renderDesk();
    await user.click(await screen.findByRole('button', { name: 'Close session' }));
    expect(await screen.findByText('Enter an amount')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Cash in drawer'), '0');
    await user.click(screen.getByRole('button', { name: 'Close session' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/₹0\.00/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Declare and close' }));
    await waitFor(() => expect(body).toEqual({ countedCashPaise: '0' }));
    expect(await screen.findByRole('heading', { name: 'Waiting for supervisor sign-off' })).toBeInTheDocument();
  });

  it('warns before closing while operations still await approval', async () => {
    let status: string | null = null;
    currentSession(session());
    server.use(
      http.get(apiUrl('/transactions/cash-operations'), ({ request }) => {
        status = new URL(request.url).searchParams.get('status');
        return ok([aCashOperation()]);
      })
    );
    renderDesk();
    expect(await screen.findByText(/1 operation is waiting for a supervisor/i)).toBeInTheDocument();
    expect(status).toBe('PENDING_APPROVAL');
  });

  it('keeps the dialog open and explains why closing failed', async () => {
    currentSession(session());
    server.use(
      http.post(apiUrl('/transactions/teller/sessions/close'), () =>
        fail(409, 'CONFLICT', '1 cash operation(s) still await approval; resolve them before closing')
      )
    );
    const { user } = renderDesk();
    await user.type(await screen.findByLabelText('Cash in drawer'), '73,000');
    await user.click(screen.getByRole('button', { name: 'Close session' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Declare and close' }));
    expect(await within(dialog).findByText(/still await approval/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /my operations/i })).toBeInTheDocument();
  });
});
