import { delay, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { toast } from 'sonner';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { anAdminRequest, IDS } from '@/test/fixtures';
import type { AdminRequest } from '@/lib/api/types';
import { asAdmin, directoryLookupHandler, hoursAgo, hoursFromNow, ME, PEOPLE } from './testData';
import ApprovalsPage from './ApprovalsPage';

// sonner replays still-active toasts to every new Toaster, so clear them between tests
afterEach(() => {
  toast.dismiss();
});

const createStaff = anAdminRequest({ id: 'req-create', createdAt: hoursAgo(2), expiresAt: hoursFromNow(22) });
const disableTeller = anAdminRequest({
  id: 'req-disable',
  type: 'SET_USER_ACTIVE',
  payload: { userId: IDS.teller, isActive: false },
  targetUserId: IDS.teller,
  createdAt: hoursAgo(1),
  expiresAt: hoursFromNow(23),
});
const resetCustomer = anAdminRequest({
  id: 'req-reset',
  type: 'RESET_MFA',
  payload: { userId: IDS.customer },
  targetUserId: IDS.customer,
  createdAt: hoursAgo(3),
  expiresAt: hoursFromNow(21),
});
const mine = anAdminRequest({
  id: 'req-mine',
  requestedBy: ME.id,
  payload: { email: 'new.kyc@banksphere.local', role: 'KYC_OFFICER' },
  createdAt: hoursAgo(1),
  expiresAt: hoursFromNow(23),
});
const aboutMe = anAdminRequest({
  id: 'req-about-me',
  type: 'RESET_MFA',
  payload: { userId: ME.id },
  targetUserId: ME.id,
  createdAt: hoursAgo(1),
  expiresAt: hoursFromNow(23),
});
const expired = anAdminRequest({
  id: 'req-expired',
  payload: { email: 'late.teller@banksphere.local', role: 'TELLER' },
  createdAt: hoursAgo(30),
  expiresAt: hoursAgo(6),
});

type ByStatus = Partial<Record<'PENDING' | 'APPROVED' | 'REJECTED', AdminRequest[]>>;

function setup(byStatus: ByStatus, route = '/approvals') {
  const calls: URLSearchParams[] = [];
  const lookups: string[] = [];
  const state = { byStatus };
  server.use(
    http.get(apiUrl('/auth/admin/requests'), ({ request }) => {
      const params = new URL(request.url).searchParams;
      calls.push(params);
      return ok(state.byStatus[(params.get('status') ?? 'PENDING') as keyof ByStatus] ?? []);
    }),
    directoryLookupHandler(PEOPLE, lookups)
  );
  const utils = renderWithApp(<ApprovalsPage />, { ...asAdmin, route });
  return { ...utils, calls, lookups, state };
}

const findCard = (name: RegExp) => screen.findByRole('article', { name });

describe('ApprovalsPage', () => {
  it('lists pending requests as readable cards, with people resolved from their ids', async () => {
    const { calls, lookups } = setup({ PENDING: [createStaff, disableTeller, resetCustomer] });

    const create = await findCard(/create staff member/i);
    expect(within(create).getByText('meera.teller@banksphere.local')).toBeInTheDocument();
    expect(within(create).getByText('Teller')).toBeInTheDocument();
    expect(await within(create).findByText('rahul.admin@banksphere.local')).toBeInTheDocument();
    expect(within(create).getByText('2 hours ago')).toBeInTheDocument();
    expect(within(create).getByText('in 22 hours')).toBeInTheDocument();

    const disable = await findCard(/disable sign-in/i);
    expect(await within(disable).findByText('meera.teller@banksphere.local')).toBeInTheDocument();
    const reset = await findCard(/reset authenticator/i);
    expect(await within(reset).findByText('asha@example.in')).toBeInTheDocument();

    expect(screen.getByRole('tab', { name: /pending/i })).toHaveAttribute('aria-selected', 'true');
    expect(calls[0]?.get('status')).toBe('PENDING');
    expect(calls[0]?.get('limit')).toBe('20');
    expect(calls[0]?.get('offset')).toBe('0');
    expect(lookups).toEqual(expect.arrayContaining([IDS.admin2, IDS.teller, IDS.customer]));
    // The signed-in administrator is never looked up: they are "You"
    expect(lookups).not.toContain(ME.id);
  });

  it('shows a loading state, then says when nothing is waiting', async () => {
    server.use(
      http.get(apiUrl('/auth/admin/requests'), async () => {
        await delay(50);
        return ok([]);
      })
    );
    renderWithApp(<ApprovalsPage />, { ...asAdmin, route: '/approvals' });
    expect(screen.getByText('Loading requests')).toBeInTheDocument();
    expect(await screen.findByText('No requests waiting for a decision')).toBeInTheDocument();
  });

  it('shows an error and retries', async () => {
    let attempts = 0;
    server.use(
      http.get(apiUrl('/auth/admin/requests'), () => {
        attempts += 1;
        return attempts === 1 ? fail(500, 'INTERNAL_SERVER_ERROR') : ok([createStaff]);
      }),
      directoryLookupHandler()
    );
    const { user } = renderWithApp(<ApprovalsPage />, { ...asAdmin, route: '/approvals' });
    expect(await screen.findByText('Something went wrong on our side')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await findCard(/create staff member/i)).toBeInTheDocument();
  });

  it('approves a staff request after spelling out exactly what will happen', async () => {
    let approved = '';
    const { user, state, calls } = setup({ PENDING: [createStaff] });
    server.use(
      http.post(apiUrl('/auth/admin/requests/:id/approve'), ({ params }) => {
        approved = String(params.id);
        state.byStatus = { PENDING: [] };
        return ok({ request: { ...createStaff, status: 'APPROVED' }, outcome: {} });
      })
    );

    const card = await findCard(/create staff member/i);
    await user.click(within(card).getByRole('button', { name: /^approve/i }));
    const dialog = await screen.findByRole('alertdialog', { name: /approve new staff member/i });
    expect(dialog).toHaveTextContent(/emails a one-time activation link to meera\.teller@banksphere\.local/i);
    expect(dialog).toHaveTextContent(/never see staff passwords/i);

    await user.click(within(dialog).getByRole('button', { name: 'Approve and send invite' }));
    expect(await screen.findByText('Staff member approved')).toBeInTheDocument();
    expect(approved).toBe('req-create');
    expect(await screen.findByText('No requests waiting for a decision')).toBeInTheDocument();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('describes the consequences of disabling and of resetting an authenticator', async () => {
    const { user } = setup({ PENDING: [disableTeller, resetCustomer] });

    const disable = await findCard(/disable sign-in/i);
    await within(disable).findByText('meera.teller@banksphere.local');
    await user.click(within(disable).getByRole('button', { name: /^approve/i }));
    let dialog = await screen.findByRole('alertdialog', { name: /approve disabling meera\.teller@banksphere\.local/i });
    expect(dialog).toHaveTextContent(/signed out on every device immediately/i);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const reset = await findCard(/reset authenticator/i);
    await within(reset).findByText('asha@example.in');
    await user.click(within(reset).getByRole('button', { name: /^approve/i }));
    dialog = await screen.findByRole('alertdialog', { name: /approve authenticator reset for asha@example\.in/i });
    expect(dialog).toHaveTextContent(/current authenticator stops working/i);
    expect(dialog).toHaveTextContent(/set up two-factor authentication again/i);
  });

  it.each([
    [disableTeller, /disable sign-in/i, 'Approve and disable', 'Sign-in disabled'],
    [resetCustomer, /reset authenticator/i, 'Approve reset', 'Authenticator reset'],
  ])('confirms what changed after approving', async (request, cardName, confirmLabel, toastTitle) => {
    const { user } = setup({ PENDING: [request] });
    server.use(http.post(apiUrl('/auth/admin/requests/:id/approve'), () => ok({ request, outcome: {} })));
    const card = await findCard(cardName);
    await user.click(within(card).getByRole('button', { name: /^approve/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: confirmLabel }));
    expect(await screen.findByText(toastTitle)).toBeInTheDocument();
  });

  it('shows a short id when a person can’t be found in the directory', async () => {
    const stranger = anAdminRequest({ id: 'req-stranger', requestedBy: '99999999-9999-4999-8999-999999999999', expiresAt: hoursFromNow(5) });
    setup({ PENDING: [stranger] });
    const card = await findCard(/create staff member/i);
    expect(await within(card).findByText('User 99999999…')).toHaveAttribute('title', '99999999-9999-4999-8999-999999999999');
  });

  it('rejects a colleague’s request', async () => {
    let rejected = '';
    const { user, state } = setup({ PENDING: [createStaff] });
    server.use(
      http.post(apiUrl('/auth/admin/requests/:id/reject'), ({ params }) => {
        rejected = String(params.id);
        state.byStatus = { PENDING: [] };
        return ok({ id: params.id, status: 'REJECTED' });
      })
    );
    const card = await findCard(/create staff member/i);
    await user.click(within(card).getByRole('button', { name: /^reject/i }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reject this request?' });
    expect(dialog).toHaveTextContent(/nothing changes/i);
    await user.click(within(dialog).getByRole('button', { name: 'Reject request' }));
    expect(await screen.findByText('Request rejected')).toBeInTheDocument();
    expect(rejected).toBe('req-create');
  });

  it('lets me withdraw my own request but never approve it', async () => {
    let rejected = '';
    const { user } = setup({ PENDING: [mine] });
    server.use(
      http.post(apiUrl('/auth/admin/requests/:id/reject'), ({ params }) => {
        rejected = String(params.id);
        return ok({ id: params.id, status: 'REJECTED' });
      })
    );
    const card = await findCard(/new\.kyc@banksphere\.local/i);
    expect(within(card).getByText('You')).toBeInTheDocument();
    const approve = within(card).getByRole('button', { name: /^approve/i });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/you made this request, so a different administrator must approve it/i);

    await user.click(within(card).getByRole('button', { name: /^withdraw/i }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw your request?' });
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw request' }));
    expect(await screen.findByText('Request withdrawn')).toBeInTheDocument();
    expect(rejected).toBe('req-mine');
  });

  it('does not let me decide a request about my own account', async () => {
    setup({ PENDING: [aboutMe] });
    const card = await findCard(/reset authenticator/i);
    expect(within(card).getByText('Your account')).toBeInTheDocument();
    const approve = within(card).getByRole('button', { name: /^approve/i });
    const reject = within(card).getByRole('button', { name: /^reject/i });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/about your account, so another administrator must decide it/i);
  });

  it('flags expired requests and only offers to clear them', async () => {
    setup({ PENDING: [expired] });
    const card = await findCard(/late\.teller@banksphere\.local/i);
    expect(within(card).getByText('Expired')).toBeInTheDocument();
    const approve = within(card).getByRole('button', { name: /^approve/i });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/expired 6 hours ago/i);
    expect(within(card).getByRole('button', { name: /^reject/i })).toBeEnabled();
  });

  it.each([
    [409, 'CONFLICT', 'Request is already APPROVED', 'Already decided'],
    [409, 'CONFLICT', 'This request has expired', 'This request has expired'],
    [403, 'FORBIDDEN', 'A request must be approved by a different administrator', 'You can’t approve this request'],
    [404, 'NOT_FOUND', 'Admin request not found', 'Request not found'],
  ])('handles %s %s when approving', async (status, code, message, title) => {
    const { user, calls } = setup({ PENDING: [createStaff] });
    server.use(http.post(apiUrl('/auth/admin/requests/:id/approve'), () => fail(status, code, message)));
    const card = await findCard(/create staff member/i);
    await user.click(within(card).getByRole('button', { name: /^approve/i }));
    const dialog = await screen.findByRole('alertdialog');
    const before = calls.length;
    await user.click(within(dialog).getByRole('button', { name: 'Approve and send invite' }));
    expect(await screen.findByText(title)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    // The request's state changed (or was never ours to decide): the list is refreshed
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('keeps the confirmation open to retry after a temporary failure', async () => {
    let attempts = 0;
    const { user } = setup({ PENDING: [createStaff] });
    server.use(
      http.post(apiUrl('/auth/admin/requests/:id/approve'), () => {
        attempts += 1;
        return attempts === 1 ? fail(503, 'SERVICE_UNAVAILABLE') : ok({ request: createStaff, outcome: {} });
      })
    );
    const card = await findCard(/create staff member/i);
    await user.click(within(card).getByRole('button', { name: /^approve/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve and send invite' }));
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve and send invite' }));
    expect(await screen.findByText('Staff member approved')).toBeInTheDocument();
  });

  it('explains when the person a request is about tries to reject it', async () => {
    const { user } = setup({ PENDING: [createStaff] });
    server.use(
      http.post(apiUrl('/auth/admin/requests/:id/reject'), () =>
        fail(403, 'FORBIDDEN', 'You cannot reject a request that concerns your own account')
      )
    );
    const card = await findCard(/create staff member/i);
    await user.click(within(card).getByRole('button', { name: /^reject/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject request' }));
    expect(await screen.findByText('You can’t reject this request')).toBeInTheDocument();
  });

  it('shows who decided each request on the history tabs', async () => {
    const approved = anAdminRequest({
      id: 'req-approved',
      status: 'APPROVED',
      requestedBy: ME.id,
      decidedBy: IDS.admin2,
      decidedAt: hoursAgo(3),
      createdAt: hoursAgo(5),
    });
    const lapsed = anAdminRequest({
      id: 'req-lapsed',
      status: 'REJECTED',
      payload: { email: 'late.teller@banksphere.local', role: 'TELLER' },
      decidedBy: null,
      decidedAt: hoursAgo(1),
      createdAt: hoursAgo(30),
    });
    const { user, calls } = setup({ PENDING: [], APPROVED: [approved], REJECTED: [lapsed] });
    await screen.findByText('No requests waiting for a decision');

    await user.click(screen.getByRole('tab', { name: /approved/i }));
    const card = await findCard(/create staff member/i);
    expect(within(card).getByText('Approved')).toBeInTheDocument();
    expect(within(card).getByText('You')).toBeInTheDocument();
    expect(await within(card).findByText('rahul.admin@banksphere.local')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    expect(calls.at(-1)?.get('status')).toBe('APPROVED');

    await user.click(screen.getByRole('tab', { name: /rejected/i }));
    const rejected = await findCard(/late\.teller@banksphere\.local/i);
    expect(within(rejected).getByText('Expired without a decision')).toBeInTheDocument();
    expect(calls.at(-1)?.get('status')).toBe('REJECTED');
  });

  it('opens a history tab from the address', async () => {
    const { calls } = setup({ APPROVED: [] }, '/approvals?status=approved');
    expect(await screen.findByText('No approved requests yet')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /approved/i })).toHaveAttribute('aria-selected', 'true');
    expect(calls[0]?.get('status')).toBe('APPROVED');
  });

  it('pages through long queues', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) =>
      anAdminRequest({ id: `req-${i}`, payload: { email: `person${i}@banksphere.local`, role: 'SUPPORT' }, expiresAt: hoursFromNow(10) })
    );
    const page2 = [anAdminRequest({ id: 'req-last', payload: { email: 'last.one@banksphere.local', role: 'SUPPORT' }, expiresAt: hoursFromNow(10) })];
    const offsets: string[] = [];
    server.use(
      http.get(apiUrl('/auth/admin/requests'), ({ request }) => {
        const offset = new URL(request.url).searchParams.get('offset') ?? '0';
        offsets.push(offset);
        return ok(offset === '0' ? page1 : page2);
      }),
      directoryLookupHandler()
    );
    const { user } = renderWithApp(<ApprovalsPage />, { ...asAdmin, route: '/approvals' });
    expect(await findCard(/person0@banksphere\.local/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await findCard(/last\.one@banksphere\.local/i)).toBeInTheDocument();
    expect(offsets).toContain('20');
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });
});

describe('Request a new staff member', () => {
  async function openDialog() {
    const utils = setup({ PENDING: [] });
    await screen.findByText('No requests waiting for a decision');
    await utils.user.click(screen.getByRole('button', { name: 'Request new staff member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request a new staff member' });
    return { ...utils, dialog };
  }

  it('describes every role so the right one is chosen', async () => {
    const { dialog } = await openDialog();
    for (const role of ['Support', 'Teller', 'KYC officer', 'Fraud analyst', 'Bank administrator']) {
      expect(within(dialog).getByRole('radio', { name: new RegExp(`^${role}`) })).toBeInTheDocument();
    }
    expect(within(dialog).getByRole('radio', { name: /^teller/i })).toHaveAccessibleDescription(/cash desk/i);
    expect(within(dialog).getByRole('radio', { name: /^support/i })).toHaveAccessibleDescription(/read-only/i);
  });

  it('checks the email and role before sending', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('Enter their corporate email address')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a role')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Corporate email'), 'not-an-email');
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('Enter a valid email address')).toBeInTheDocument();
  });

  it('sends the request and explains what happens next', async () => {
    let body: unknown;
    const { user, dialog, calls } = await openDialog();
    server.use(
      http.post(apiUrl('/auth/admin/users'), async ({ request }) => {
        body = await request.json();
        return ok({ requestId: 'req-new', status: 'PENDING' }, 202);
      })
    );
    const before = calls.length;
    await user.type(within(dialog).getByLabelText('Corporate email'), '  Kavya.Fraud@BankSphere.local ');
    await user.click(within(dialog).getByRole('radio', { name: /^fraud analyst/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));

    expect(await within(dialog).findByText('Sent for approval')).toBeInTheDocument();
    expect(body).toEqual({ email: 'kavya.fraud@banksphere.local', role: 'FRAUD_ANALYST' });
    expect(dialog).toHaveTextContent(/a second administrator must approve/i);
    expect(dialog).toHaveTextContent(/kavya\.fraud@banksphere\.local receives an activation email to set their own password and authenticator/i);
    expect(dialog).toHaveTextContent(/administrators never see staff passwords/i);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('explains the corporate email domain rule', async () => {
    const { user, dialog } = await openDialog();
    server.use(
      http.post(apiUrl('/auth/admin/users'), () =>
        fail(400, 'STAFF_EMAIL_DOMAIN', 'Staff accounts must use an @banksphere.local address')
      )
    );
    await user.type(within(dialog).getByLabelText('Corporate email'), 'kavya@gmail.com');
    await user.click(within(dialog).getByRole('radio', { name: /^teller/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('Staff accounts must use an @banksphere.local address')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Corporate email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('says when an account already exists for the address', async () => {
    const { user, dialog } = await openDialog();
    server.use(http.post(apiUrl('/auth/admin/users'), () => fail(409, 'CONFLICT', 'An account with this email already exists')));
    await user.type(within(dialog).getByLabelText('Corporate email'), 'meera.teller@banksphere.local');
    await user.click(within(dialog).getByRole('radio', { name: /^teller/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('An account with this email already exists.')).toBeInTheDocument();
  });

  it('maps the server’s field errors onto the form', async () => {
    const { user, dialog } = await openDialog();
    server.use(
      http.post(apiUrl('/auth/admin/users'), () =>
        fail(400, 'VALIDATION_ERROR', 'Validation failed', { details: [{ field: 'email', message: 'Invalid email address format' }] })
      )
    );
    await user.type(within(dialog).getByLabelText('Corporate email'), 'kavya@banksphere.local');
    await user.click(within(dialog).getByRole('radio', { name: /^support/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('Invalid email address format')).toBeInTheDocument();
  });

  it('can send another request straight away', async () => {
    const { user, dialog } = await openDialog();
    server.use(http.post(apiUrl('/auth/admin/users'), () => ok({ requestId: 'req-new', status: 'PENDING' }, 202)));
    await user.type(within(dialog).getByLabelText('Corporate email'), 'kavya@banksphere.local');
    await user.click(within(dialog).getByRole('radio', { name: /^support/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Request another' }));
    expect(within(dialog).getByLabelText('Corporate email')).toHaveValue('');
    expect(within(dialog).getByRole('radio', { name: /^support/i })).not.toBeChecked();
  });

  it('shows other failures inside the form', async () => {
    const { user, dialog } = await openDialog();
    server.use(http.post(apiUrl('/auth/admin/users'), () => fail(403, 'NETWORK_NOT_ALLOWED', 'Staff network only')));
    await user.type(within(dialog).getByLabelText('Corporate email'), 'kavya@banksphere.local');
    await user.click(within(dialog).getByRole('radio', { name: /^support/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('Staff network required')).toBeInTheDocument();
  });
});
