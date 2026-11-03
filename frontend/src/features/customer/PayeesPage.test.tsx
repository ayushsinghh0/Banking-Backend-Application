import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aBeneficiary } from '@/test/fixtures';
import { makeAccessToken } from '@/test/tokens';
import type { Beneficiary } from '@/lib/api/types';
import { minutesFromNow } from './testing';
import { formatDate } from './lib';
import PayeesPage from './PayeesPage';

const landlord = aBeneficiary({ activatesAt: minutesFromNow(-7 * 24 * 60), createdAt: minutesFromNow(-7 * 24 * 60 - 60) });
const plumber = aBeneficiary({
  id: 'ben-2',
  nickname: 'Plumber',
  accountNumber: '100177778888',
  activatesAt: minutesFromNow(41.5),
  createdAt: minutesFromNow(-18.5),
});

/** A payee list that changes as payees are added and removed, recording what was sent */
function payeesApi(initial: Beneficiary[], addResponse?: () => Response) {
  let list = [...initial];
  const added: unknown[] = [];
  const removed: string[] = [];
  server.use(
    http.get(apiUrl('/transactions/beneficiaries'), () => ok(list)),
    http.post(apiUrl('/transactions/beneficiaries'), async ({ request }) => {
      const body = (await request.json()) as { accountNumber: string; nickname: string };
      added.push(body);
      if (addResponse) return addResponse();
      const payee = aBeneficiary({ id: 'ben-new', ...body, activatesAt: minutesFromNow(60), createdAt: new Date().toISOString() });
      list = [payee, ...list];
      return ok(payee, 201);
    }),
    http.delete(apiUrl('/transactions/beneficiaries/:id'), ({ params }) => {
      removed.push(String(params.id));
      list = list.filter((p) => p.id !== params.id);
      return ok(undefined);
    })
  );
  return { added, removed };
}

const render = (route = '/payees', claims = {}) => renderWithApp(<PayeesPage />, { route, path: '/payees', claims });
type User = ReturnType<typeof renderWithApp>['user'];

async function fillPayee(user: User, accountNumber = '1001 9876 5432', nickname = 'Ravi') {
  await user.click(await screen.findByRole('button', { name: 'Add payee' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a payee' });
  await user.type(within(dialog).getByLabelText('Account number'), accountNumber);
  await user.type(within(dialog).getByLabelText('Nickname'), nickname);
  return dialog;
}

describe('PayeesPage', () => {
  it('lists payees with their status, when they were added and a way to pay them', async () => {
    payeesApi([landlord, plumber]);
    render();
    await screen.findByText('Ravi (landlord)');
    const rows = within(screen.getByRole('list', { name: 'Your payees' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('••••5432');
    // Ready to pay is the normal state: only a payee still cooling off is called out
    expect(rows[0]).not.toHaveTextContent(/activates in/i);
    expect(rows[0]).toHaveTextContent(`Added ${formatDate(landlord.createdAt)}`);
    expect(within(rows[0]!).getByRole('link', { name: 'Pay Ravi (landlord)' })).toHaveAttribute('href', '/transfer?payee=ben-1');
    expect(within(rows[1]!).getByText('Activates in 42 min')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Pay Plumber' })).toBeDisabled();
  });

  it('explains the cooling-off period and the first-day limit', async () => {
    payeesApi([landlord]);
    render();
    expect(await screen.findByText(/60-minute cooling-off period/i)).toBeInTheDocument();
    expect(screen.getByText(/up to ₹50,000\.00 in total/i)).toBeInTheDocument();
  });

  it('shows an empty state that invites adding the first payee', async () => {
    payeesApi([]);
    const { user } = render();
    expect(await screen.findByText('No payees yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Add payee' })[0]!);
    expect(await screen.findByRole('dialog', { name: 'Add a payee' })).toBeInTheDocument();
  });

  it('shows an error with a retry when payees cannot be loaded', async () => {
    let calls = 0;
    server.use(
      http.get(apiUrl('/transactions/beneficiaries'), () => {
        calls += 1;
        return calls === 1 ? fail(503, 'SERVICE_BUSY', 'busy') : ok([landlord]);
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Ravi (landlord)')).toBeInTheDocument();
  });

  it('opens the add dialog straight from a link', async () => {
    payeesApi([]);
    render('/payees?add=1');
    expect(await screen.findByRole('dialog', { name: 'Add a payee' })).toBeInTheDocument();
  });

  it('adds a payee with the standard cooling-off period, accepting spaces in the number', async () => {
    const { added } = payeesApi([]);
    const { user } = render();
    const dialog = await fillPayee(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add payee' }));
    expect(await screen.findByText('Ravi added')).toBeInTheDocument();
    expect(screen.getByText(/ready to pay at/i)).toBeInTheDocument();
    expect(added).toEqual([{ accountNumber: '100198765432', nickname: 'Ravi' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Activates in 1 h')).toBeInTheDocument();
  });

  it('checks the account number and nickname before sending', async () => {
    const { added } = payeesApi([]);
    const { user } = render();
    const dialog = await fillPayee(user, '12345', ' ');
    await user.click(within(dialog).getByRole('button', { name: 'Add payee' }));
    expect(await within(dialog).findByText('Account numbers are 12 digits')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a nickname')).toBeInTheDocument();
    expect(added).toHaveLength(0);
  });

  it('activates a payee instantly when the session was just verified with the authenticator', async () => {
    const { added } = payeesApi([], () => ok(aBeneficiary({ id: 'ben-new', nickname: 'Ravi', activatesAt: new Date().toISOString() }), 201));
    const { user } = render('/payees', { mfa: true, stepUpAt: Math.floor(Date.now() / 1000) - 5 });
    const dialog = await fillPayee(user);
    await user.click(within(dialog).getByRole('checkbox', { name: /activate now with my authenticator/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Add payee' }));
    expect(await screen.findByText('Ravi added')).toBeInTheDocument();
    expect(screen.getByText(/ready to pay now/i)).toBeInTheDocument();
    expect(added).toHaveLength(1);
  });

  it('asks for an authenticator code before activating instantly', async () => {
    const fresh = makeAccessToken({ mfa: true, stepUpAt: Math.floor(Date.now() / 1000) });
    let codeSent = '';
    server.use(
      http.post(apiUrl('/auth/mfa/step-up'), async ({ request }) => {
        codeSent = ((await request.json()) as { code: string }).code;
        return ok({ accessToken: fresh, expiresInSeconds: 900 });
      })
    );
    const { added } = payeesApi([], () => ok(aBeneficiary({ id: 'ben-new', nickname: 'Ravi', activatesAt: new Date().toISOString() }), 201));
    const { user } = render('/payees', { mfa: true });
    const dialog = await fillPayee(user);
    await user.click(within(dialog).getByRole('checkbox', { name: /activate now/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Add payee' }));
    await user.type(await screen.findByLabelText(/authenticator code/i), '654321');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByText('Ravi added')).toBeInTheDocument();
    expect(codeSent).toBe('654321');
    expect(added).toHaveLength(1);
  });

  it('offers the usual cooling-off instead when the authenticator check is cancelled', async () => {
    const { added } = payeesApi([]);
    const { user } = render('/payees', { mfa: true });
    const dialog = await fillPayee(user);
    await user.click(within(dialog).getByRole('checkbox', { name: /activate now/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Add payee' }));
    await screen.findByLabelText(/authenticator code/i);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await within(dialog).findByText('Not approved with your authenticator')).toBeInTheDocument();
    expect(added).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Add with cooling-off period' }));
    expect(await screen.findByText('Ravi added')).toBeInTheDocument();
    expect(added).toHaveLength(1);
  });

  it('explains that instant activation needs an authenticator', async () => {
    payeesApi([]);
    const { user } = render('/payees', { mfa: false });
    await user.click(await screen.findByRole('button', { name: 'Add payee' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a payee' });
    expect(within(dialog).getByRole('checkbox', { name: /activate now/i })).toBeDisabled();
    expect(within(dialog).getByRole('link', { name: /turn on two-factor authentication/i })).toHaveAttribute('href', '/settings/security');
  });

  it.each([
    ['INVALID_DESTINATION', 422, 'This account cannot be added as a beneficiary', 'This account can’t be added. Check the number with the person you’re paying.'],
    ['OWN_ACCOUNT', 400, 'Your own accounts do not need to be added as beneficiaries', 'That’s one of your own accounts. You can transfer to it without adding it as a payee.'],
    ['CONFLICT', 409, 'This beneficiary already exists', 'This account is already one of your payees.'],
  ])('explains %s next to the account number', async (code, status, message, shown) => {
    payeesApi([], () => fail(status, code, message));
    const { user } = render();
    const dialog = await fillPayee(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add payee' }));
    expect(await within(dialog).findByText(shown)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Account number')).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains the daily limit on adding payees', async () => {
    payeesApi([], () => fail(429, 'RATE_LIMIT_EXCEEDED', 'Too many beneficiaries added today'));
    const { user } = render();
    const dialog = await fillPayee(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add payee' }));
    expect(await within(dialog).findByText('Too many payees added today')).toBeInTheDocument();
  });

  it('removes a payee after confirmation', async () => {
    const { removed } = payeesApi([landlord, plumber]);
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Remove Ravi (landlord)' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Ravi (landlord)?' });
    expect(within(dialog).getByText(/restarts the cooling-off period/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove payee' }));
    expect(await screen.findByText('Ravi (landlord) removed')).toBeInTheDocument();
    expect(removed).toEqual(['ben-1']);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Pay Ravi (landlord)' })).not.toBeInTheDocument());
  });
});
