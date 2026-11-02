import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, aBeneficiary, anAccount } from '@/test/fixtures';
import { makeAccessToken } from '@/test/tokens';
import type { TransactionResult } from '@/lib/api/types';
import { minutesFromNow, mockCustomerApi } from './testing';
import TransferPage from './TransferPage';

const savings = anAccount();
const current = anAccount({ id: IDS.current, accountNumber: '100111112222', accountType: 'CURRENT' });
const frozen = anAccount({ id: IDS.payeeAccount, accountNumber: '100133334444', status: 'FROZEN' });
const landlord = aBeneficiary({ activatesAt: minutesFromNow(-7 * 24 * 60) });
const plumber = aBeneficiary({ id: 'ben-2', nickname: 'Plumber', accountNumber: '100177778888', activatesAt: minutesFromNow(30) });

const result = (o: Partial<TransactionResult> = {}): TransactionResult => ({
  transactionId: 'txn-1',
  referenceId: 'TXN-TRF-1761555000000-AB12CD34',
  type: 'TRANSFER',
  status: 'COMPLETED',
  amountInPaise: '250000',
  sourceAccountId: IDS.savings,
  destinationAccountId: IDS.current,
  createdAt: new Date().toISOString(),
  ...o,
});

interface Sent {
  body: Record<string, unknown>;
  key: string | null;
}

/** Records every transfer request and answers with the given responses in turn (the last one repeats) */
function transferApi(...responses: Array<() => Response | Promise<Response>>) {
  const sent: Sent[] = [];
  server.use(
    http.post(apiUrl('/transactions/transfer'), async ({ request }) => {
      sent.push({ body: (await request.json()) as Record<string, unknown>, key: request.headers.get('Idempotency-Key') });
      const respond = responses[Math.min(sent.length - 1, responses.length - 1)]!;
      return respond();
    })
  );
  return sent;
}

function setup(route = '/transfer', claims = {}) {
  mockCustomerApi({
    accounts: [savings, current, frozen],
    balances: { [IDS.savings]: '12550075', [IDS.current]: '4999925', [IDS.payeeAccount]: '100' },
    beneficiaries: [landlord, plumber],
  });
  return renderWithApp(<TransferPage />, { route, path: '/transfer', claims });
}

type User = ReturnType<typeof renderWithApp>['user'];

async function fillOwn(user: User, amount = '2500') {
  await user.selectOptions(await screen.findByLabelText('From'), IDS.savings);
  await user.click(screen.getByRole('radio', { name: 'My accounts' }));
  await user.selectOptions(screen.getByLabelText('To account'), IDS.current);
  await user.clear(screen.getByLabelText('Amount'));
  await user.type(screen.getByLabelText('Amount'), amount);
  await user.click(screen.getByRole('button', { name: 'Review transfer' }));
  await screen.findByRole('heading', { name: 'Review your transfer' });
}

describe('TransferPage', () => {
  it('moves money between the customer’s own accounts with an idempotency key', async () => {
    const sent = transferApi(() => ok(result(), 201));
    const { user } = setup();
    await fillOwn(user);
    const review = screen.getByRole('region', { name: 'Review your transfer' });
    expect(review).toHaveTextContent('Savings ••••6789');
    expect(review).toHaveTextContent('Current ••••2222');
    expect(review).toHaveTextContent('₹2,500.00');
    await user.click(screen.getByRole('button', { name: 'Send ₹2,500.00' }));

    expect(await screen.findByRole('heading', { name: 'Money sent' })).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ sourceAccountId: IDS.savings, destinationAccountId: IDS.current, amountInPaise: '250000' });
    expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByText('TXN-TRF-1761555000000-AB12CD34')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy reference' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view statement/i })).toHaveAttribute('href', `/accounts/${IDS.savings}`);
  });

  it('shows the step the customer is on', async () => {
    const { user } = setup();
    const progress = await screen.findByRole('list', { name: 'Transfer progress' });
    expect(within(progress).getByText('Details').closest('li')).toHaveAttribute('aria-current', 'step');
    await fillOwn(user);
    expect(within(progress).getByText('Review').closest('li')).toHaveAttribute('aria-current', 'step');
  });

  it('pays a payee chosen from a link, with a note', async () => {
    const sent = transferApi(() => ok(result({ destinationAccountId: IDS.payeeAccount }), 201));
    const { user } = setup('/transfer?payee=ben-1');
    expect(await screen.findByRole('radio', { name: 'Payee' })).toBeChecked();
    expect(screen.getByLabelText('Recipient')).toHaveValue('ben-1');
    await user.type(screen.getByLabelText('Amount'), '12,000.50');
    await user.type(screen.getByLabelText(/note/i), 'October rent');
    await user.click(screen.getByRole('button', { name: 'Review transfer' }));
    const review = await screen.findByRole('region', { name: 'Review your transfer' });
    expect(review).toHaveTextContent('Ravi (landlord)');
    expect(review).toHaveTextContent('October rent');
    await user.click(screen.getByRole('button', { name: 'Send ₹12,000.50' }));
    expect(await screen.findByRole('heading', { name: 'Money sent' })).toBeInTheDocument();
    expect(sent[0]!.body).toEqual({
      sourceAccountId: IDS.savings,
      destinationAccountNumber: '100198765432',
      amountInPaise: '1200050',
      description: 'October rent',
    });
  });

  it('fills in a transfer drafted by Sphere for the customer to review', async () => {
    const sent = transferApi(() => ok(result({ destinationAccountId: IDS.payeeAccount, amountInPaise: '250000' }), 201));
    const { user } = setup(`/transfer?from=${IDS.current}&payeeName=ravi%20(LANDLORD)&amount=250000&note=October%20rent`);
    expect(await screen.findByLabelText('From')).toHaveValue(IDS.current);
    expect(screen.getByRole('radio', { name: 'Payee' })).toBeChecked();
    expect(screen.getByLabelText('Recipient')).toHaveValue('ben-1');
    expect(screen.getByLabelText('Amount')).toHaveValue('2500.00');
    expect(screen.getByLabelText(/note/i)).toHaveValue('October rent');
    // Nothing is sent until the customer reviews and confirms it
    expect(sent).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Review transfer' }));
    await user.click(await screen.findByRole('button', { name: 'Send ₹2,500.00' }));
    expect(await screen.findByRole('heading', { name: 'Money sent' })).toBeInTheDocument();
    expect(sent[0]!.body).toMatchObject({ sourceAccountId: IDS.current, destinationAccountNumber: '100198765432', amountInPaise: '250000', description: 'October rent' });
  });

  it('says when a drafted payee is not one of the customer’s payees, and ignores a bad amount', async () => {
    setup('/transfer?payeeName=Meera&amount=12.5');
    expect(await screen.findByText('We couldn’t find “Meera” in your payees')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Payee' })).toBeChecked();
    expect(screen.getByLabelText('Recipient')).toHaveValue('');
    expect(screen.getByLabelText('Amount')).toHaveValue('');
  });

  it('starts from the account in the link and shows its available balance', async () => {
    setup(`/transfer?from=${IDS.current}`);
    expect(await screen.findByLabelText('From')).toHaveValue(IDS.current);
    expect(await screen.findByText('Available balance: ₹49,999.25')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /••••4444/ })).not.toBeInTheDocument();
  });

  it('shows payees in their cooling-off period as not yet available', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('radio', { name: 'Payee' }));
    const option = screen.getByRole('option', { name: /plumber/i });
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent(/active from/i);
    expect(screen.getByRole('link', { name: /add a payee/i })).toHaveAttribute('href', '/payees?add=1');
  });

  it('warns about, and stops, an amount above the available balance', async () => {
    const { user } = setup();
    await user.selectOptions(await screen.findByLabelText('From'), IDS.current);
    await user.type(screen.getByLabelText('Amount'), '50000');
    expect(await screen.findByText(/more than the available balance of ₹49,999\.25/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review transfer' }));
    expect(screen.queryByRole('heading', { name: 'Review your transfer' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true');
  });

  it('checks the details before review', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('radio', { name: 'Payee' }));
    await user.click(screen.getByRole('button', { name: 'Review transfer' }));
    expect(await screen.findByText('Choose a payee')).toBeInTheDocument();
    expect(screen.getByText('Enter an amount')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Amount'), '12.345');
    await user.click(screen.getByRole('button', { name: 'Review transfer' }));
    expect(await screen.findByText('Enter an amount greater than ₹0.00')).toBeInTheDocument();
  });

  it('asks for an authenticator code on high-value transfers and retries with the same key', async () => {
    const fresh = makeAccessToken({ mfa: true, stepUpAt: Math.floor(Date.now() / 1000) });
    server.use(http.post(apiUrl('/auth/mfa/step-up'), () => ok({ accessToken: fresh, expiresInSeconds: 900 })));
    const sent = transferApi(
      () => fail(403, 'STEP_UP_REQUIRED', 'Confirm this action with your authenticator'),
      () => ok(result({ amountInPaise: '10000000' }), 201)
    );
    const { user } = setup('/transfer', { mfa: true });
    await fillOwn(user, '100000');
    expect(screen.getByText(/₹1,00,000\.00 or more need a code from your authenticator app/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send ₹1,00,000.00' }));
    await user.type(await screen.findByLabelText(/authenticator code/i), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByRole('heading', { name: 'Money sent' })).toBeInTheDocument();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.key).toBe(sent[0]!.key);
  });

  it('offers to try again with the same key after a temporary failure', async () => {
    const sent = transferApi(
      () => fail(503, 'SERVICE_BUSY', 'busy'),
      () => ok(result(), 201)
    );
    const { user } = setup();
    await fillOwn(user);
    await user.click(screen.getByRole('button', { name: 'Send ₹2,500.00' }));
    expect(await screen.findByText('Busy right now')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review your transfer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Money sent' })).toBeInTheDocument();
    expect(sent.map((s) => s.key)).toEqual([sent[0]!.key, sent[0]!.key]);
  });

  it('keeps the same key if the customer goes back after an unclear failure and sends the same transfer', async () => {
    const sent = transferApi(
      () => HttpResponse.error(),
      () => ok(result(), 201)
    );
    const { user } = setup();
    await fillOwn(user);
    await user.click(screen.getByRole('button', { name: 'Send ₹2,500.00' }));
    expect(await screen.findByText('You appear to be offline')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(await screen.findByRole('button', { name: 'Review transfer' }));
    await user.click(await screen.findByRole('button', { name: 'Send ₹2,500.00' }));
    expect(await screen.findByRole('heading', { name: 'Money sent' })).toBeInTheDocument();
    expect(sent[1]!.key).toBe(sent[0]!.key);
  });

  it('returns to the details with an explanation after a refusal, and uses a new key next time', async () => {
    const sent = transferApi(
      () => fail(422, 'INSUFFICIENT_FUNDS', 'Insufficient available balance to complete transaction'),
      () => ok(result(), 201)
    );
    const { user } = setup();
    await fillOwn(user);
    await user.click(screen.getByRole('button', { name: 'Send ₹2,500.00' }));
    expect(await screen.findByText('Not enough balance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review transfer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review transfer' }));
    await user.click(await screen.findByRole('button', { name: 'Send ₹2,500.00' }));
    expect(await screen.findByRole('heading', { name: 'Money sent' })).toBeInTheDocument();
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
  });

  it.each([
    ['DAILY_LIMIT_EXCEEDED', 'Daily outgoing limit exceeded. Remaining today: 150000 paise', 'Daily limit reached', /up to ₹1,500\.00 more today/i],
    ['BENEFICIARY_COOLING_OFF', 'This beneficiary becomes active at 2026-10-27T10:30:00.000Z', 'Payee not active yet', /becomes active at/i],
    ['NEW_BENEFICIARY_LIMIT', 'A new beneficiary can receive at most 5000000 paise in its first 24 hours', 'New payee limit', /up to ₹50,000\.00 in its first 24 hours/i],
    ['ACCOUNT_INACTIVE', 'Your account is frozen or closed', 'Account unavailable', /frozen or closed/i],
    ['SAME_ACCOUNT_TRANSFER', 'Source and destination accounts cannot be identical', 'Same account', /different destination/i],
    ['BENEFICIARY_REQUIRED', 'Add this account as a beneficiary before sending money to it', 'Add this payee first', /registered payee/i],
  ])('explains %s on the details step', async (code, message, title, detail) => {
    transferApi(() => fail(422, code, message));
    const { user } = setup();
    await fillOwn(user);
    await user.click(screen.getByRole('button', { name: 'Send ₹2,500.00' }));
    const callout = await screen.findByRole('alert');
    expect(callout).toHaveTextContent(title);
    expect(callout).toHaveTextContent(detail);
    expect(screen.getByRole('button', { name: 'Review transfer' })).toBeInTheDocument();
  });

  it('sends only once when Send is clicked twice', async () => {
    const sent = transferApi(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return ok(result(), 201);
    });
    const { user } = setup();
    await fillOwn(user);
    await user.dblClick(screen.getByRole('button', { name: 'Send ₹2,500.00' }));
    expect(await screen.findByRole('heading', { name: 'Money sent' })).toBeInTheDocument();
    expect(sent).toHaveLength(1);
  });

  it('starts a new transfer from the receipt', async () => {
    transferApi(() => ok(result(), 201));
    const { user } = setup();
    await fillOwn(user);
    await user.click(screen.getByRole('button', { name: 'Send ₹2,500.00' }));
    await user.click(await screen.findByRole('button', { name: 'New transfer' }));
    expect(await screen.findByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('From')).toHaveValue(IDS.savings);
  });

  it('explains that an active account is needed to send money', async () => {
    mockCustomerApi({ accounts: [frozen], balances: {}, beneficiaries: [] });
    renderWithApp(<TransferPage />, { route: '/transfer' });
    expect(await screen.findByText('No account to send from')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to accounts/i })).toHaveAttribute('href', '/accounts');
  });

  it('shows an error with a retry when accounts cannot be loaded', async () => {
    let calls = 0;
    mockCustomerApi({ balances: { [IDS.savings]: '1' }, beneficiaries: [] });
    server.use(
      http.get(apiUrl('/accounts'), () => {
        calls += 1;
        return calls === 1 ? fail(503, 'SERVICE_UNAVAILABLE', 'down') : ok([savings]);
      })
    );
    const { user } = renderWithApp(<TransferPage />, { route: '/transfer' });
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByLabelText('From')).toBeInTheDocument();
  });

  it('suggests adding a payee when there are none', async () => {
    mockCustomerApi({ accounts: [savings], balances: { [IDS.savings]: '1' }, beneficiaries: [] });
    renderWithApp(<TransferPage />, { route: '/transfer' });
    expect(await screen.findByRole('radio', { name: 'Payee' })).toBeChecked();
    expect(screen.getByText(/you haven’t added any payees yet/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: /add a payee/i })).toHaveAttribute('href', '/payees?add=1'));
  });
});
