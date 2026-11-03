import { delay, http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { toast } from 'sonner';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aDirectoryUser, IDS } from '@/test/fixtures';
import type { DirectoryUser } from '@/lib/api/types';
import { asAdmin, asSupport, ME, PEOPLE } from './testData';
import { aSession, sessionsHandler } from '@/features/ops/test/handlers';
import DirectoryPage from './DirectoryPage';

// sonner replays still-active toasts to every new Toaster, so clear them between tests
afterEach(() => {
  toast.dismiss();
});

const disabledCustomer = aDirectoryUser({
  id: IDS.otherCustomer,
  email: 'vikram@example.in',
  role: 'CUSTOMER',
  isActive: false,
  mfaEnabled: false,
  isEmailVerified: false,
});

function setup(options: { people?: DirectoryUser[]; as?: typeof asAdmin | typeof asSupport; route?: string } = {}) {
  const calls: URLSearchParams[] = [];
  const state = { people: options.people ?? [...PEOPLE, disabledCustomer] };
  server.use(
    http.get(apiUrl('/auth/admin/users'), ({ request }) => {
      const params = new URL(request.url).searchParams;
      calls.push(params);
      const role = params.get('role');
      const q = params.get('q')?.toLowerCase();
      return ok(state.people.filter((p) => (!role || p.role === role) && (!q || p.id === q || p.email.includes(q))));
    })
  );
  const utils = renderWithApp(<DirectoryPage />, { ...(options.as ?? asAdmin), route: options.route ?? '/directory' });
  return { ...utils, calls, state };
}

const row = (email: string) => screen.findByRole('row', { name: new RegExp(email.replace(/\./g, '\\.')) });

async function openActions(user: ReturnType<typeof renderWithApp>['user'], email: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${email}` }));
  return screen.findByRole('menu');
}

describe('DirectoryPage', () => {
  it('lists everyone with role, status, two-factor and verification', async () => {
    const { calls } = setup();
    const teller = await row('meera.teller@banksphere.local');
    expect(within(teller).getAllByText('Teller').length).toBeGreaterThan(0);
    expect(within(teller).getAllByText('Active').length).toBeGreaterThan(0);
    expect(within(teller).getByText('On')).toBeInTheDocument();
    expect(within(teller).getByText('Verified')).toBeInTheDocument();
    expect(within(teller).getByText('1 Oct 2026')).toBeInTheDocument();

    const vikram = await row('vikram@example.in');
    expect(within(vikram).getAllByText('Disabled').length).toBeGreaterThan(0);
    expect(within(vikram).getByText('Off')).toBeInTheDocument();
    expect(within(vikram).getByText('Not verified')).toBeInTheDocument();
    expect(within(vikram).getAllByText('Customer').length).toBeGreaterThan(0);

    expect(screen.getByRole('heading', { level: 1, name: 'Staff & users' })).toBeInTheDocument();
    expect(calls[0]?.get('limit')).toBe('20');
    expect(calls[0]?.get('offset')).toBe('0');
    expect(calls[0]?.has('role')).toBe(false);
  });

  it('links customers to their profile', async () => {
    setup();
    const asha = await row('asha@example.in');
    expect(within(asha).getByRole('link', { name: 'asha@example.in' })).toHaveAttribute('href', `/customers/${IDS.customer}`);
    const teller = await row('meera.teller@banksphere.local');
    expect(within(teller).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows a loading state', async () => {
    server.use(
      http.get(apiUrl('/auth/admin/users'), async () => {
        await delay(50);
        return ok([]);
      })
    );
    renderWithApp(<DirectoryPage />, { ...asAdmin, route: '/directory' });
    expect(screen.getByText('Loading users')).toBeInTheDocument();
    expect(await screen.findByText('No users found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('shows an error and retries', async () => {
    let attempts = 0;
    server.use(
      http.get(apiUrl('/auth/admin/users'), () => {
        attempts += 1;
        return attempts === 1 ? fail(500, 'INTERNAL_SERVER_ERROR') : ok(PEOPLE);
      })
    );
    const { user } = renderWithApp(<DirectoryPage />, { ...asAdmin, route: '/directory' });
    expect(await screen.findByText('Something went wrong on our side')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await row('meera.teller@banksphere.local')).toBeInTheDocument();
  });

  it('filters by role, including customers', async () => {
    const { user, calls } = setup();
    await row('meera.teller@banksphere.local');
    await user.selectOptions(screen.getByLabelText('Role'), 'Customers');
    await waitFor(() => expect(calls.at(-1)?.get('role')).toBe('CUSTOMER'));
    await waitFor(() => expect(screen.queryByRole('row', { name: /meera\.teller/ })).not.toBeInTheDocument());
    expect(await row('asha@example.in')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Role'), 'All roles');
    await waitFor(() => expect(calls.at(-1)?.has('role')).toBe(false));

    await user.selectOptions(screen.getByLabelText('Role'), 'Fraud analyst');
    await waitFor(() => expect(calls.at(-1)?.get('role')).toBe('FRAUD_ANALYST'));
    expect(await screen.findByText('No one matches these filters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await row('meera.teller@banksphere.local')).toBeInTheDocument();
    expect(screen.getByLabelText('Role')).toHaveValue('');
  });

  it('searches by email once typing pauses', async () => {
    const { user, calls } = setup();
    await row('meera.teller@banksphere.local');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'asha');
    await waitFor(() => expect(calls.at(-1)?.get('q')).toBe('asha'));
    // Debounced: one request for the whole word, not one per keystroke
    expect(calls.filter((c) => c.has('q'))).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('row', { name: /meera\.teller/ })).not.toBeInTheDocument());
    expect(await row('asha@example.in')).toBeInTheDocument();
  });

  it('searches by user id', async () => {
    const { user, calls } = setup();
    await row('meera.teller@banksphere.local');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), `  ${IDS.teller} `);
    await waitFor(() => expect(calls.at(-1)?.get('q')).toBe(IDS.teller));
  });

  it('keeps filters in the address so they survive navigation', async () => {
    const { calls } = setup({ route: '/directory?role=TELLER&q=meera' });
    expect(await row('meera.teller@banksphere.local')).toBeInTheDocument();
    expect(calls[0]?.get('role')).toBe('TELLER');
    expect(calls[0]?.get('q')).toBe('meera');
    expect(screen.getByLabelText('Role')).toHaveValue('TELLER');
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('meera');
  });

  it('pages through results', async () => {
    const many = Array.from({ length: 20 }, (_, i) => aDirectoryUser({ id: `user-${i}`, email: `user${i}@example.in`, role: 'CUSTOMER' }));
    const offsets: string[] = [];
    server.use(
      http.get(apiUrl('/auth/admin/users'), ({ request }) => {
        const offset = new URL(request.url).searchParams.get('offset') ?? '0';
        offsets.push(offset);
        return ok(offset === '0' ? many : [aDirectoryUser({ id: 'user-last', email: 'last@example.in', role: 'CUSTOMER' })]);
      })
    );
    const { user } = renderWithApp(<DirectoryPage />, { ...asAdmin, route: '/directory' });
    await row('user0@example.in');
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await row('last@example.in')).toBeInTheDocument();
    expect(offsets).toContain('20');
  });

  it('is read-only for support staff', async () => {
    setup({ as: asSupport });
    await row('meera.teller@banksphere.local');
    expect(screen.getByRole('heading', { level: 1, name: 'User directory' })).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^actions for/i })).not.toBeInTheDocument();
    // Support can still open a customer's profile
    expect(within(await row('asha@example.in')).getByRole('link', { name: 'asha@example.in' })).toBeInTheDocument();
  });

  it('never offers actions on the administrator’s own account', async () => {
    setup();
    const me = await row(ME.email);
    expect(within(me).getByText('You')).toBeInTheDocument();
    expect(within(me).queryByRole('button', { name: /^actions for/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for meera.teller@banksphere.local' })).toBeInTheDocument();
  });

  it('disables a customer immediately after confirming the consequences', async () => {
    let body: unknown;
    const { user, calls, state } = setup();
    server.use(
      http.patch(apiUrl(`/auth/admin/users/${IDS.customer}/status`), async ({ request }) => {
        body = await request.json();
        state.people = state.people.map((p) => (p.id === IDS.customer ? { ...p, isActive: false } : p));
        return ok({ id: IDS.customer, email: 'asha@example.in', role: 'CUSTOMER', isActive: false });
      })
    );
    const menu = await openActions(user, 'asha@example.in');
    await user.click(within(menu).getByRole('menuitem', { name: 'Disable sign-in' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable sign-in for asha@example.in?' });
    expect(dialog).toHaveTextContent(/signs them out on every device immediately/i);
    expect(dialog).toHaveTextContent(/a different administrator must re-enable/i);
    const before = calls.length;
    await user.click(within(dialog).getByRole('button', { name: 'Disable sign-in' }));

    expect(await screen.findByText('Sign-in disabled')).toBeInTheDocument();
    expect(body).toEqual({ isActive: false });
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    const asha = await row('asha@example.in');
    await waitFor(() => expect(within(asha).getAllByText('Disabled').length).toBeGreaterThan(0));
  });

  it('sends staff changes for a second administrator’s approval', async () => {
    let body: unknown;
    const { user } = setup();
    server.use(
      http.patch(apiUrl(`/auth/admin/users/${IDS.teller}/status`), async ({ request }) => {
        body = await request.json();
        return ok({ requestId: 'req-9', status: 'PENDING' }, 202);
      })
    );
    const menu = await openActions(user, 'meera.teller@banksphere.local');
    await user.click(within(menu).getByRole('menuitem', { name: 'Disable sign-in' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Request to disable meera.teller@banksphere.local?' });
    expect(dialog).toHaveTextContent(/second administrator/i);
    expect(dialog).toHaveTextContent(/signed out on every device immediately/i);
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Sent for approval by a second administrator')).toBeInTheDocument();
    expect(body).toEqual({ isActive: false });
  });

  it('offers to re-enable a disabled user', async () => {
    let body: unknown;
    const { user } = setup();
    server.use(
      http.patch(apiUrl(`/auth/admin/users/${IDS.otherCustomer}/status`), async ({ request }) => {
        body = await request.json();
        return ok({ id: IDS.otherCustomer, email: 'vikram@example.in', role: 'CUSTOMER', isActive: true });
      })
    );
    const menu = await openActions(user, 'vikram@example.in');
    await user.click(within(menu).getByRole('menuitem', { name: 'Enable sign-in' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Enable sign-in for vikram@example.in?' });
    await user.click(within(dialog).getByRole('button', { name: 'Enable sign-in' }));
    expect(await screen.findByText('Sign-in enabled')).toBeInTheDocument();
    expect(body).toEqual({ isActive: true });
  });

  it('explains that a different administrator must re-enable someone you disabled', async () => {
    const { user } = setup();
    server.use(
      http.patch(apiUrl(`/auth/admin/users/${IDS.otherCustomer}/status`), () =>
        fail(403, 'FORBIDDEN', 'A user you disabled must be re-enabled by a different administrator')
      )
    );
    const menu = await openActions(user, 'vikram@example.in');
    await user.click(within(menu).getByRole('menuitem', { name: 'Enable sign-in' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Enable sign-in' }));
    expect(await screen.findByText('Another administrator must re-enable this user')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('requests an authenticator reset, spelling out the re-enrolment', async () => {
    let called = false;
    const { user } = setup();
    server.use(
      http.post(apiUrl(`/auth/admin/users/${IDS.teller}/mfa/reset`), () => {
        called = true;
        return ok({ requestId: 'req-10', status: 'PENDING' }, 202);
      })
    );
    const menu = await openActions(user, 'meera.teller@banksphere.local');
    await user.click(within(menu).getByRole('menuitem', { name: 'Reset authenticator' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Request an authenticator reset for meera.teller@banksphere.local?' });
    expect(dialog).toHaveTextContent(/current authenticator stops working/i);
    expect(dialog).toHaveTextContent(/re-enrol/i);
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Sent for approval by a second administrator')).toBeInTheDocument();
    expect(called).toBe(true);
  });

  it('only offers an authenticator reset to customers who have one', async () => {
    const { user } = setup();
    const menu = await openActions(user, 'asha@example.in');
    expect(within(menu).getByRole('menuitem', { name: /reset authenticator/i })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitem', { name: 'Open customer profile' })).toBeInTheDocument();
  });

  it('explains when a second approval is required', async () => {
    const { user } = setup();
    server.use(
      http.post(apiUrl(`/auth/admin/users/${IDS.teller}/mfa/reset`), () =>
        fail(409, 'APPROVAL_REQUIRED', 'Resetting MFA requires a four-eyes admin request')
      )
    );
    const menu = await openActions(user, 'meera.teller@banksphere.local');
    await user.click(within(menu).getByRole('menuitem', { name: 'Reset authenticator' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Second approval required')).toBeInTheDocument();
  });

  it('refreshes the list when the user no longer exists', async () => {
    const { user, calls } = setup();
    server.use(http.patch(apiUrl(`/auth/admin/users/${IDS.customer}/status`), () => fail(404, 'NOT_FOUND', 'User not found')));
    const menu = await openActions(user, 'asha@example.in');
    await user.click(within(menu).getByRole('menuitem', { name: 'Disable sign-in' }));
    const dialog = await screen.findByRole('alertdialog');
    const before = calls.length;
    await user.click(within(dialog).getByRole('button', { name: 'Disable sign-in' }));
    expect(await screen.findByText('User not found')).toBeInTheDocument();
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('works from the keyboard alone', async () => {
    const { user } = setup();
    const trigger = await screen.findByRole('button', { name: 'Actions for meera.teller@banksphere.local' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Disable sign-in' })).toHaveFocus());
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog', { name: 'Request to disable meera.teller@banksphere.local?' });
    // Safe by default: focus starts on Cancel, and Escape backs out without doing anything
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('lets administrators (only) start a staff request from here', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Request new staff member' }));
    expect(await screen.findByRole('dialog', { name: 'Request a new staff member' })).toBeInTheDocument();
  });

  it('does not offer staff requests to support', async () => {
    setup({ as: asSupport });
    await row('meera.teller@banksphere.local');
    expect(screen.queryByRole('button', { name: 'Request new staff member' })).not.toBeInTheDocument();
  });

  it('keeps the confirmation open after a temporary failure', async () => {
    const { user } = setup();
    server.use(http.patch(apiUrl(`/auth/admin/users/${IDS.customer}/status`), () => HttpResponse.error()));
    const menu = await openActions(user, 'asha@example.in');
    await user.click(within(menu).getByRole('menuitem', { name: 'Disable sign-in' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disable sign-in' }));
    expect(await screen.findByText('You appear to be offline')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows administrators where someone is signed in, with sign-out', async () => {
    const seen: string[] = [];
    const { user } = setup();
    server.use(
      sessionsHandler((request) => {
        seen.push(new URL(request.url).pathname);
        return [aSession({ deviceLabel: 'Edge on Windows' })];
      })
    );
    const menu = await openActions(user, 'meera.teller@banksphere.local');
    await user.click(within(menu).getByRole('menuitem', { name: 'Sessions and devices' }));
    const sheet = await screen.findByRole('dialog', { name: 'Sessions for meera.teller@banksphere.local' });
    expect(await within(sheet).findByText('Edge on Windows')).toBeInTheDocument();
    expect(within(sheet).getByText(/Teller/)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /^sign out edge on windows/i })).toBeInTheDocument();
    expect(within(sheet).queryByRole('link', { name: 'Open customer profile' })).not.toBeInTheDocument();
    expect(seen).toEqual([`/api/v1/auth/admin/users/${IDS.teller}/sessions`]);
  });

  it('lets support see sessions, read-only, and reach the customer’s profile', async () => {
    const { user } = setup({ as: asSupport });
    server.use(sessionsHandler([aSession()]));
    await user.click(await screen.findByRole('button', { name: 'Sessions and devices for asha@example.in' }));
    const sheet = await screen.findByRole('dialog', { name: 'Sessions for asha@example.in' });
    expect(await within(sheet).findByText('Chrome on Windows')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'Open customer profile' })).toHaveAttribute('href', `/customers/${IDS.customer}`);
    await user.click(within(sheet).getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
