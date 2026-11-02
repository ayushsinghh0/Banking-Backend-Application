import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aDeviceSession, aMe, aSecurityEvent } from '@/test/fixtures';
import type { DeviceSession } from '@/lib/api/types';
import { describeSecurityEvent } from './SignInActivity';
import SecurityPage from './SecurityPage';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const current = aDeviceSession({ id: 'dev-1', current: true, deviceLabel: 'Chrome on Windows', lastSeenAt: minutesAgo(0), mfa: true });
const phone = aDeviceSession({ id: 'dev-2', current: false, deviceLabel: 'Safari on iPhone', ipMasked: '198.51.100.x', lastSeenAt: minutesAgo(180) });
const tablet = aDeviceSession({ id: 'dev-3', current: false, deviceLabel: 'Chrome on iPad', ipMasked: '2001:db8:1::/48', lastSeenAt: null });

function setup(sessions: DeviceSession[] = [phone, current, tablet], events = [aSecurityEvent()]) {
  let list = sessions;
  const calls: string[] = [];
  server.use(
    http.get(apiUrl('/auth/me'), () => ok(aMe())),
    http.get(apiUrl('/auth/sessions'), () => ok(list)),
    http.get(apiUrl('/auth/security-events'), ({ request }) => {
      calls.push(`events ${new URL(request.url).searchParams.get('limit')}`);
      return ok(events);
    }),
    http.delete(apiUrl('/auth/sessions/:id'), ({ params }) => {
      calls.push(`DELETE ${String(params.id)}`);
      list = list.filter((s) => s.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(apiUrl('/auth/sessions/revoke-others'), () => {
      calls.push('revoke-others');
      const revoked = list.filter((s) => !s.current).length;
      list = list.filter((s) => s.current);
      return ok({ revoked });
    })
  );
  const view = renderWithApp(<SecurityPage />, { route: '/settings/security' });
  return { ...view, calls };
}

describe('Sessions and devices', () => {
  it('lists every signed-in device, this one first and marked', async () => {
    setup();
    const section = await screen.findByRole('region', { name: 'Sessions and devices' });
    const rows = await within(section).findAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Chrome on Windows');
    expect(rows[0]).toHaveTextContent('This device');
    expect(rows[0]).toHaveTextContent('Active now');
    expect(rows[0]).toHaveTextContent('two-factor');
    expect(within(rows[0]!).queryByRole('button')).not.toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Safari on iPhone');
    expect(rows[1]).toHaveTextContent('198.51.100.x');
    expect(rows[1]).toHaveTextContent(/last active 3 hours ago/i);
    expect(within(rows[1]!).getByRole('button', { name: 'Sign out Safari on iPhone' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('2001:db8:1::/48');
  });

  it('signs out one device', async () => {
    const { user, calls } = setup();
    const section = await screen.findByRole('region', { name: 'Sessions and devices' });
    await user.click(await within(section).findByRole('button', { name: 'Sign out Safari on iPhone' }));
    await waitFor(() => expect(within(section).queryByText('Safari on iPhone')).not.toBeInTheDocument());
    expect(calls).toContain('DELETE dev-2');
    expect(await screen.findByText('Safari on iPhone has been signed out.')).toBeInTheDocument();
  });

  it('signs out everywhere else after confirming', async () => {
    const { user, calls } = setup();
    const section = await screen.findByRole('region', { name: 'Sessions and devices' });
    await user.click(await within(section).findByRole('button', { name: 'Sign out everywhere else' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Sign out everywhere else?' });
    expect(confirm).toHaveTextContent('2 other devices');
    await user.click(within(confirm).getByRole('button', { name: 'Sign out other devices' }));
    await waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(1));
    expect(calls).toContain('revoke-others');
    expect(within(section).queryByRole('button', { name: 'Sign out everywhere else' })).not.toBeInTheDocument();
    expect(await screen.findByText('Signed out of 2 other devices')).toBeInTheDocument();
  });

  it('keeps a device listed and explains when signing it out fails', async () => {
    const { user } = setup();
    server.use(http.delete(apiUrl('/auth/sessions/:id'), () => fail(503, 'SERVICE_UNAVAILABLE', 'down')));
    const section = await screen.findByRole('region', { name: 'Sessions and devices' });
    await user.click(await within(section).findByRole('button', { name: 'Sign out Safari on iPhone' }));
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    expect(within(section).getByText('Safari on iPhone')).toBeInTheDocument();
  });

  it('offers a retry when the sessions cannot be loaded', async () => {
    let calls = 0;
    setup();
    server.use(
      http.get(apiUrl('/auth/sessions'), () => {
        calls += 1;
        return calls === 1 ? fail(503, 'SERVICE_UNAVAILABLE', 'down') : ok([current]);
      })
    );
    const { user } = renderWithApp(<SecurityPage />, { route: '/settings/security' });
    const sections = await screen.findAllByRole('region', { name: 'Sessions and devices' });
    const section = sections[sections.length - 1]!;
    await user.click(await within(section).findByRole('button', { name: /try again/i }));
    expect(await within(section).findByText('This device')).toBeInTheDocument();
  });
});

describe('Recent sign-in activity', () => {
  it('lists recent events in plain words and marks new devices', async () => {
    const { calls } = setup(
      [current],
      [
        aSecurityEvent({ id: 'e1', type: 'NEW_DEVICE_SIGN_IN', deviceLabel: 'Firefox on Linux', ipMasked: '192.0.2.x', at: minutesAgo(5) }),
        aSecurityEvent({ id: 'e2', type: 'SIGN_IN_FAILED', deviceLabel: 'Chrome on Android', ipMasked: '198.51.100.x', at: minutesAgo(60) }),
        aSecurityEvent({ id: 'e3', type: 'SIGN_IN_SUCCEEDED', at: minutesAgo(120), details: { newDevice: true } }),
        aSecurityEvent({ id: 'e4', type: 'PASSWORD_CHANGED', deviceLabel: null, ipMasked: null, at: minutesAgo(600) }),
      ]
    );
    const section = await screen.findByRole('region', { name: 'Recent sign-in activity' });
    const rows = await within(section).findAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Signed in on a new device');
    expect(rows[0]).toHaveTextContent('Firefox on Linux · 192.0.2.x');
    expect(within(rows[0]!).getByText('New device')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Sign-in attempt failed');
    expect(within(rows[1]!).queryByText('New device')).not.toBeInTheDocument();
    expect(within(rows[2]!).getByText('New device')).toBeInTheDocument();
    expect(rows[3]).toHaveTextContent('Password changed');
    expect(calls).toContain('events 20');
  });

  it('says when there is nothing to show', async () => {
    setup([current], []);
    const section = await screen.findByRole('region', { name: 'Recent sign-in activity' });
    expect(await within(section).findByText('No recent activity')).toBeInTheDocument();
  });
});

describe('describeSecurityEvent', () => {
  it.each([
    ['LOGIN_SUCCEEDED', 'Signed in', 'signin'],
    ['sign_in.succeeded', 'Signed in', 'signin'],
    ['LOGIN_FAILED', 'Sign-in attempt failed', 'failed'],
    ['MFA_FAILED', 'Incorrect authenticator code', 'failed'],
    ['NEW_DEVICE_LOGIN', 'Signed in on a new device', 'signin'],
    ['SESSION_REVOKED', 'Signed out remotely', 'signout'],
    ['PASSWORD_CHANGED', 'Password changed', 'change'],
    ['IP_AUTO_BANNED', 'Sign-ins blocked from a network', 'blocked'],
    ['SOMETHING_NEW', 'Something new', 'other'],
  ])('%s → %s', (type, label, kind) => {
    expect(describeSecurityEvent(aSecurityEvent({ type }))).toMatchObject({ label, kind });
  });
});
