import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, aProfile, anAccount, anEntry } from '@/test/fixtures';
import { daysAgo, mockCustomerApi } from './testing';
import DashboardPage from './DashboardPage';

const savings = anAccount();
const current = anAccount({ id: IDS.current, accountNumber: '100111112222', accountType: 'CURRENT' });
const frozen = anAccount({ id: IDS.payeeAccount, accountNumber: '100133334444', status: 'FROZEN' });

const render = () => renderWithApp(<DashboardPage />, { route: '/dashboard' });

describe('DashboardPage', () => {
  it('greets the customer by first name and totals the balance of active accounts only', async () => {
    mockCustomerApi({
      profile: aProfile(),
      accounts: [savings, current, frozen],
      balances: { [IDS.savings]: '12550075', [IDS.current]: '4999925', [IDS.payeeAccount]: '100000' },
      history: {},
    });
    render();
    expect(await screen.findByRole('heading', { level: 1, name: /asha/i })).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Summary' });
    // Rupees and paise are styled apart, so match the figure as a whole
    expect((await within(summary).findAllByText((_, el) => el?.textContent === '₹1,75,500.00')).length).toBeGreaterThan(0);
    expect(within(summary).getByText(/across 2 active accounts/i)).toBeInTheDocument();
    expect(within(summary).getByText(/1 frozen account not included/i)).toBeInTheDocument();
  });

  it('shows where the money sits across active accounts until there is a week of history', async () => {
    const openedToday = { createdAt: new Date().toISOString() };
    mockCustomerApi({
      profile: aProfile(),
      accounts: [{ ...savings, ...openedToday }, { ...current, ...openedToday }, frozen],
      balances: { [IDS.savings]: '12550075', [IDS.current]: '4999925', [IDS.payeeAccount]: '100000' },
      history: {},
    });
    render();
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(await within(summary).findByText('Where your money is')).toBeInTheDocument();
    // Shares come from exact paise: 1,25,500.75 and 49,999.25 of 1,75,500.00
    expect(within(summary).getByText('72%')).toBeInTheDocument();
    expect(within(summary).getByText('28%')).toBeInTheDocument();
    expect(within(summary).queryByText(/••••4444/)).not.toBeInTheDocument();
    expect(within(summary).queryByRole('img')).not.toBeInTheDocument();
  });

  it('draws the total balance over the last 30 days once there is history to show', async () => {
    mockCustomerApi({
      profile: aProfile(),
      accounts: [savings],
      balances: { [IDS.savings]: '12550075' },
      history: {
        [IDS.savings]: [
          anEntry({ entryId: 'p', transactionId: 'p', entryType: 'CREDIT', amountInPaise: '50075', balanceAfterInPaise: '12550075', createdAt: daysAgo(3) }),
        ],
      },
    });
    render();
    const summary = await screen.findByRole('region', { name: 'Summary' });
    const chart = await within(summary).findByRole('img', { name: /total balance from .* to today|total balance from/i });
    expect(chart).toHaveAccessibleName(/₹1,25,000\.00 to ₹1,25,500\.75/);
    expect(within(summary).queryByText('Where your money is')).not.toBeInTheDocument();
  });

  it('shows each account with its balance and status, linking to the account', async () => {
    mockCustomerApi({
      profile: aProfile(),
      accounts: [savings, frozen],
      balances: { [IDS.savings]: '12550075', [IDS.payeeAccount]: '100000' },
      history: {},
    });
    render();
    const strip = await screen.findByRole('region', { name: 'Your accounts' });
    const link = await within(strip).findByRole('link', { name: /savings ••••6789/i });
    expect(link).toHaveAttribute('href', `/accounts/${IDS.savings}`);
    expect(await within(link).findByText('₹1,25,500.75')).toBeInTheDocument();
    // Only an account that needs attention carries a status
    expect(within(link).queryByText('Active')).not.toBeInTheDocument();
    const frozenLink = within(strip).getByRole('link', { name: /savings ••••4444, frozen/i });
    expect(within(frozenLink).getByText('Frozen')).toBeInTheDocument();
  });

  it('asks a customer without a profile to complete it before anything else', async () => {
    mockCustomerApi({ profile: null, accounts: [], history: {}, balances: {} });
    render();
    expect(await screen.findByText('Complete your profile so we can verify your identity')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /complete your profile/i })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/welcome/i);
    expect(await screen.findByRole('button', { name: 'Open account' })).toBeDisabled();
    expect(screen.getByText(/complete your profile and identity check to open an account/i)).toBeInTheDocument();
  });

  it('explains that the identity check is in progress', async () => {
    mockCustomerApi({ profile: aProfile({ kycStatus: 'PENDING' }), accounts: [], history: {}, balances: {} });
    render();
    expect(await screen.findByText(/we’re verifying your identity/i)).toBeInTheDocument();
    expect(screen.getByText(/you can open accounts once it’s done/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open account' })).toBeDisabled();
  });

  it('tells a customer whose identity check was rejected to contact the bank', async () => {
    mockCustomerApi({ profile: aProfile({ kycStatus: 'REJECTED' }), accounts: [], history: {}, balances: {} });
    render();
    expect(await screen.findByText(/we couldn’t verify your identity/i)).toBeInTheDocument();
    expect(screen.getAllByText(/contact the bank/i).length).toBeGreaterThan(0);
  });

  it('offers to open a first account once the identity is verified', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [], history: {}, balances: {} });
    const { user } = render();
    expect(await screen.findByText('Open your first account')).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: 'Open account' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByRole('dialog', { name: 'Open an account' })).toBeInTheDocument();
  });

  it('shows an error with a retry when the accounts cannot be loaded', async () => {
    let calls = 0;
    mockCustomerApi({ profile: aProfile(), balances: { [IDS.savings]: '12550075' }, history: {} });
    server.use(
      http.get(apiUrl('/accounts'), () => {
        calls += 1;
        return calls === 1 ? fail(503, 'SERVICE_UNAVAILABLE', 'down') : ok([savings]);
      })
    );
    const { user } = render();
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /try again/i })[0]!);
    const strip = await screen.findByRole('region', { name: 'Your accounts' });
    expect(await within(strip).findByRole('link', { name: /savings ••••6789/i })).toBeInTheDocument();
  });

  it('lists recent activity across accounts, newest first, with signed amounts', async () => {
    mockCustomerApi({
      profile: aProfile(),
      accounts: [savings, current],
      balances: { [IDS.savings]: '12550075', [IDS.current]: '4999925' },
      history: {
        [IDS.savings]: [anEntry({ entryId: 'e1', transactionId: 't1', description: 'Rent October', createdAt: daysAgo(2) })],
        [IDS.current]: [
          anEntry({ entryId: 'e2', transactionId: 't2', entryType: 'CREDIT', amountInPaise: '5000000', description: 'Salary', createdAt: daysAgo(1) }),
        ],
      },
    });
    render();
    const activity = await screen.findByRole('region', { name: 'Recent activity' });
    const items = await within(activity).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Salary');
    expect(items[0]).toHaveTextContent('+₹50,000.00');
    expect(items[0]).toHaveTextContent('••••2222');
    expect(items[1]).toHaveTextContent('Rent October');
    expect(items[1]).toHaveTextContent('-₹2,500.00');
    expect(items[1]).toHaveTextContent('••••6789');
  });

  it('keeps recent activity to the latest eight entries', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      anEntry({ entryId: `e${i}`, transactionId: `t${i}`, description: `Payment ${i}`, createdAt: daysAgo(i + 1) })
    );
    mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: { [IDS.savings]: '1' }, history: { [IDS.savings]: entries } });
    render();
    const activity = await screen.findByRole('region', { name: 'Recent activity' });
    await waitFor(() => expect(within(activity).getAllByRole('listitem')).toHaveLength(8));
    expect(within(activity).queryByText('Payment 9')).not.toBeInTheDocument();
  });

  it('summarises 30-day cash flow without counting moves between the customer’s own accounts', async () => {
    mockCustomerApi({
      profile: aProfile(),
      accounts: [savings, current],
      balances: { [IDS.savings]: '1', [IDS.current]: '1' },
      history: {
        [IDS.savings]: [
          anEntry({ entryId: 'a', transactionId: 'own', amountInPaise: '1000000', description: 'To current', createdAt: daysAgo(3) }),
          anEntry({ entryId: 'b', transactionId: 'rent', amountInPaise: '250000', createdAt: daysAgo(5) }),
          anEntry({ entryId: 'c', transactionId: 'old', amountInPaise: '9900000', createdAt: daysAgo(45) }),
        ],
        [IDS.current]: [
          anEntry({ entryId: 'd', transactionId: 'own', entryType: 'CREDIT', amountInPaise: '1000000', createdAt: daysAgo(3) }),
          anEntry({ entryId: 'e', transactionId: 'salary', entryType: 'CREDIT', amountInPaise: '5000000', createdAt: daysAgo(4) }),
        ],
      },
    });
    render();
    const chart = await screen.findByRole('region', { name: 'Cash flow' });
    expect(
      await within(chart).findByText(/in the last 30 days, ₹50,000\.00 came in and ₹2,500\.00 went out/i)
    ).toBeInTheDocument();
    expect(within(chart).getByText(/transfers between your own accounts are not counted/i)).toBeInTheDocument();
  });

  it('shows a calm empty state when there was no money in or out', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: { [IDS.savings]: '1' }, history: { [IDS.savings]: [] } });
    render();
    const chart = await screen.findByRole('region', { name: 'Cash flow' });
    expect(await within(chart).findByText('No money in or out in the last 30 days')).toBeInTheDocument();
    const activity = screen.getByRole('region', { name: 'Recent activity' });
    expect(await within(activity).findByText('No transactions yet')).toBeInTheDocument();
  });

  it('shows what was spent today', async () => {
    mockCustomerApi({
      profile: aProfile(),
      accounts: [savings],
      balances: { [IDS.savings]: '1' },
      history: {
        [IDS.savings]: [
          anEntry({ entryId: 'x', transactionId: 'x', amountInPaise: '120000', createdAt: new Date().toISOString() }),
          anEntry({ entryId: 'y', transactionId: 'y', amountInPaise: '999900', createdAt: daysAgo(1) }),
        ],
      },
    });
    render();
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(await within(summary).findByText('₹1,200.00')).toBeInTheDocument();
  });

  it('offers quick actions for the common tasks', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: { [IDS.savings]: '1' }, history: {} });
    render();
    const actions = await screen.findByRole('region', { name: 'Quick actions' });
    expect(within(actions).getByRole('link', { name: /transfer/i })).toHaveAttribute('href', '/transfer');
    expect(within(actions).getByRole('link', { name: 'Add money' })).toHaveAttribute('href', '/add-money');
    expect(within(actions).getByRole('link', { name: /add payee/i })).toHaveAttribute('href', '/payees?add=1');
    expect(within(actions).getByRole('link', { name: /withdraw cash/i })).toHaveAttribute('href', '/cash-withdrawal');
    expect(within(actions).getByRole('button', { name: /new account/i })).toBeInTheDocument();
  });

  it('shows placeholders while the dashboard loads', () => {
    server.use(
      http.get(apiUrl('/customers/me'), () => new Promise(() => {})),
      http.get(apiUrl('/accounts'), () => new Promise(() => {}))
    );
    render();
    expect(screen.getByRole('region', { name: 'Summary' })).toHaveAttribute('aria-busy', 'true');
  });
});
