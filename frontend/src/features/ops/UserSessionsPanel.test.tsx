import { delay, http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS } from '@/test/fixtures';
import { asStaff, resetToasts } from '@/features/staff/testing';
import type { UserSession } from './api';
import { aSession, sessionsHandler } from './test/handlers';
import { UserSessionsPanel } from './UserSessionsPanel';

afterEach(resetToasts);

const render = (role: 'BANK_ADMIN' | 'SUPPORT' = 'BANK_ADMIN') =>
  renderWithApp(<UserSessionsPanel userId={IDS.customer} name="Asha Rao" canRevoke={role === 'BANK_ADMIN'} />, asStaff(role));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('UserSessionsPanel', () => {
  it('lists sessions, most recently active first, with addresses masked as the API sends them', async () => {
    server.use(
      sessionsHandler([
        aSession({ id: 'old', deviceLabel: 'Firefox on Linux', ipMasked: '2001:db8:1::/48', lastSeenAt: minutesAgo(600), mfa: false }),
        aSession({ id: 'new', deviceLabel: 'Safari on iPhone', ipMasked: '198.51.100.x', lastSeenAt: minutesAgo(5) }),
      ])
    );
    render();
    const panel = screen.getByRole('region', { name: 'Sessions and devices' });
    const rows = await within(panel).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Safari on iPhone');
    expect(rows[0]).toHaveTextContent('198.51.100.x');
    expect(rows[0]).toHaveTextContent('Active 5 minutes ago');
    expect(rows[0]).toHaveTextContent('With two-factor');
    expect(rows[1]).toHaveTextContent('2001:db8:1::/48');
    expect(rows[1]).toHaveTextContent('Password only');
  });

  it('marks the session making the request and never offers to end it', async () => {
    server.use(sessionsHandler([aSession({ current: true, lastSeenAt: null, ipMasked: null })]));
    render();
    const row = await screen.findByRole('listitem');
    expect(row).toHaveTextContent('This device');
    expect(row).toHaveTextContent('Address not recorded');
    expect(within(row).queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('says when nobody is signed in', async () => {
    server.use(sessionsHandler([]));
    render();
    expect(await screen.findByText('No active sessions')).toBeInTheDocument();
  });

  it('treats an unknown sign-in as having no sessions', async () => {
    server.use(sessionsHandler(fail(404, 'NOT_FOUND', 'User not found')));
    render();
    expect(await screen.findByText('No active sessions')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let attempt = 0;
    server.use(sessionsHandler(() => (attempt++ === 0 ? fail(503, 'SERVICE_BUSY') : ok([aSession()]))));
    const { user } = render();
    expect(await screen.findByText('Busy right now')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Chrome on Windows')).toBeInTheDocument();
  });

  it('announces loading', async () => {
    server.use(
      sessionsHandler(async () => {
        await delay('infinite');
        return [];
      })
    );
    render();
    expect(await screen.findByText('Loading sessions…')).toBeInTheDocument();
  });

  it('signs a session out after confirming, for administrators', async () => {
    let sessions: UserSession[] = [aSession()];
    let deleted = '';
    server.use(
      sessionsHandler(() => ok(sessions)),
      http.delete(apiUrl('/auth/admin/users/:userId/sessions/:sessionId'), ({ request }) => {
        deleted = new URL(request.url).pathname;
        sessions = [];
        return new HttpResponse(null, { status: 204 });
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Sign out Chrome on Windows, 203.0.113.x' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Sign Asha Rao out of Chrome on Windows?' });
    await user.click(within(confirm).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Signed out')).toBeInTheDocument();
    expect(deleted).toBe(`/api/v1/auth/admin/users/${IDS.customer}/sessions/sess-1`);
    expect(await screen.findByText('No active sessions')).toBeInTheDocument();
  });

  it('keeps the confirmation open when signing out fails for a moment', async () => {
    server.use(
      sessionsHandler([aSession()]),
      http.delete(apiUrl('/auth/admin/users/:userId/sessions/:sessionId'), () => fail(503, 'SERVICE_UNAVAILABLE'))
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /^sign out chrome on windows/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('accepts a session that had already ended', async () => {
    server.use(
      sessionsHandler([aSession()]),
      http.delete(apiUrl('/auth/admin/users/:userId/sessions/:sessionId'), () => fail(404, 'NOT_FOUND', 'Session not found'))
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /^sign out chrome on windows/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Session already ended')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('is read-only for support', async () => {
    server.use(sessionsHandler([aSession()]));
    render('SUPPORT');
    await screen.findByText('Chrome on Windows');
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });
});
