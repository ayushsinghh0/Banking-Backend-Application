import { delay, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { anAccount, anAlert, anAlertEvent, IDS } from '@/test/fixtures';
import type { FraudAlert, FraudAlertEvent } from '@/lib/api/types';
import { STAFF, asStaff, queryOf, resetToasts } from './testing';
import FraudAlertDetailPage from './FraudAlertDetailPage';
import FraudAlertsPage from './FraudAlertsPage';

afterEach(resetToasts);

const ALERT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ROUTE = `/fraud/${ALERT_ID}`;
const PATH = '/fraud/:alertId';

const target = (o: Partial<FraudAlert> = {}) =>
  anAlert({ id: ALERT_ID, reason: '[OUTBOUND] Amount ₹2,50,000.00 exceeds the high-value threshold', ...o });

interface Setup {
  alert?: FraudAlert;
  list?: (query: Record<string, string>) => Response | Promise<Response>;
  history?: FraudAlertEvent[];
}

function setup({ alert = target(), list, history = [] }: Setup = {}) {
  const scans: Array<Record<string, string>> = [];
  let current = alert;
  const patches: unknown[] = [];
  server.use(
    http.get(apiUrl('/fraud/alerts'), ({ request }) => {
      const query = queryOf(request);
      scans.push(query);
      if (list) return list(query);
      return ok([anAlert({ id: 'other-alert' }), current]);
    }),
    http.get(apiUrl('/fraud/alerts/:alertId/history'), () => ok(history)),
    http.get(apiUrl('/accounts/:accountId'), () => ok(anAccount()))
  );
  const respondWith = (handler: (body: { status: string; note?: string }) => Response | FraudAlert) =>
    server.use(
      http.patch(apiUrl('/fraud/alerts/:alertId'), async ({ request }) => {
        const body = (await request.json()) as { status: string; note?: string };
        patches.push(body);
        const result = handler(body);
        if (result instanceof Response) return result;
        current = result;
        return ok(result);
      })
    );
  return { scans, patches, respondWith };
}

const render = (role: Parameters<typeof asStaff>[0], sub?: string) =>
  renderWithApp(<FraudAlertDetailPage />, { ...asStaff(role, sub), route: ROUTE, path: PATH });

describe('FraudAlertDetailPage — finding the alert', () => {
  it('finds the alert by scanning the alert list and shows its details', async () => {
    const { scans } = setup({ alert: target({ cashOperationId: null }) });
    render('SUPPORT');
    expect(await screen.findByRole('heading', { level: 1, name: 'High-severity alert' })).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'Alert details' });
    expect(within(details).getByText('Amount ₹2,50,000.00 exceeds the high-value threshold')).toBeInTheDocument();
    expect(within(details).getByText('Outgoing')).toBeInTheDocument();
    expect(within(details).getByText('txn-9')).toBeInTheDocument();
    expect(within(details).getByText('Open')).toBeInTheDocument();
    expect(await within(details).findByText('1001 2345 6789')).toBeInTheDocument();
    expect(within(details).getByRole('link', { name: /view customer/i })).toHaveAttribute('href', `/customers/${IDS.customer}`);
    expect(within(details).getByText('Account holder')).toBeInTheDocument();
    expect(scans[0]).toEqual({ limit: '100', offset: '0' });
  });

  it('opens straight from the list and checks the alert’s current status first', async () => {
    const { scans } = setup({ list: () => ok([target()]) });
    const { user } = renderWithApp(<FraudAlertsPage />, {
      ...asStaff('FRAUD_ANALYST'),
      route: '/fraud',
      routes: [{ path: PATH, element: <FraudAlertDetailPage /> }],
    });
    await user.click(await screen.findByRole('button', { name: /open alert: amount/i }));
    expect(await screen.findByRole('heading', { level: 1, name: 'High-severity alert' })).toBeInTheDocument();
    await waitFor(() => expect(scans.at(-1)).toEqual({ status: 'OPEN', limit: '100', offset: '0' }));
    expect(screen.getByRole('link', { name: /fraud alerts/i })).toHaveAttribute('href', '/fraud');
  });

  it('stops searching after a bounded number of pages', async () => {
    const { scans } = setup({
      list: (query) => ok(Array.from({ length: 100 }, (_, i) => anAlert({ id: `x-${query.offset}-${i}` }))),
    });
    render('FRAUD_ANALYST');
    expect(await screen.findByRole('heading', { name: 'Alert not found' })).toBeInTheDocument();
    expect(scans).toHaveLength(5);
    expect(scans.map((s) => s.offset)).toEqual(['0', '100', '200', '300', '400']);
  });

  it('reports a missing alert after reaching the end of the list', async () => {
    const { scans } = setup({ list: () => ok([anAlert({ id: 'someone-else' })]) });
    render('FRAUD_ANALYST');
    expect(await screen.findByRole('heading', { name: 'Alert not found' })).toBeInTheDocument();
    expect(scans).toHaveLength(1);
    expect(screen.getByRole('link', { name: /back to fraud alerts/i })).toHaveAttribute('href', '/fraud');
  });

  it('treats a malformed id as not found without calling the API', async () => {
    const { scans } = setup();
    renderWithApp(<FraudAlertDetailPage />, { ...asStaff('FRAUD_ANALYST'), route: '/fraud/not-an-id', path: PATH });
    expect(await screen.findByRole('heading', { name: 'Alert not found' })).toBeInTheDocument();
    expect(scans).toHaveLength(0);
  });

  it('announces loading', async () => {
    setup({
      list: async () => {
        await delay('infinite');
        return ok([]);
      },
    });
    render('FRAUD_ANALYST');
    expect(await screen.findByText('Loading alert…')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let attempt = 0;
    setup({ list: () => (attempt++ === 0 ? fail(504, 'GATEWAY_TIMEOUT') : ok([target()])) });
    const { user } = render('FRAUD_ANALYST');
    expect(await screen.findByText('Service did not respond in time')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { level: 1, name: 'High-severity alert' })).toBeInTheDocument();
  });

  it('shows the alert history oldest first, with notes as plain text', async () => {
    setup({
      history: [
        anAlertEvent({ id: 'h1', actorId: STAFF.analyst2, fromStatus: 'OPEN', toStatus: 'UNDER_REVIEW', note: null }),
        anAlertEvent({
          id: 'h2',
          actorId: STAFF.analyst,
          fromStatus: 'UNDER_REVIEW',
          toStatus: 'UNDER_REVIEW',
          note: 'Proposed RESOLVED: Customer confirmed <b>by phone</b>',
        }),
      ],
    });
    render('FRAUD_ANALYST');
    const history = await screen.findByRole('list', { name: 'Alert history' });
    const items = await within(history).findAllByRole('listitem');
    expect(within(items[0]!).getByText('Open → Under review')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/analyst 78787878/i)).toBeInTheDocument();
    expect(within(items[1]!).getByText('Proposed Resolved')).toBeInTheDocument();
    expect(within(items[1]!).getByText(/by you/i)).toBeInTheDocument();
    expect(within(items[1]!).getByText('Customer confirmed <b>by phone</b>')).toBeInTheDocument();
    expect(history.querySelector('b')).toBeNull();
  });
});

describe('FraudAlertDetailPage — four-eyes review', () => {
  it('shows who proposed closing a severe alert', async () => {
    setup({ alert: target({ status: 'UNDER_REVIEW', closeRequestedBy: STAFF.analyst2, closeRequestedStatus: 'RESOLVED' }) });
    render('SUPPORT');
    expect(await screen.findByText('Analyst 78787878 proposed Resolved — a second analyst must confirm')).toBeInTheDocument();
  });

  it('lets an analyst start the review', async () => {
    const { patches, respondWith } = setup();
    respondWith(() => target({ status: 'UNDER_REVIEW', reviewedBy: STAFF.analyst }));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Start review' }));
    expect(await screen.findByText('Review started')).toBeInTheDocument();
    expect(patches).toEqual([{ status: 'UNDER_REVIEW' }]);
    expect(within(screen.getByRole('region', { name: 'Alert details' })).getByText('Under review')).toBeInTheDocument();
  });

  it('requires a note to close, and records the first close of a severe alert as a proposal', async () => {
    const { patches, respondWith } = setup({ alert: target({ status: 'UNDER_REVIEW' }) });
    respondWith((body) => target({ status: 'UNDER_REVIEW', closeRequestedBy: STAFF.analyst, closeRequestedStatus: body.status as 'RESOLVED' }));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Propose resolving this alert' });
    expect(within(dialog).getByText(/a different analyst must confirm it before the alert closes/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Propose resolution' }));
    expect(await within(dialog).findByText('Add a note explaining your decision')).toBeInTheDocument();
    const note = within(dialog).getByLabelText('Note');
    await user.click(note);
    await user.paste('x'.repeat(1001));
    expect(await within(dialog).findByText('Keep the note to 1,000 characters or fewer')).toBeInTheDocument();
    await user.clear(note);
    await user.type(note, 'Customer confirmed the payment by phone');
    await user.click(within(dialog).getByRole('button', { name: 'Propose resolution' }));
    expect(await screen.findByText('Proposal recorded')).toBeInTheDocument();
    expect(patches).toEqual([{ status: 'RESOLVED', note: 'Customer confirmed the payment by phone' }]);
    expect(await screen.findByText('You proposed Resolved — a second analyst must confirm')).toBeInTheDocument();
  });

  it('closes low-severity alerts straight away', async () => {
    const { patches, respondWith } = setup({ alert: target({ severity: 'LOW', status: 'UNDER_REVIEW' }) });
    respondWith(() => target({ severity: 'LOW', status: 'DISMISSED' }));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss alert' });
    expect(within(dialog).getByText(/closes straight away/i)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Note'), 'Known payroll run');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss alert' }));
    expect(await screen.findByText('Alert dismissed')).toBeInTheDocument();
    expect(patches).toEqual([{ status: 'DISMISSED', note: 'Known payroll run' }]);
  });

  it('lets a second analyst confirm the proposal', async () => {
    const { patches, respondWith } = setup({
      alert: target({ status: 'UNDER_REVIEW', closeRequestedBy: STAFF.analyst2, closeRequestedStatus: 'RESOLVED' }),
    });
    respondWith(() => target({ status: 'RESOLVED', reviewedBy: STAFF.analyst }));
    const { user } = render('FRAUD_ANALYST');
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Confirm resolution' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm resolution' });
    await user.type(within(dialog).getByLabelText('Note'), 'Agree: verified with the customer');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm resolution' }));
    expect(await screen.findByText('Alert resolved')).toBeInTheDocument();
    expect(patches).toEqual([{ status: 'RESOLVED', note: 'Agree: verified with the customer' }]);
    expect(screen.queryByText(/a second analyst must confirm/i)).not.toBeInTheDocument();
  });

  it('lets a second analyst reject the proposal', async () => {
    const { patches, respondWith } = setup({
      alert: target({ status: 'UNDER_REVIEW', closeRequestedBy: STAFF.analyst2, closeRequestedStatus: 'DISMISSED' }),
    });
    respondWith(() => target({ status: 'UNDER_REVIEW' }));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Reject proposal' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reject proposal' }));
    expect(await screen.findByText('Proposal rejected')).toBeInTheDocument();
    expect(patches).toEqual([{ status: 'UNDER_REVIEW' }]);
  });

  it('never lets the proposer confirm their own proposal', async () => {
    const { patches, respondWith } = setup({
      alert: target({ status: 'UNDER_REVIEW', closeRequestedBy: STAFF.analyst, closeRequestedStatus: 'RESOLVED' }),
    });
    respondWith(() => target({ status: 'UNDER_REVIEW' }));
    const { user } = render('FRAUD_ANALYST');
    expect(await screen.findByText(/another analyst must confirm it before the alert closes/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm resolution' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Withdraw proposal' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Withdraw proposal' }));
    expect(await screen.findByText('Proposal withdrawn')).toBeInTheDocument();
    expect(patches).toEqual([{ status: 'UNDER_REVIEW' }]);
  });

  it('never lets the person who initiated the transaction triage it', async () => {
    setup({ alert: target({ initiatedBy: STAFF.analyst }) });
    render('FRAUD_ANALYST');
    expect(await screen.findByText('You can’t triage this alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  it('explains a refusal from the server', async () => {
    const { respondWith } = setup();
    respondWith(() => fail(403, 'FORBIDDEN', 'You cannot triage an alert about a transaction you initiated'));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Start review' }));
    expect(await screen.findByText('You can’t make this change')).toBeInTheDocument();
  });

  it('explains when a proposal has to be confirmed by someone else', async () => {
    const { respondWith } = setup({ alert: target({ status: 'UNDER_REVIEW' }) });
    respondWith(() => fail(409, 'CONFLICT', 'Closing this alert needs confirmation by a different analyst'));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Note'), 'False positive');
    await user.click(within(dialog).getByRole('button', { name: 'Propose dismissal' }));
    expect(await screen.findByText('A different analyst must confirm this')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the note when a transient failure happens', async () => {
    const { respondWith } = setup({ alert: target({ status: 'UNDER_REVIEW' }) });
    respondWith(() => fail(503, 'SERVICE_UNAVAILABLE'));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Note'), 'Checked');
    await user.click(within(dialog).getByRole('button', { name: 'Propose resolution' }));
    expect(await within(dialog).findByText('Temporarily unavailable')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Note')).toHaveValue('Checked');
  });

  it('says so when a proposal turned out to confirm another analyst’s', async () => {
    const { respondWith } = setup({ alert: target({ status: 'UNDER_REVIEW' }) });
    respondWith(() => target({ status: 'RESOLVED' }));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Note'), 'Checked');
    await user.click(within(dialog).getByRole('button', { name: 'Propose resolution' }));
    expect(await screen.findByText('Alert resolved')).toBeInTheDocument();
    expect(screen.getByText(/another analyst had already proposed this/i)).toBeInTheDocument();
  });

  it('reopens a closed alert', async () => {
    const { patches, respondWith } = setup({ alert: target({ status: 'DISMISSED' }) });
    respondWith(() => target({ status: 'UNDER_REVIEW' }));
    const { user } = render('FRAUD_ANALYST');
    await user.click(await screen.findByRole('button', { name: 'Reopen for review' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reopen for review' }));
    expect(await screen.findByText('Alert reopened')).toBeInTheDocument();
    expect(patches).toEqual([{ status: 'UNDER_REVIEW' }]);
  });

  it.each(['SUPPORT', 'BANK_ADMIN'] as const)('gives %s no triage controls', async (role) => {
    setup();
    render(role);
    expect(await screen.findByText(/only fraud analysts can triage alerts/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });
});
