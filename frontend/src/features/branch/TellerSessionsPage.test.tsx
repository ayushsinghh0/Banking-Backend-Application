import { http } from 'msw';
import { toast } from 'sonner';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, aDirectoryUser, aTellerSession } from '@/test/fixtures';
import type { Role } from '@/lib/auth/session';
import type { TellerSession } from '@/lib/api/types';
import TellerSessionsPage from './TellerSessionsPage';

// Sonner replays still-active toasts into the next test's Toaster: clear them between tests
afterEach(() => {
  toast.dismiss();
});

const TELLER_2 = '66666666-6666-4666-8666-666666666666';
const UNKNOWN_TELLER = '77777777-7777-4777-8777-777777777777';

function directory({ fails = false }: { fails?: boolean } = {}) {
  server.use(
    http.get(apiUrl('/auth/admin/users'), ({ request }) => {
      if (fails) return fail(500, 'INTERNAL_SERVER_ERROR');
      const role = new URL(request.url).searchParams.get('role');
      if (role === 'TELLER') {
        return ok([
          aDirectoryUser(),
          aDirectoryUser({ id: TELLER_2, email: 'ravi.teller@banksphere.local' }),
          aDirectoryUser({ id: '88888888-8888-4888-8888-888888888888', email: 'gone.teller@banksphere.local', isActive: false }),
        ]);
      }
      if (role === 'BANK_ADMIN') return ok([aDirectoryUser({ id: IDS.admin, email: 'priya.admin@banksphere.local', role: 'BANK_ADMIN' })]);
      return ok([]);
    })
  );
}

function sessions(respond: (status: string | null, offset: string | null) => TellerSession[] | Response) {
  const seen: Array<{ status: string | null; offset: string | null; limit: string | null }> = [];
  server.use(
    http.get(apiUrl('/transactions/teller/sessions'), ({ request }) => {
      const p = new URL(request.url).searchParams;
      seen.push({ status: p.get('status'), offset: p.get('offset'), limit: p.get('limit') });
      const result = respond(p.get('status'), p.get('offset'));
      return result instanceof Response ? result : ok(result);
    })
  );
  return seen;
}

const renderPage = (role: Role = 'BANK_ADMIN') =>
  renderWithApp(<TellerSessionsPage />, { role, claims: { sub: IDS.admin2 }, route: '/teller-sessions' });

const reconciled = (o: Partial<TellerSession> = {}) =>
  aTellerSession({
    id: 'sess-r',
    status: 'RECONCILED',
    closedAt: '2026-10-27T12:00:00.000Z',
    declaredClosing: '7300000',
    expectedClosing: '7320000',
    discrepancy: '-20000',
    signedOffBy: IDS.admin,
    signedOffAt: '2026-10-27T12:30:00.000Z',
    ...o,
  });

describe('TellerSessionsPage — list', () => {
  it('lists sessions with teller emails, falling back to a short id', async () => {
    directory();
    const seen = sessions(() => [aTellerSession(), aTellerSession({ id: 'sess-2', tellerId: UNKNOWN_TELLER, status: 'ISSUED', acceptedAt: null })]);
    renderPage();
    const table = await screen.findByRole('table', { name: 'Teller sessions' });
    expect(await within(table).findByText('77777777…')).toBeInTheDocument();
    expect(await within(table).findByText('meera.teller@banksphere.local')).toBeInTheDocument();
    expect(within(table).getAllByText('₹50,000.00')).toHaveLength(2);
    expect(seen[0]).toEqual({ status: null, offset: '0', limit: '20' });
  });

  it('filters by status, with closed sessions shown as awaiting sign-off', async () => {
    directory();
    const seen = sessions((status) => (status === 'CLOSED' ? [aTellerSession({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' })] : []));
    const { user } = renderPage();
    await screen.findByText('No teller sessions yet');
    await user.click(screen.getByRole('tab', { name: 'Awaiting sign-off' }));
    const table = await screen.findByRole('table', { name: 'Teller sessions' });
    expect(await within(table).findByText('Awaiting sign-off')).toBeInTheDocument();
    expect(seen.at(-1)?.status).toBe('CLOSED');
  });

  it('pages through sessions', async () => {
    directory();
    const seen = sessions((_, offset) => (offset === '0' ? Array.from({ length: 20 }, (_, i) => aTellerSession({ id: `s${i}` })) : []));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /next/i }));
    await waitFor(() => expect(seen.at(-1)?.offset).toBe('20'));
  });

  it('shows the reconciliation result with sign, colour-independent text and who signed off', async () => {
    directory();
    sessions(() => [
      reconciled(),
      reconciled({ id: 'sess-o', tellerId: TELLER_2, discrepancy: '15000', expectedClosing: '7285000' }),
      reconciled({ id: 'sess-b', discrepancy: '0', expectedClosing: '7300000', signedOffBy: IDS.admin2 }),
    ]);
    renderPage();
    const table = await screen.findByRole('table', { name: 'Teller sessions' });
    expect(await within(table).findByText('Short by ₹200.00')).toBeInTheDocument();
    // The words carry the sign; the figure isn't repeated with one
    expect(within(table).queryByText('-₹200.00')).not.toBeInTheDocument();
    expect(within(table).getByText('Over by ₹150.00')).toBeInTheDocument();
    expect(within(table).getByText('Balanced')).toBeInTheDocument();
    expect(within(table).getAllByText(/declared ₹73,000\.00/i)).toHaveLength(3);
    expect(within(table).getByText(/expected ₹73,200\.00/i)).toBeInTheDocument();
    expect(await within(table).findAllByText(/signed off by priya\.admin@banksphere\.local/i)).toHaveLength(2);
    expect(within(table).getByText(/signed off by you/i)).toBeInTheDocument();
  });

  it('never shows declared or expected cash before sign-off', async () => {
    directory();
    sessions(() => [aTellerSession({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z', declaredClosing: '7300000', expectedClosing: '7320000' })]);
    renderPage();
    await screen.findByText('Awaiting sign-off', { selector: 'td *' });
    expect(screen.queryByText(/73,000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/73,200/)).not.toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    directory();
    sessions(() => []);
    renderPage();
    expect(await screen.findByText('No teller sessions yet')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    directory();
    let calls = 0;
    sessions(() => (++calls === 1 ? fail(500, 'INTERNAL_SERVER_ERROR') : [aTellerSession()]));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('table', { name: 'Teller sessions' })).toBeInTheDocument();
  });

  it('still lists sessions when the staff directory is unavailable', async () => {
    directory({ fails: true });
    sessions(() => [aTellerSession()]);
    renderPage();
    const table = await screen.findByRole('table', { name: 'Teller sessions' });
    expect(await within(table).findByText('33333333…')).toBeInTheDocument();
  });

  it('is read-only for support staff', async () => {
    directory();
    sessions(() => [aTellerSession({ status: 'ISSUED', acceptedAt: null }), aTellerSession({ id: 's2', status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' })]);
    renderPage('SUPPORT');
    await screen.findByText('Awaiting sign-off', { selector: 'td *' });
    expect(screen.queryByRole('button', { name: /issue opening float/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel float/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /count and sign off/i })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });
});

describe('TellerSessionsPage — issue a float', () => {
  it('issues a float to an active teller', async () => {
    directory();
    let body: unknown;
    let listCalls = 0;
    sessions(() => {
      listCalls += 1;
      return [];
    });
    server.use(
      http.post(apiUrl('/transactions/teller/sessions'), async ({ request }) => {
        body = await request.json();
        return ok(aTellerSession({ status: 'ISSUED', tellerId: TELLER_2 }), 201);
      })
    );
    const { user } = renderPage();
    await screen.findByText('No teller sessions yet');
    await user.click(screen.getByRole('button', { name: 'Issue opening float' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('Teller');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'ravi.teller@banksphere.local' })).toBeInTheDocument());
    expect(within(select).queryByRole('option', { name: 'gone.teller@banksphere.local' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Issue float' }));
    expect(await within(dialog).findByText('Choose a teller')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter an amount')).toBeInTheDocument();

    await user.selectOptions(select, TELLER_2);
    await user.type(within(dialog).getByLabelText('Opening float'), '50,000');
    await user.click(within(dialog).getByRole('button', { name: 'Issue float' }));
    await waitFor(() => expect(body).toEqual({ tellerId: TELLER_2, openingFloatPaise: '5000000' }));
    expect(await screen.findByText('Float issued')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
  });

  it('explains why a float could not be issued', async () => {
    directory();
    sessions(() => []);
    server.use(
      http.post(apiUrl('/transactions/teller/sessions'), () => fail(409, 'CONFLICT', 'A session for 2026-10-27 already exists (OPEN)'))
    );
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Issue opening float' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('Teller');
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
    await user.selectOptions(select, IDS.teller);
    await user.type(within(dialog).getByLabelText('Opening float'), '50,000');
    await user.click(within(dialog).getByRole('button', { name: 'Issue float' }));
    expect(await within(dialog).findByText('Float not issued')).toBeInTheDocument();
    expect(within(dialog).getByText(/already exists \(OPEN\)/)).toBeInTheDocument();
  });

  it('cannot issue a float when the teller list fails to load', async () => {
    directory({ fails: true });
    sessions(() => []);
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Issue opening float' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/couldn.t load the list of tellers/i)).toBeInTheDocument();
  });
});

describe('TellerSessionsPage — cancel and sign off', () => {
  it('cancels an unaccepted float after confirmation', async () => {
    directory();
    let cancelled = false;
    sessions(() => [aTellerSession({ status: cancelled ? 'CANCELLED' : 'ISSUED', acceptedAt: null })]);
    server.use(
      http.post(apiUrl('/transactions/teller/sessions/sess-1/cancel'), () => {
        cancelled = true;
        return ok({ id: 'sess-1', status: 'CANCELLED' });
      })
    );
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /cancel float/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel float' }));
    expect(await screen.findByText('Float cancelled')).toBeInTheDocument();
    expect(await screen.findByText('Cancelled', { selector: 'td *' })).toBeInTheDocument();
  });

  it('refreshes and explains when the float was already accepted', async () => {
    directory();
    sessions(() => [aTellerSession({ status: 'ISSUED', acceptedAt: null })]);
    server.use(
      http.post(apiUrl('/transactions/teller/sessions/sess-1/cancel'), () =>
        fail(409, 'CONFLICT', 'Only an issued, unaccepted float can be cancelled')
      )
    );
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /cancel float/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel float' }));
    expect(await screen.findByText(/only an issued, unaccepted float can be cancelled/i)).toBeInTheDocument();
  });

  it('signs off with a blind count after a review step', async () => {
    directory();
    let body: unknown;
    let done = false;
    sessions(() => [done ? reconciled({ id: 'sess-1' }) : aTellerSession({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z', declaredClosing: '7300000' })]);
    server.use(
      http.post(apiUrl('/transactions/teller/sessions/sess-1/sign-off'), async ({ request }) => {
        body = await request.json();
        done = true;
        return ok(reconciled({ id: 'sess-1' }));
      })
    );
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /count and sign off/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/73,000/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('Enter an amount')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Cash counted'), '73,000');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('You counted')).toBeInTheDocument();
    expect(within(dialog).getByText('₹73,000.00')).toBeInTheDocument();
    expect(within(dialog).getByText(/can.t be undone/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Sign off' }));
    await waitFor(() => expect(body).toEqual({ countedCashPaise: '7300000' }));
    expect(await screen.findByText('Session signed off')).toBeInTheDocument();
    expect(await screen.findByText('Short by ₹200.00', { selector: 'table *' })).toBeInTheDocument();
  });

  it('explains a count mismatch and the two-supervisor dispute path', async () => {
    directory();
    sessions(() => [aTellerSession({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' })]);
    server.use(http.post(apiUrl('/transactions/teller/sessions/sess-1/sign-off'), () => fail(409, 'COUNT_MISMATCH', 'mismatch')));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /count and sign off/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Cash counted'), '72,000');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Sign off' }));
    expect(await within(dialog).findByText(/your count doesn.t match the teller.s/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/second administrator/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/two supervisor counts match/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Cash counted')).toHaveValue('');
  });

  it('flags a disputed count and tells a second administrator how it can be settled, without revealing it', async () => {
    directory();
    sessions(() => [
      { ...aTellerSession({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' }), disputedBy: IDS.admin, disputedAt: '2026-10-27T12:20:00.000Z', disputedCount: '7200000' } as TellerSession,
    ]);
    const { user } = renderPage();
    expect(await screen.findByText(/disputed by priya\.admin@banksphere\.local/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /count and sign off/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/priya\.admin@banksphere\.local counted this drawer and disagreed with the teller/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/if your count matches theirs/i)).toBeInTheDocument();
    expect(screen.queryByText(/72,000/)).not.toBeInTheDocument();
  });

  it('tells the administrator who disputed the count that someone else must count', async () => {
    directory();
    sessions(() => [{ ...aTellerSession({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' }), disputedBy: IDS.admin2 } as TellerSession]);
    const { user } = renderPage();
    expect(await screen.findByText(/disputed by you/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /count and sign off/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/you already counted this drawer/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/a different administrator must count it independently/i)).toBeInTheDocument();
  });

  it('shows when two administrators’ counts settled a session', async () => {
    directory();
    sessions(() => [
      { ...reconciled({ discrepancy: '-100000' }), disputedBy: IDS.admin, disputedCount: '7220000' } as TellerSession,
    ]);
    renderPage();
    expect(await screen.findByText(/settled by two administrators’ matching counts/i)).toBeInTheDocument();
  });

  it('refreshes the list after a count mismatch so the dispute shows', async () => {
    directory();
    let calls = 0;
    sessions(() => {
      calls += 1;
      return [aTellerSession({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' })];
    });
    server.use(http.post(apiUrl('/transactions/teller/sessions/sess-1/sign-off'), () => fail(409, 'COUNT_MISMATCH', 'mismatch')));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /count and sign off/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Cash counted'), '72,000');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Sign off' }));
    expect(await within(dialog).findByText(/your count has been recorded/i)).toBeInTheDocument();
    await waitFor(() => expect(calls).toBeGreaterThan(1));
  });

  it('explains when you may not sign off this session', async () => {
    directory();
    sessions(() => [aTellerSession({ status: 'CLOSED', closedAt: '2026-10-27T12:00:00.000Z' })]);
    server.use(http.post(apiUrl('/transactions/teller/sessions/sess-1/sign-off'), () => fail(403, 'FORBIDDEN', 'forbidden')));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: /count and sign off/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Cash counted'), '72,000');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Sign off' }));
    expect(await within(dialog).findByText(/a different administrator must/i)).toBeInTheDocument();
  });
});
