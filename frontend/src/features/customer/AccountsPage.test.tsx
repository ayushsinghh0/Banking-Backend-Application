import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, aProfile, anAccount } from '@/test/fixtures';
import { mockCustomerApi } from './testing';
import AccountsPage from './AccountsPage';

const savings = anAccount();
const current = anAccount({ id: IDS.current, accountNumber: '100111112222', accountType: 'CURRENT', status: 'FROZEN', dailyLimitPaise: '2500000' });
const NEW_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const render = () => renderWithApp(<AccountsPage />, { route: '/accounts' });

describe('AccountsPage', () => {
  it('shows each account as a card with its number, type, balance, daily limit and any non-active status', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [savings, current], balances: { [IDS.savings]: '12550075', [IDS.current]: '4999925' } });
    render();
    await screen.findByRole('link', { name: 'Savings account' });
    const list = screen.getByRole('list', { name: /your accounts/i });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByRole('link', { name: 'Savings account' })).toHaveAttribute('href', `/accounts/${IDS.savings}`);
    expect(cards[0]).toHaveTextContent('1001 2345 6789');
    // Active is the normal state: only other statuses are called out
    expect(within(cards[0]!).queryByText('Active')).not.toBeInTheDocument();
    await waitFor(() => expect(cards[0]).toHaveTextContent('₹1,25,500.75'));
    expect(cards[0]).toHaveTextContent('Daily limit ₹1,00,000.00');
    expect(within(cards[1]!).getByRole('link', { name: 'Current account' })).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Frozen')).toBeInTheDocument();
    expect(cards[1]).toHaveTextContent('Daily limit ₹25,000.00');
  });

  it('lists closed accounts apart, still linking to their statements', async () => {
    const closed = anAccount({ id: IDS.current, accountNumber: '100111112222', status: 'CLOSED' });
    mockCustomerApi({ profile: aProfile(), accounts: [savings, closed], balances: { [IDS.savings]: '1' } });
    render();
    const panel = await screen.findByRole('region', { name: 'Closed accounts' });
    expect(within(panel).getByRole('link', { name: /savings account/i })).toHaveAttribute('href', `/accounts/${IDS.current}`);
    expect(within(screen.getByRole('list', { name: /your accounts/i })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('copies the full account number without spaces', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: { [IDS.savings]: '1' } });
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Copy account number' }));
    expect(await navigator.clipboard.readText()).toBe('100123456789');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('shows a retry for a balance that could not be loaded', async () => {
    let calls = 0;
    mockCustomerApi({ profile: aProfile(), accounts: [savings] });
    server.use(
      http.get(apiUrl('/transactions/accounts/:id/balance'), () => {
        calls += 1;
        return calls === 1 ? fail(503, 'SERVICE_BUSY', 'busy') : ok({ accountId: IDS.savings, balanceInPaise: '500', currency: 'INR' });
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /retry loading the balance/i }));
    await waitFor(() => expect(screen.getByRole('list', { name: /your accounts/i })).toHaveTextContent('₹5.00'));
  });

  it('invites a verified customer with no accounts to open one', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [] });
    const { user } = render();
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Open account' });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    expect(await screen.findByRole('dialog', { name: 'Open an account' })).toBeInTheDocument();
  });

  it('shows an error with a retry when the list fails to load', async () => {
    let calls = 0;
    mockCustomerApi({ profile: aProfile(), balances: { [IDS.savings]: '1' } });
    server.use(
      http.get(apiUrl('/accounts'), () => {
        calls += 1;
        return calls === 1 ? fail(500, 'INTERNAL_SERVER_ERROR', 'boom') : ok([savings]);
      })
    );
    const { user } = render();
    expect(await screen.findByText('Something went wrong on our side')).toBeInTheDocument();
    expect(screen.getByText(/reference: test-corr/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('link', { name: 'Savings account' })).toBeInTheDocument();
  });

  it('opens a current account and goes straight to it', async () => {
    let body: unknown;
    mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: { [IDS.savings]: '1' } });
    server.use(
      http.post(apiUrl('/accounts'), async ({ request }) => {
        body = await request.json();
        return ok(anAccount({ id: NEW_ID, accountNumber: '100155556666', accountType: 'CURRENT' }), 201);
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Open account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open an account' });
    expect(within(dialog).getByRole('radio', { name: /savings account/i })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: /current account/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Open current account' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/accounts/${NEW_ID}`));
    expect(body).toEqual({ accountType: 'CURRENT' });
    expect(await screen.findByText('Current account opened')).toBeInTheDocument();
  });

  it('explains that identity verification must finish first', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: { [IDS.savings]: '1' } });
    server.use(
      http.post(apiUrl('/accounts'), () =>
        fail(403, 'KYC_NOT_VERIFIED', 'Your identity verification (KYC) must be approved before you can open an account')
      )
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Open account' }));
    await user.click(await screen.findByRole('button', { name: 'Open savings account' }));
    const dialog = screen.getByRole('dialog', { name: 'Open an account' });
    expect(await within(dialog).findByText('Identity verification needed')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /go to your profile/i })).toHaveAttribute('href', '/profile');
  });

  it('explains the limit on open accounts', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: { [IDS.savings]: '1' } });
    server.use(http.post(apiUrl('/accounts'), () => fail(409, 'CONFLICT', 'A customer may hold at most 5 open accounts')));
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Open account' }));
    await user.click(await screen.findByRole('button', { name: 'Open savings account' }));
    expect(await screen.findByText('Account limit reached')).toBeInTheDocument();
    expect(screen.getByText(/up to 5 open accounts/i)).toBeInTheDocument();
  });

  it('keeps account opening disabled while identity verification is pending', async () => {
    mockCustomerApi({ profile: aProfile({ kycStatus: 'PENDING' }), accounts: [savings], balances: { [IDS.savings]: '1' } });
    render();
    expect(await screen.findByText(/we’re verifying your identity/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open account' })).toBeDisabled();
  });
});
