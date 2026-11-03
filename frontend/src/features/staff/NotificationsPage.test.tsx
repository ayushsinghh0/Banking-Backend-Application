import { delay, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aNotificationLog } from '@/test/fixtures';
import { asStaff, queryOf, resetToasts } from './testing';
import NotificationsPage from './NotificationsPage';

afterEach(resetToasts);

function logsHandler(respond: (query: Record<string, string>) => Response | Promise<Response>) {
  const calls: Array<Record<string, string>> = [];
  server.use(
    http.get(apiUrl('/notifications/logs'), ({ request }) => {
      const query = queryOf(request);
      calls.push(query);
      return respond(query);
    })
  );
  return calls;
}

const many = (n: number) => Array.from({ length: n }, (_, i) => aNotificationLog({ id: `log-${i}`, subject: `Message ${i}` }));

describe('NotificationsPage', () => {
  it('lists notifications newest first', async () => {
    const calls = logsHandler(() => ok([aNotificationLog({ retryCount: 2 })]));
    renderWithApp(<NotificationsPage />, { ...asStaff('SUPPORT'), route: '/notifications' });
    expect(screen.getByRole('heading', { name: 'Notification log' })).toBeInTheDocument();
    const toggle = await screen.findByRole('button', { name: 'Show details: Your account was debited' });
    const row = toggle.closest('tr') as HTMLElement;
    // Once in the desktop column and once under the subject on small screens (CSS shows one of them)
    expect(within(row).getAllByText('asha@example.in')).toHaveLength(2);
    expect(within(row).getByText('Sent')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(calls).toEqual([{ limit: '20', offset: '0' }]);
  });

  it('expands a row to show the message as plain text', async () => {
    logsHandler(() => ok([aNotificationLog({ body: 'Hello <b>Asha</b>\n<script>alert(1)</script>' })]));
    const { user } = renderWithApp(<NotificationsPage />, { ...asStaff('BANK_ADMIN'), route: '/notifications' });
    const toggle = await screen.findByRole('button', { name: 'Show details: Your account was debited' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('region', { name: 'Details: Your account was debited' });
    expect(within(details).getByText(/Hello <b>Asha<\/b>/)).toBeInTheDocument();
    expect(details.querySelector('b')).toBeNull();
    expect(details.querySelector('script')).toBeNull();
    await user.click(toggle);
    expect(screen.queryByRole('region', { name: 'Details: Your account was debited' })).not.toBeInTheDocument();
  });

  it('shows why a message failed', async () => {
    logsHandler(() =>
      ok([aNotificationLog({ status: 'DEAD_LETTER', retryCount: 5, lastError: '550 5.1.1 Mailbox <asha@example.in> unavailable' })])
    );
    const { user } = renderWithApp(<NotificationsPage />, { ...asStaff('FRAUD_ANALYST'), route: '/notifications' });
    const toggle = await screen.findByRole('button', { name: 'Show details: Your account was debited' });
    expect(within(toggle.closest('tr') as HTMLElement).getByText('Dead letter')).toBeInTheDocument();
    await user.click(toggle);
    const details = screen.getByRole('region', { name: 'Details: Your account was debited' });
    expect(within(details).getByText('Last error')).toBeInTheDocument();
    expect(within(details).getByText('550 5.1.1 Mailbox <asha@example.in> unavailable')).toBeInTheDocument();
  });

  it('filters by the exact recipient address', async () => {
    const calls = logsHandler((query) => ok(query.recipient ? [aNotificationLog({ subject: 'Filtered' })] : many(2)));
    const { user } = renderWithApp(<NotificationsPage />, { ...asStaff('SUPPORT'), route: '/notifications' });
    await screen.findByRole('button', { name: 'Show details: Message 0' });
    await user.type(screen.getByLabelText('Recipient'), '  Asha@Example.in {Enter}');
    expect(await screen.findByRole('button', { name: 'Show details: Filtered' })).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ recipient: 'asha@example.in', limit: '20', offset: '0' });
    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ limit: '20', offset: '0' }));
    expect(screen.getByLabelText('Recipient')).toHaveValue('');
  });

  it('takes the recipient from the address', async () => {
    const calls = logsHandler(() => ok([]));
    renderWithApp(<NotificationsPage />, { ...asStaff('SUPPORT'), route: '/notifications?recipient=asha%40example.in', path: '/notifications' });
    expect(await screen.findByText('No notifications to asha@example.in')).toBeInTheDocument();
    expect(screen.getByLabelText('Recipient')).toHaveValue('asha@example.in');
    expect(calls).toEqual([{ recipient: 'asha@example.in', limit: '20', offset: '0' }]);
  });

  it('rejects an over-long recipient without calling the API', async () => {
    const calls = logsHandler(() => ok([]));
    const { user } = renderWithApp(<NotificationsPage />, { ...asStaff('SUPPORT'), route: '/notifications' });
    await screen.findByText('No notifications yet');
    await user.click(screen.getByLabelText('Recipient'));
    await user.paste(`${'a'.repeat(250)}@example.in`);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByText('Addresses are at most 254 characters')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it('says when nothing has been sent', async () => {
    logsHandler(() => ok([]));
    renderWithApp(<NotificationsPage />, { ...asStaff('SUPPORT'), route: '/notifications' });
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });

  it('announces loading', async () => {
    logsHandler(async () => {
      await delay('infinite');
      return ok([]);
    });
    renderWithApp(<NotificationsPage />, { ...asStaff('SUPPORT'), route: '/notifications' });
    expect(await screen.findByText('Loading notifications…')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let attempt = 0;
    logsHandler(() => (attempt++ === 0 ? fail(403, 'NETWORK_NOT_ALLOWED') : ok([aNotificationLog()])));
    const { user } = renderWithApp(<NotificationsPage />, { ...asStaff('SUPPORT'), route: '/notifications' });
    expect(await screen.findByText('Staff network required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: 'Show details: Your account was debited' })).toBeInTheDocument();
  });

  it('pages through the log', async () => {
    const calls = logsHandler((query) => ok(query.offset === '20' ? many(4) : many(20)));
    const { user } = renderWithApp(<NotificationsPage />, { ...asStaff('SUPPORT'), route: '/notifications' });
    await screen.findByRole('button', { name: 'Show details: Message 19' });
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ limit: '20', offset: '20' }));
    expect(await screen.findByText('Showing 21–24')).toBeInTheDocument();
  });
});
