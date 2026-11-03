import { delay, http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aBalance, aDirectoryUser, aKycEvent, anAccount, anEntry, aProfile, IDS } from '@/test/fixtures';
import type { BankAccount, CustomerProfile, DirectoryUser, KycEvent } from '@/lib/api/types';
import { STAFF, asStaff, queryOf, resetToasts } from './testing';
import { aSession, sessionsHandler } from '@/features/ops/test/handlers';
import CustomerDetailPage from './CustomerDetailPage';

afterEach(resetToasts);

const ROUTE = `/customers/${IDS.customer}`;
const PATH = '/customers/:userId';

interface Setup {
  profile?: CustomerProfile | Response | (() => Response | Promise<Response>);
  accounts?: BankAccount[] | Response;
  history?: KycEvent[] | Response;
  balances?: Record<string, string>;
  directory?: DirectoryUser[] | Response;
}

/** Registers the reads the page makes and records every request path */
function setup({ profile = aProfile(), accounts = [anAccount()], history = [aKycEvent()], balances = {}, directory = [aDirectoryUser({ id: IDS.customer, role: 'CUSTOMER', email: 'asha@example.in', mfaEnabled: true })] }: Setup = {}) {
  const requests: string[] = [];
  const log = (request: Request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname.replace('/api/v1', '')}${url.search}`);
  };
  const respond = (value: unknown) => (value instanceof Response ? value.clone() : ok(value));
  server.use(
    http.get(apiUrl('/customers/:userId'), ({ request }) => {
      log(request);
      return typeof profile === 'function' ? profile() : respond(profile);
    }),
    http.get(apiUrl('/customers/:userId/kyc/history'), ({ request }) => {
      log(request);
      return respond(history);
    }),
    http.get(apiUrl('/accounts'), ({ request }) => {
      log(request);
      return respond(accounts);
    }),
    http.get(apiUrl('/transactions/accounts/:id/balance'), ({ request, params }) => {
      log(request);
      const id = String(params.id);
      return ok(aBalance(id, balances[id] ?? '12550075'));
    }),
    http.get(apiUrl('/auth/admin/users'), ({ request }) => {
      log(request);
      return respond(directory);
    }),
    sessionsHandler((request) => {
      log(request);
      return [aSession()];
    })
  );
  return requests;
}

const render = (role: Parameters<typeof asStaff>[0], sub?: string) =>
  renderWithApp(<CustomerDetailPage />, { ...asStaff(role, sub), route: ROUTE, path: PATH });

describe('CustomerDetailPage — profile', () => {
  it('shows the profile and tells staff their access is logged', async () => {
    setup();
    render('SUPPORT');
    expect(await screen.findByRole('heading', { level: 1, name: 'Asha Rao' })).toBeInTheDocument();
    expect(screen.getByText(/your access to this record is logged/i)).toBeInTheDocument();
    const profile = screen.getByRole('region', { name: 'Profile' });
    expect(within(profile).getByText('+919876543210')).toBeInTheDocument();
    expect(within(profile).getByText('12 Apr 1992')).toBeInTheDocument();
    expect(within(profile).getByText('12 MG Road, Pune')).toBeInTheDocument();
    expect(within(profile).getByText('Verified')).toBeInTheDocument();
    expect(within(profile).getByText('Version 2')).toBeInTheDocument();
  });

  it('announces loading', async () => {
    setup({
      profile: async () => {
        await delay('infinite');
        return ok(aProfile());
      },
    });
    render('SUPPORT');
    expect(await screen.findByText('Loading customer…')).toBeInTheDocument();
  });

  it('shows an error with a working retry when the profile fails to load', async () => {
    let attempt = 0;
    setup({ profile: () => (attempt++ === 0 ? fail(503, 'SERVICE_UNAVAILABLE') : ok(aProfile())) });
    const { user } = render('SUPPORT');
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Asha Rao' })).toBeInTheDocument();
  });

  it('shows not found when there is no such customer', async () => {
    setup({ profile: fail(404, 'NOT_FOUND', 'Customer profile not found'), accounts: [], directory: [] });
    render('SUPPORT');
    expect(await screen.findByRole('heading', { name: 'Customer not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /search customers/i })).toHaveAttribute('href', '/customers');
  });

  it('treats a malformed id as not found without calling the API', async () => {
    const requests = setup();
    renderWithApp(<CustomerDetailPage />, { ...asStaff('SUPPORT'), route: '/customers/not-a-uuid', path: PATH });
    expect(await screen.findByRole('heading', { name: 'Customer not found' })).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('still shows the accounts of a customer who has no profile', async () => {
    setup({ profile: fail(404, 'NOT_FOUND'), accounts: [anAccount()] });
    render('FRAUD_ANALYST');
    expect(await screen.findByText('No profile yet')).toBeInTheDocument();
    expect(await screen.findByText('1001 2345 6789')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Customer not found' })).not.toBeInTheDocument();
  });

  it('shows a registered customer with no profile and no accounts to administrators', async () => {
    setup({ profile: fail(404, 'NOT_FOUND'), accounts: [] });
    render('BANK_ADMIN');
    expect(await screen.findByText('No profile yet')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Disable sign-in' })).toBeInTheDocument();
  });
});

describe('CustomerDetailPage — KYC decisions', () => {
  it('lets a KYC officer verify the exact version they reviewed', async () => {
    const requests = setup({ profile: aProfile({ kycStatus: 'PENDING', version: 3 }) });
    let body: unknown;
    server.use(
      http.patch(apiUrl('/customers/:userId/kyc'), async ({ request }) => {
        body = await request.json();
        return ok(aProfile({ kycStatus: 'VERIFIED', version: 4 }));
      })
    );
    const { user } = render('KYC_OFFICER');
    await user.click(await screen.findByRole('button', { name: 'Verify identity' }));
    const dialog = await screen.findByRole('alertdialog', { name: /verify asha rao’s identity/i });
    expect(within(dialog).getByText(/version 3/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Verify identity' }));
    expect(await screen.findByText('KYC verified')).toBeInTheDocument();
    expect(body).toEqual({ kycStatus: 'VERIFIED', expectedVersion: 3 });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'Profile' })).getByText('Version 4')).toBeInTheDocument();
    // The history is refreshed to include the decision
    await waitFor(() => expect(requests.filter((r) => r.includes('/kyc/history'))).toHaveLength(2));
  });

  it('lets a KYC officer reject a profile', async () => {
    setup({ profile: aProfile({ kycStatus: 'PENDING', version: 3 }) });
    let body: unknown;
    server.use(
      http.patch(apiUrl('/customers/:userId/kyc'), async ({ request }) => {
        body = await request.json();
        return ok(aProfile({ kycStatus: 'REJECTED', version: 4 }));
      })
    );
    const { user } = render('KYC_OFFICER');
    await user.click(await screen.findByRole('button', { name: 'Reject KYC' }));
    const dialog = await screen.findByRole('alertdialog', { name: /reject asha rao’s kyc/i });
    expect(within(dialog).getByText(/existing accounts aren’t affected/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reject KYC' }));
    expect(await screen.findByText('KYC rejected')).toBeInTheDocument();
    expect(body).toEqual({ kycStatus: 'REJECTED', expectedVersion: 3 });
  });

  it('refuses a stale decision and shows the latest version', async () => {
    let reads = 0;
    setup({
      profile: () => ok(reads++ === 0 ? aProfile({ kycStatus: 'PENDING', version: 3 }) : aProfile({ kycStatus: 'PENDING', version: 4, address: '7 New Street, Pune' })),
    });
    server.use(http.patch(apiUrl('/customers/:userId/kyc'), () => fail(409, 'PROFILE_CHANGED', 'The profile changed since it was reviewed')));
    const { user } = render('KYC_OFFICER');
    await user.click(await screen.findByRole('button', { name: 'Verify identity' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Verify identity' }));
    expect(
      await screen.findByText('The customer changed their details since you opened this page — review the latest version')
    ).toBeInTheDocument();
    expect(await screen.findByText('7 New Street, Pune')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Profile' })).getByText('Version 4')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('explains a refused decision', async () => {
    setup({ profile: aProfile({ kycStatus: 'PENDING' }) });
    server.use(http.patch(apiUrl('/customers/:userId/kyc'), () => fail(403, 'FORBIDDEN', 'Staff cannot review their own KYC')));
    const { user } = render('KYC_OFFICER');
    await user.click(await screen.findByRole('button', { name: 'Reject KYC' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reject KYC' }));
    expect(await screen.findByText('You can’t decide this customer’s KYC')).toBeInTheDocument();
  });

  it('keeps the dialog open to retry after a transient failure', async () => {
    setup({ profile: aProfile({ kycStatus: 'PENDING' }) });
    server.use(http.patch(apiUrl('/customers/:userId/kyc'), () => fail(503, 'SERVICE_UNAVAILABLE')));
    const { user } = render('KYC_OFFICER');
    await user.click(await screen.findByRole('button', { name: 'Verify identity' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Verify identity' }));
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('offers only the decision that changes the status', async () => {
    setup({ profile: aProfile({ kycStatus: 'VERIFIED' }) });
    render('KYC_OFFICER');
    expect(await screen.findByRole('button', { name: 'Reject KYC' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify identity' })).not.toBeInTheDocument();
  });

  it('never lets an officer decide their own KYC', async () => {
    setup({ profile: aProfile({ userId: STAFF.kycOfficer, kycStatus: 'PENDING' }) });
    renderWithApp(<CustomerDetailPage />, { ...asStaff('KYC_OFFICER'), route: `/customers/${STAFF.kycOfficer}`, path: PATH });
    expect(await screen.findByText(/this is your own profile/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify identity' })).not.toBeInTheDocument();
  });

  it('shows no decision controls to other roles', async () => {
    setup({ profile: aProfile({ kycStatus: 'PENDING' }) });
    render('BANK_ADMIN');
    await screen.findByRole('heading', { level: 1, name: 'Asha Rao' });
    expect(screen.queryByRole('button', { name: 'Verify identity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject KYC' })).not.toBeInTheDocument();
  });
});

describe('CustomerDetailPage — KYC history', () => {
  it('lists decisions and renders details as plain text', async () => {
    setup({
      history: [
        aKycEvent({ id: 'e2', action: 'KYC_DECISION', actorId: STAFF.kycOfficer2, details: { reviewedVersion: 2 } }),
        aKycEvent({
          id: 'e1',
          action: 'IDENTITY_CHANGED_KYC_RESET',
          actorId: IDS.customer,
          fromStatus: 'VERIFIED',
          toStatus: 'PENDING',
          details: { fullName: { from: 'Asha', to: 'Asha Rao' }, note: '<img src=x onerror="alert(1)">' },
        }),
      ],
    });
    render('SUPPORT');
    const history = await screen.findByRole('list', { name: 'KYC history' });
    const items = await within(history).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('KYC decision')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/staff 67676767/i)).toBeInTheDocument();
    expect(within(items[0]!).getByText('Reviewed version')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Identity details changed, KYC sent back for review')).toBeInTheDocument();
    expect(within(items[1]!).getByText(/by customer/i)).toBeInTheDocument();
    expect(within(items[1]!).getByText('Asha → Asha Rao')).toBeInTheDocument();
    expect(within(items[1]!).getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('is shown to administrators', async () => {
    setup();
    render('BANK_ADMIN');
    expect(await screen.findByRole('list', { name: 'KYC history' })).toBeInTheDocument();
  });

  it.each(['TELLER', 'FRAUD_ANALYST'] as const)('is neither shown to nor requested for %s', async (role) => {
    const requests = setup();
    render(role);
    await screen.findByRole('heading', { level: 1, name: 'Asha Rao' });
    await screen.findByText('1001 2345 6789');
    expect(screen.queryByRole('heading', { name: 'KYC history' })).not.toBeInTheDocument();
    expect(requests.some((r) => r.includes('/kyc/history'))).toBe(false);
    expect(requests.some((r) => r.includes('/auth/admin/users'))).toBe(false);
  });

  it('says when there is no history yet', async () => {
    setup({ history: [] });
    render('KYC_OFFICER');
    expect(await screen.findByText('No KYC activity yet')).toBeInTheDocument();
  });
});

describe('CustomerDetailPage — accounts', () => {
  it('shows each account with balance, status, limit and the bank ceiling', async () => {
    const requests = setup({
      accounts: [
        anAccount({ bankLimitCeilingPaise: '20000000', dailyLimitPaise: '15000000' }),
        anAccount({ id: IDS.current, accountNumber: '100198765432', accountType: 'CURRENT', status: 'FROZEN' }),
      ],
      balances: { [IDS.current]: '0' },
    });
    render('SUPPORT');
    const savings = await screen.findByRole('region', { name: /savings account/i });
    expect(await within(savings).findByText('₹1,25,500.75')).toBeInTheDocument();
    expect(within(savings).getByText('Active')).toBeInTheDocument();
    expect(within(savings).getByText('₹1,50,000.00')).toBeInTheDocument();
    expect(within(savings).getByText('₹2,00,000.00')).toBeInTheDocument();
    const current = screen.getByRole('region', { name: /current account/i });
    expect(within(current).getByText('Frozen')).toBeInTheDocument();
    expect(await within(current).findByText('₹0.00')).toBeInTheDocument();
    expect(within(current).getByText('None set')).toBeInTheDocument();
    expect(requests).toContain(`GET /accounts?customerId=${IDS.customer}`);
    // Read-only roles get no account controls
    expect(screen.queryByRole('button', { name: /freeze/i })).not.toBeInTheDocument();
  });

  it('says when the customer has no accounts', async () => {
    setup({ accounts: [] });
    render('SUPPORT');
    expect(await screen.findByText('No accounts')).toBeInTheDocument();
  });

  it('shows an accounts error with retry', async () => {
    let attempt = 0;
    setup();
    server.use(http.get(apiUrl('/accounts'), () => (attempt++ === 0 ? fail(502, 'BAD_GATEWAY') : ok([anAccount()]))));
    const { user } = render('SUPPORT');
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('1001 2345 6789')).toBeInTheDocument();
  });

  it('expands recent transactions on demand', async () => {
    const requests = setup();
    server.use(
      http.get(apiUrl('/transactions/accounts/:id/history'), ({ request }) => {
        requests.push(`history ${JSON.stringify(queryOf(request))}`);
        return ok([anEntry({ description: 'Rent October' }), anEntry({ entryId: 'e2', entryType: 'CREDIT', description: 'Salary', amountInPaise: '8000000' })]);
      })
    );
    const { user } = render('SUPPORT');
    const toggle = await screen.findByRole('button', { name: 'Recent transactions for account ending 6789' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(requests.some((r) => r.startsWith('history'))).toBe(false);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Rent October')).toBeInTheDocument();
    expect(screen.getByText('+₹80,000.00')).toBeInTheDocument();
    expect(requests).toContain('history {"limit":"10","offset":"0"}');
  });
});

describe('CustomerDetailPage — administrator account controls', () => {
  it('freezes an account after confirmation', async () => {
    setup();
    let body: unknown;
    server.use(
      http.patch(apiUrl('/accounts/:id/status'), async ({ request }) => {
        body = await request.json();
        return ok(anAccount({ status: 'FROZEN', version: 2 }));
      })
    );
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Freeze account ending 6789' }));
    const dialog = await screen.findByRole('alertdialog', { name: /freeze account 1001 2345 6789/i });
    expect(within(dialog).getByText(/a different administrator will have to unfreeze it/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Freeze account' }));
    expect(await screen.findByText('Account frozen')).toBeInTheDocument();
    expect(body).toEqual({ status: 'FROZEN' });
    expect(within(screen.getByRole('region', { name: /savings account/i })).getByText('Frozen')).toBeInTheDocument();
  });

  it('explains dual control when the same administrator tries to unfreeze', async () => {
    setup({ accounts: [anAccount({ status: 'FROZEN' })] });
    server.use(http.patch(apiUrl('/accounts/:id/status'), () => fail(403, 'FORBIDDEN', 'An account you froze must be unfrozen by a different administrator')));
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Unfreeze account ending 6789' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unfreeze account' }));
    expect(await screen.findByText('A different administrator must unfreeze this account')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('refuses to close an account that still holds money', async () => {
    setup({ balances: { [IDS.savings]: '500' } });
    server.use(http.patch(apiUrl('/accounts/:id/status'), () => fail(409, 'BALANCE_NOT_ZERO', 'Account balance must be zero')));
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Close account ending 6789' }));
    const dialog = await screen.findByRole('alertdialog', { name: /close account 1001 2345 6789 permanently/i });
    expect(within(dialog).getByText(/still holds ₹5.00/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close account' }));
    expect(await screen.findByText('Balance must be zero')).toBeInTheDocument();
  });

  it('closes an account with a zero balance', async () => {
    setup({ balances: { [IDS.savings]: '0' } });
    let body: unknown;
    server.use(
      http.patch(apiUrl('/accounts/:id/status'), async ({ request }) => {
        body = await request.json();
        return ok(anAccount({ status: 'CLOSED' }));
      })
    );
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Close account ending 6789' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Close account' }));
    expect(await screen.findByText('Account closed')).toBeInTheDocument();
    expect(body).toEqual({ status: 'CLOSED' });
    // A closed account has no further controls
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Set daily limit for account ending 6789' })).not.toBeInTheDocument());
  });

  it('sets a daily limit that becomes the customer’s ceiling', async () => {
    setup();
    let body: unknown;
    server.use(
      http.patch(apiUrl('/accounts/:id/daily-limit'), async ({ request }) => {
        body = await request.json();
        return ok(anAccount({ dailyLimitPaise: '20000000', bankLimitCeilingPaise: '20000000' }));
      })
    );
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Set daily limit for account ending 6789' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set daily limit' });
    expect(within(dialog).getByText(/can lower it but can’t raise it above/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await within(dialog).findByText('Enter an amount')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('New daily limit'), '2,00,000');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText('Daily limit updated')).toBeInTheDocument();
    expect(body).toEqual({ dailyLimitPaise: '20000000' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows server validation on the limit field', async () => {
    setup();
    server.use(
      http.patch(apiUrl('/accounts/:id/daily-limit'), () =>
        fail(400, 'VALIDATION_ERROR', 'Invalid', { details: [{ field: 'dailyLimitPaise', message: 'Daily limit must be a positive amount in paise' }] })
      )
    );
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Set daily limit for account ending 6789' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set daily limit' });
    await user.type(within(dialog).getByLabelText('New daily limit'), '10');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await within(dialog).findByText('Daily limit must be a positive amount in paise')).toBeInTheDocument();
  });

  it('shows other limit refusals in the dialog', async () => {
    setup();
    server.use(http.patch(apiUrl('/accounts/:id/daily-limit'), () => fail(409, 'CONFLICT', 'Cannot change limits on a closed account')));
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Set daily limit for account ending 6789' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set daily limit' });
    await user.type(within(dialog).getByLabelText('New daily limit'), '5000');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await within(dialog).findByText('Cannot change limits on a closed account')).toBeInTheDocument();
  });
});

describe('CustomerDetailPage — sign-in controls', () => {
  it('shows sign-in status to support without controls', async () => {
    const requests = setup();
    render('SUPPORT');
    const access = await screen.findByRole('region', { name: 'Sign-in & security' });
    expect(await within(access).findByText('asha@example.in')).toBeInTheDocument();
    expect(within(access).getByText('Enabled')).toBeInTheDocument();
    expect(within(access).getByRole('link', { name: /emails sent to this customer/i })).toHaveAttribute(
      'href',
      '/notifications?recipient=asha%40example.in'
    );
    expect(within(access).queryByRole('button')).not.toBeInTheDocument();
    expect(requests.find((r) => r.includes('/auth/admin/users'))).toContain(`q=${IDS.customer}`);
  });

  it('is not requested for KYC officers', async () => {
    const requests = setup();
    render('KYC_OFFICER');
    await screen.findByRole('heading', { level: 1, name: 'Asha Rao' });
    expect(screen.queryByRole('region', { name: 'Sign-in & security' })).not.toBeInTheDocument();
    expect(requests.some((r) => r.includes('/auth/admin/users'))).toBe(false);
  });

  it('disables sign-in immediately for a customer', async () => {
    setup();
    let body: unknown;
    server.use(
      http.patch(apiUrl('/auth/admin/users/:id/status'), async ({ request }) => {
        body = await request.json();
        return ok({ id: IDS.customer, email: 'asha@example.in', role: 'CUSTOMER', isActive: false });
      })
    );
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Disable sign-in' }));
    const dialog = await screen.findByRole('alertdialog', { name: /disable sign-in for asha rao/i });
    expect(within(dialog).getByText(/signed out on every device/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Disable sign-in' }));
    expect(await screen.findByText('Sign-in disabled')).toBeInTheDocument();
    expect(body).toEqual({ isActive: false });
  });

  it('explains dual control when re-enabling is refused', async () => {
    setup({ directory: [aDirectoryUser({ id: IDS.customer, role: 'CUSTOMER', isActive: false })] });
    server.use(
      http.patch(apiUrl('/auth/admin/users/:id/status'), () =>
        fail(403, 'FORBIDDEN', 'A user you disabled must be re-enabled by a different administrator')
      )
    );
    const { user } = render('BANK_ADMIN');
    expect(screen.queryByRole('button', { name: 'Disable sign-in' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Enable sign-in' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Enable sign-in' }));
    expect(await screen.findByText('A different administrator must re-enable sign-in')).toBeInTheDocument();
  });

  it('sends an authenticator reset for approval', async () => {
    setup();
    server.use(http.post(apiUrl('/auth/admin/users/:id/mfa/reset'), () => ok({ requestId: 'req-9', status: 'PENDING' }, 202)));
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Reset authenticator' }));
    const dialog = await screen.findByRole('alertdialog', { name: /reset asha rao’s authenticator/i });
    await user.click(within(dialog).getByRole('button', { name: 'Request reset' }));
    expect(await screen.findByText('Sent for approval')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /approvals/i })).toHaveAttribute('href', '/approvals');
  });

  it('handles an immediate authenticator reset', async () => {
    setup();
    server.use(http.post(apiUrl('/auth/admin/users/:id/mfa/reset'), () => HttpResponse.json({ success: true, message: 'MFA reset' })));
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Reset authenticator' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Request reset' }));
    expect(await screen.findByText('Authenticator reset')).toBeInTheDocument();
  });

  it('reports when a status change needs a second administrator', async () => {
    setup();
    server.use(http.patch(apiUrl('/auth/admin/users/:id/status'), () => ok({ requestId: 'req-3', status: 'PENDING' }, 202)));
    const { user } = render('BANK_ADMIN');
    await user.click(await screen.findByRole('button', { name: 'Disable sign-in' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disable sign-in' }));
    expect(await screen.findByText('Sent for approval')).toBeInTheDocument();
  });

  it('offers both sign-in actions when the current status is unknown', async () => {
    setup({ directory: fail(503, 'SERVICE_UNAVAILABLE') });
    render('BANK_ADMIN');
    expect(await screen.findByText(/sign-in status couldn’t be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable sign-in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable sign-in' })).toBeInTheDocument();
  });

  it('gives administrators no controls over their own sign-in', async () => {
    setup({ profile: aProfile({ userId: STAFF.admin }), directory: [aDirectoryUser({ id: STAFF.admin, role: 'BANK_ADMIN' })] });
    renderWithApp(<CustomerDetailPage />, { ...asStaff('BANK_ADMIN'), route: `/customers/${STAFF.admin}`, path: PATH });
    expect(await screen.findByText(/you can’t change your own sign-in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable sign-in' })).not.toBeInTheDocument();
  });
});

describe('CustomerDetailPage — sessions and devices', () => {
  it('shows support where the customer is signed in, read-only', async () => {
    const requests = setup();
    render('SUPPORT');
    const panel = await screen.findByRole('region', { name: 'Sessions and devices' });
    expect(await within(panel).findByText('Chrome on Windows')).toBeInTheDocument();
    expect(within(panel).getByText('203.0.113.x')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(requests).toContain(`GET /auth/admin/users/${IDS.customer}/sessions`);
  });

  it('lets administrators sign a session out', async () => {
    setup();
    render('BANK_ADMIN');
    const panel = await screen.findByRole('region', { name: 'Sessions and devices' });
    expect(await within(panel).findByRole('button', { name: 'Sign out Chrome on Windows, 203.0.113.x' })).toBeInTheDocument();
  });

  it.each(['KYC_OFFICER', 'FRAUD_ANALYST', 'TELLER'] as const)('keeps sessions from %s', async (role) => {
    const requests = setup();
    render(role);
    expect(await screen.findByRole('heading', { level: 1, name: 'Asha Rao' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Sessions and devices' })).not.toBeInTheDocument();
    expect(requests.some((r) => r.includes('/sessions'))).toBe(false);
  });
});
