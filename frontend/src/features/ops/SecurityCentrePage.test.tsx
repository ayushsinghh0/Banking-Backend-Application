import { delay, http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS } from '@/test/fixtures';
import { asStaff, resetToasts } from '@/features/staff/testing';
import { directoryLookupHandler } from '@/features/admin/testData';
import type { IpBan, IpRule } from './api';
import { aBan, anIpRule, aSecurityEvent, bansHandler, cursorPage, eventsHandler, ipRulesHandler } from './test/handlers';
import SecurityCentrePage from './SecurityCentrePage';

afterEach(resetToasts);
// Who added a rule, whom an event is about: resolved through the staff directory
beforeEach(() => server.use(directoryLookupHandler()));

const render = (role: 'BANK_ADMIN' | 'SUPPORT' = 'BANK_ADMIN', route = '/security-centre') =>
  renderWithApp(<SecurityCentrePage />, { ...asStaff(role), route, path: '/security-centre' });

const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr') as HTMLElement;

describe('SecurityCentrePage — IP rules', () => {
  it('lists the deny rules with why and for how long', async () => {
    server.use(ipRulesHandler([anIpRule(), anIpRule({ id: 'rule-2', cidr: '2001:db8:1::/48', reason: 'Scanner', expiresAt: '2999-01-01T00:00:00.000Z' })]));
    render();
    expect(screen.getByRole('heading', { level: 1, name: 'Security centre' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'IP rules' })).toHaveAttribute('aria-selected', 'true');
    const first = await rowOf('203.0.113.0/24');
    expect(within(first).getAllByText('Card-testing traffic from this range').length).toBeGreaterThan(0);
    expect(within(first).getAllByText('Never').length).toBeGreaterThan(0);
    expect(await within(first).findByText('rahul.admin@banksphere.local')).toBeInTheDocument();
    const second = await rowOf('2001:db8:1::/48');
    expect(within(second).getAllByText(/^in /).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeInTheDocument();
  });

  it('says when there are no rules', async () => {
    server.use(ipRulesHandler([]));
    render();
    expect(await screen.findByText('No IP rules')).toBeInTheDocument();
  });

  it('shows a list error with a working retry', async () => {
    let attempt = 0;
    server.use(ipRulesHandler(() => (attempt++ === 0 ? fail(503, 'SERVICE_UNAVAILABLE') : ok([anIpRule()]))));
    const { user } = render();
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('203.0.113.0/24')).toBeInTheDocument();
  });

  it('checks a new rule, adds it and refreshes the list', async () => {
    const rules: IpRule[] = [];
    let body: unknown;
    server.use(
      ipRulesHandler(() => ok(rules)),
      http.post(apiUrl('/auth/admin/ip-rules'), async ({ request }) => {
        body = await request.json();
        rules.push(anIpRule({ id: 'rule-new', cidr: '198.51.100.0/24', reason: 'Bot traffic from a hosting range' }));
        return ok(rules[0], 201);
      })
    );
    const { user } = render();
    await screen.findByText('No IP rules');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an IP rule' });

    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(await within(dialog).findByText(/enter an address or range/i)).toBeInTheDocument();
    expect(within(dialog).getByText('Say why, in a few words')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Address or range'), '10.0.0.0/7');
    await user.type(within(dialog).getByLabelText('Reason'), 'Bot traffic from a hosting range');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(await within(dialog).findByText('IPv4 ranges wider than /8 aren’t allowed')).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText('Address or range'));
    await user.type(within(dialog).getByLabelText('Address or range'), '198.51.100.0/24');
    await user.selectOptions(within(dialog).getByLabelText('Expires'), '24 hours');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByText('Rule added')).toBeInTheDocument();
    expect(body).toEqual({ cidr: '198.51.100.0/24', reason: 'Bot traffic from a hosting range', expiresInMinutes: 1440 });
    expect(await screen.findByText('198.51.100.0/24')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('leaves out the expiry for a rule that lasts until removed', async () => {
    let body: unknown;
    server.use(
      ipRulesHandler([]),
      http.post(apiUrl('/auth/admin/ip-rules'), async ({ request }) => {
        body = await request.json();
        return ok(anIpRule(), 201);
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an IP rule' });
    await user.type(within(dialog).getByLabelText('Address or range'), '203.0.113.9');
    await user.type(within(dialog).getByLabelText('Reason'), 'Repeated card testing');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await screen.findByText('Rule added');
    expect(body).toEqual({ cidr: '203.0.113.9/32', reason: 'Repeated card testing' });
  });

  it('shows the server’s reason when it refuses a rule, and keeps the dialog open', async () => {
    server.use(
      ipRulesHandler([]),
      http.post(apiUrl('/auth/admin/ip-rules'), () =>
        fail(409, 'IP_RULE_OVERLAPS_STAFF_NETWORK', 'This range overlaps the staff network 10.20.0.0/16')
      )
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an IP rule' });
    await user.type(within(dialog).getByLabelText('Address or range'), '10.20.0.0/16');
    await user.type(within(dialog).getByLabelText('Reason'), 'Testing an overlap');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Overlaps a staff network');
    expect(alert).toHaveTextContent('This range overlaps the staff network 10.20.0.0/16');
    expect(screen.getByRole('dialog', { name: 'Add an IP rule' })).toBeInTheDocument();
  });

  it('puts field errors from the server next to the field', async () => {
    server.use(
      ipRulesHandler([]),
      http.post(apiUrl('/auth/admin/ip-rules'), () =>
        fail(400, 'VALIDATION_ERROR', 'Validation failed', { details: [{ field: 'cidr', message: 'Matches your own address' }] })
      )
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an IP rule' });
    await user.type(within(dialog).getByLabelText('Address or range'), '192.0.2.10');
    await user.type(within(dialog).getByLabelText('Reason'), 'Testing my own address');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(await within(dialog).findByText('Matches your own address')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Address or range')).toHaveAttribute('aria-invalid', 'true');
  });

  it('removes a rule after confirming', async () => {
    let rules = [anIpRule()];
    let removed = '';
    server.use(
      ipRulesHandler(() => ok(rules)),
      http.delete(apiUrl('/auth/admin/ip-rules/:id'), ({ params }) => {
        removed = String(params.id);
        rules = [];
        return new HttpResponse(null, { status: 204 });
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Remove rule for 203.0.113.0/24' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove the rule for 203.0.113.0/24?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove rule' }));
    expect(await screen.findByText('Rule removed')).toBeInTheDocument();
    expect(removed).toBe('rule-1');
    expect(await screen.findByText('No IP rules')).toBeInTheDocument();
  });

  it('keeps the confirmation open when removal fails for a moment', async () => {
    server.use(
      ipRulesHandler([anIpRule()]),
      http.delete(apiUrl('/auth/admin/ip-rules/:id'), () => fail(503, 'SERVICE_BUSY'))
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Remove rule for 203.0.113.0/24' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Remove rule' }));
    expect(await screen.findByText('Busy right now')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('is read-only for support', async () => {
    server.use(ipRulesHandler([anIpRule()]));
    render('SUPPORT');
    await screen.findByText('203.0.113.0/24');
    expect(screen.getByText(/bank administrators add and remove rules/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove rule/i })).not.toBeInTheDocument();
  });
});

describe('SecurityCentrePage — automatic bans', () => {
  it('lists bans with the address masked as the API sends it, and lifts one', async () => {
    let bans: IpBan[] = [aBan()];
    let lifted = '';
    server.use(
      ipRulesHandler([]),
      bansHandler(() => ok(bans)),
      http.delete(apiUrl('/auth/admin/ip-bans/:key'), ({ request }) => {
        lifted = new URL(request.url).pathname;
        bans = [];
        return new HttpResponse(null, { status: 204 });
      })
    );
    const { user } = render('BANK_ADMIN', '/security-centre?tab=bans');
    const row = await rowOf('198.51.100.x');
    expect(within(row).getAllByText('Credential stuffing: 24 accounts in 10 minutes').length).toBeGreaterThan(0);
    await user.click(within(row).getByRole('button', { name: 'Lift ban on 198.51.100.x' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Lift the ban on 198.51.100.x?' });
    await user.click(within(confirm).getByRole('button', { name: 'Lift ban' }));
    expect(await screen.findByText('Ban lifted')).toBeInTheDocument();
    expect(lifted).toBe('/api/v1/auth/admin/ip-bans/ip4%3A198.51.100.23');
    expect(await screen.findByText('No automatic bans')).toBeInTheDocument();
  });

  it('treats a ban that already expired as lifted', async () => {
    server.use(
      bansHandler([aBan()]),
      http.delete(apiUrl('/auth/admin/ip-bans/:key'), () => fail(404, 'NOT_FOUND', 'No such ban'))
    );
    const { user } = render('BANK_ADMIN', '/security-centre?tab=bans');
    await user.click(await screen.findByRole('button', { name: 'Lift ban on 198.51.100.x' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Lift ban' }));
    expect(await screen.findByText('Ban already lifted')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('switches tabs and keeps the choice in the address', async () => {
    server.use(ipRulesHandler([]), bansHandler([]));
    const { user } = render('SUPPORT');
    await screen.findByText('No IP rules');
    await user.click(screen.getByRole('tab', { name: 'Automatic bans' }));
    expect(await screen.findByText('No automatic bans')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /lift ban/i })).not.toBeInTheDocument();
  });
});

describe('SecurityCentrePage — security events', () => {
  it('lists events in words, filters them and pages with the cursor', async () => {
    const calls: Array<Record<string, string>> = [];
    server.use(
      eventsHandler((query) => {
        if (query.cursor === 'e2') return cursorPage([aSecurityEvent({ id: 'evt-9', type: 'PASSWORD_CHANGED' })]);
        if (query.type === 'IP_AUTO_BANNED') return cursorPage([]);
        return cursorPage(
          [
            aSecurityEvent({ details: { reason: 'Wrong password' } }),
            aSecurityEvent({ id: 'evt-2', type: 'NEW_DEVICE', userId: IDS.admin2 }),
          ],
          'e2'
        );
      }, calls)
    );
    const { user } = render('SUPPORT', '/security-centre?tab=events');
    // Event names also appear in the type filter's options: look in the table
    const table = await screen.findByRole('table', { name: 'Security events' });
    const failed = (await within(table).findByText('Sign-in failed')).closest('tr') as HTMLElement;
    expect(within(failed).getAllByText(/198\.51\.100\.x/).length).toBeGreaterThan(0);
    expect(within(failed).getAllByText(/Safari on iPhone/).length).toBeGreaterThan(0);
    expect(within(failed).getByText(/Wrong password/)).toBeInTheDocument();
    expect(within(table).getByText('Signed in on a new device')).toBeInTheDocument();
    expect((await within(table).findAllByText('rahul.admin@banksphere.local')).length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ limit: '25' });

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await within(screen.getByRole('table', { name: 'Security events' })).findByText('Password changed')).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ limit: '25', cursor: 'e2' });

    await user.selectOptions(screen.getByLabelText('Event type'), 'IP_AUTO_BANNED');
    expect(await screen.findByText('No events match these filters')).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ type: 'IP_AUTO_BANNED', limit: '25' });

    await user.type(screen.getByLabelText('User ID'), 'abc');
    expect(await screen.findByText('Enter the full user ID')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('User ID'));
    await user.type(screen.getByLabelText('User ID'), IDS.customer);
    await waitFor(() => expect(calls.at(-1)).toEqual({ type: 'IP_AUTO_BANNED', userId: IDS.customer, limit: '25' }));

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ limit: '25' }));
    expect(screen.getByLabelText('User ID')).toHaveValue('');
  });

  it('says when nothing has been recorded', async () => {
    server.use(eventsHandler(() => cursorPage([])));
    render('BANK_ADMIN', '/security-centre?tab=events');
    expect(await screen.findByText('No security events')).toBeInTheDocument();
  });

  it('announces loading', async () => {
    server.use(
      eventsHandler(async () => {
        await delay('infinite');
        return cursorPage([]);
      })
    );
    render('BANK_ADMIN', '/security-centre?tab=events');
    expect(await screen.findByText('Loading security events…')).toBeInTheDocument();
  });
});
