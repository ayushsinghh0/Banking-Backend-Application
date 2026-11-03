import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, anAccount } from '@/test/fixtures';
import { makeAccessToken } from '@/test/tokens';
import type { WithdrawalCode } from '@/lib/api/types';
import { mockCustomerApi } from './testing';
import CashWithdrawalPage from './CashWithdrawalPage';

const savings = anAccount();
const current = anAccount({ id: IDS.current, accountNumber: '100111112222', accountType: 'CURRENT' });
const frozen = anAccount({ id: IDS.payeeAccount, accountNumber: '100133334444', status: 'FROZEN' });

const code = (o: Partial<WithdrawalCode> = {}): WithdrawalCode => ({
  authorizationCode: '12345678',
  accountId: IDS.current,
  amountInPaise: '500000',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  ...o,
});

function codesApi(...responses: Array<() => Response>) {
  const sent: unknown[] = [];
  server.use(
    http.post(apiUrl('/transactions/withdrawal-codes'), async ({ request }) => {
      sent.push(await request.json());
      return responses[Math.min(sent.length - 1, responses.length - 1)]!();
    })
  );
  return sent;
}

function setup(claims = {}) {
  mockCustomerApi({
    accounts: [savings, current, frozen],
    balances: { [IDS.savings]: '12550075', [IDS.current]: '4999925' },
  });
  return renderWithApp(<CashWithdrawalPage />, { route: '/cash-withdrawal', claims });
}

type User = ReturnType<typeof renderWithApp>['user'];

async function requestCode(user: User, amount = '5000', accountId: string = IDS.current) {
  await user.selectOptions(await screen.findByLabelText('Account'), accountId);
  await user.type(screen.getByLabelText('Amount'), amount);
  await user.click(screen.getByRole('button', { name: 'Create code' }));
}

describe('CashWithdrawalPage', () => {
  it('creates a one-time code and shows it once, with copy, a countdown and guidance', async () => {
    const sent = codesApi(() => ok(code(), 201));
    const { user } = setup();
    await requestCode(user);
    const card = await screen.findByRole('region', { name: 'Your withdrawal code' });
    expect(within(card).getByText('1234 5678')).toBeInTheDocument();
    expect(within(card).getByText(/your code is 1 2 3 4 5 6 7 8/i)).toBeInTheDocument();
    expect(within(card).getByText(/expires in 1[45]:\d\d/i)).toBeInTheDocument();
    expect(card).toHaveTextContent('₹5,000.00');
    expect(card).toHaveTextContent('Current ••••2222');
    expect(within(card).getByText(/show it to the teller together with your photo id/i)).toBeInTheDocument();
    expect(within(card).getByText(/works once/i)).toBeInTheDocument();
    expect(within(card).getByText(/creating a new code cancels this one/i)).toBeInTheDocument();
    expect(within(card).getByText(/never ask for this code/i)).toBeInTheDocument();
    expect(sent).toEqual([{ accountId: IDS.current, amountInPaise: '500000' }]);
    expect(screen.queryByRole('button', { name: 'Create code' })).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Copy code' }));
    expect(await navigator.clipboard.readText()).toBe('12345678');
  });

  it('forgets the code when the customer is done, but says a code is active', async () => {
    codesApi(() => ok(code(), 201));
    const { user } = setup();
    await requestCode(user);
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(screen.queryByText('1234 5678')).not.toBeInTheDocument();
    expect(screen.getByText(/a code for ₹5,000\.00 from current ••••2222 is active until/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create code' })).toBeInTheDocument();
  });

  it('hides the code once it expires and offers a new one', async () => {
    codesApi(() => ok(code({ expiresAt: new Date(Date.now() + 1200).toISOString() }), 201));
    const { user } = setup();
    await requestCode(user);
    expect(await screen.findByText('1234 5678')).toBeInTheDocument();
    expect(await screen.findByText('This code has expired', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText('1234 5678')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create a new code' }));
    expect(await screen.findByRole('button', { name: 'Create code' })).toBeInTheDocument();
  });

  it('asks for an authenticator code from ₹25,000 and then creates the code', async () => {
    const fresh = makeAccessToken({ mfa: true, stepUpAt: Math.floor(Date.now() / 1000) });
    server.use(http.post(apiUrl('/auth/mfa/step-up'), () => ok({ accessToken: fresh, expiresInSeconds: 900 })));
    const sent = codesApi(
      () => fail(403, 'STEP_UP_REQUIRED', 'Confirm this action with your authenticator'),
      () => ok(code({ amountInPaise: '3000000', accountId: IDS.savings }), 201)
    );
    const { user } = setup({ mfa: true });
    await user.selectOptions(await screen.findByLabelText('Account'), IDS.savings);
    await user.type(screen.getByLabelText('Amount'), '30000');
    expect(screen.getByText(/₹25,000\.00 or more need a code from your authenticator app/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create code' }));
    await user.type(await screen.findByLabelText(/authenticator code/i), '111222');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByText('1234 5678')).toBeInTheDocument();
    expect(sent).toHaveLength(2);
  });

  it('explains that larger codes need an authenticator when there is none', async () => {
    codesApi(() => fail(403, 'STEP_UP_REQUIRED', 'Confirm this action with your authenticator'));
    const { user } = setup({ mfa: false });
    await requestCode(user, '30000', IDS.savings);
    expect(await screen.findByRole('dialog', { name: /turn on two-factor authentication/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Set up an authenticator first')).toBeInTheDocument();
  });

  it('explains an amount above the daily withdrawal limit', async () => {
    codesApi(() => fail(422, 'AMOUNT_TOO_LARGE', 'Withdrawal codes cannot exceed the daily outflow limit'));
    const { user } = setup({ mfa: true, stepUpAt: Math.floor(Date.now() / 1000) });
    await requestCode(user, '600000', IDS.savings);
    expect(await screen.findByText('That’s more than you can withdraw in a day. Try a smaller amount.')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true');
  });

  it('warns, without blocking, when the amount is above the balance', async () => {
    const { user } = setup();
    await user.selectOptions(await screen.findByLabelText('Account'), IDS.current);
    await user.type(screen.getByLabelText('Amount'), '60000');
    expect(await screen.findByText(/more than the available balance of ₹49,999\.25/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create code' })).toBeEnabled();
  });

  it('checks the amount before asking the bank', async () => {
    const sent = codesApi(() => ok(code(), 201));
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Create code' }));
    expect(await screen.findByText('Enter an amount')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('offers only active accounts', async () => {
    setup();
    const select = await screen.findByLabelText('Account');
    expect(within(select).queryByRole('option', { name: /••••4444/ })).not.toBeInTheDocument();
    expect(within(select).getAllByRole('option')).toHaveLength(2);
  });

  it('explains that an active account is needed', async () => {
    mockCustomerApi({ accounts: [frozen], balances: {} });
    renderWithApp(<CashWithdrawalPage />, { route: '/cash-withdrawal' });
    expect(await screen.findByText('No active account')).toBeInTheDocument();
  });

  it('shows an error with a retry when accounts cannot be loaded', async () => {
    let calls = 0;
    mockCustomerApi({ balances: { [IDS.savings]: '1' } });
    server.use(
      http.get(apiUrl('/accounts'), () => {
        calls += 1;
        return calls === 1 ? fail(503, 'SERVICE_UNAVAILABLE', 'down') : ok([savings]);
      })
    );
    const { user } = renderWithApp(<CashWithdrawalPage />, { route: '/cash-withdrawal' });
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
  });
});
