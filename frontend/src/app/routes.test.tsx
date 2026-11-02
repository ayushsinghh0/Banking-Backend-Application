import { isValidElement } from 'react';
import type { RouteObject } from 'react-router';
import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderRoute } from '@/test/render';
import { aMe } from '@/test/fixtures';
import { mockSecurityApi } from '@/features/security/testing';
import type { Role } from '@/lib/auth/session';
import { ACCOUNT_LINKS, HOME, NAVIGATION, type NavSection } from './navigation';

const noSession = () => server.use(http.post(apiUrl('/auth/refresh'), () => fail(401, 'UNAUTHORIZED', 'no session')));

describe('route guards', () => {
  it('sends signed-out visitors to sign in and remembers where they were going', async () => {
    noSession();
    const { router } = await renderRoute('/payees', { role: null });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'), { timeout: 30_000 });
    expect(router.state.location.state).toEqual({ from: '/payees' });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('keeps an email-link token through sign-in', async () => {
    noSession();
    const { router } = await renderRoute('/mfa/enrol#token=emailed-enrolment-token-0123456789', { role: null });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'), { timeout: 30_000 });
    expect(router.state.location.state).toEqual({ from: '/mfa/enrol#token=emailed-enrolment-token-0123456789' });
  });

  it.each<[Role, string]>([
    ['CUSTOMER', '/overview'],
    ['TELLER', '/dashboard'],
    ['KYC_OFFICER', '/teller'],
    ['FRAUD_ANALYST', '/approvals'],
    ['SUPPORT', '/transfer'],
    ['BANK_ADMIN', '/teller'],
    // Operations pages: payments for the three oversight roles, the security centre for admin and support only
    ['CUSTOMER', '/payments'],
    ['TELLER', '/security-centre'],
    ['KYC_OFFICER', '/payments'],
    ['FRAUD_ANALYST', '/security-centre'],
  ])('keeps %s out of %s and sends them home', async (role, forbidden) => {
    server.use(http.all(apiUrl('/*'), () => ok([])));
    const { router } = await renderRoute(forbidden, { role });
    await waitFor(() => expect(router.state.location.pathname).toBe(HOME[role]), { timeout: 30_000 });
  });

  it('forces staff without a second factor to enrol first', async () => {
    const { router } = await renderRoute('/overview', { role: 'BANK_ADMIN', claims: { mfa: false } });
    await waitFor(() => expect(router.state.location.pathname).toBe('/mfa/enrol'), { timeout: 30_000 });
  });

  it('sends a signed-in person from the sign-in page to their home page', async () => {
    server.use(http.all(apiUrl('/*'), () => ok([])));
    const { router } = await renderRoute('/login', { role: 'FRAUD_ANALYST' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/fraud'), { timeout: 30_000 });
  });

  it('resolves "/" to the role home page', async () => {
    server.use(http.all(apiUrl('/*'), () => ok([])));
    const { router } = await renderRoute('/', { role: 'TELLER' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/teller'), { timeout: 30_000 });
  });

  it('shows a friendly page for unknown URLs', async () => {
    await renderRoute('/no-such-page', { role: 'CUSTOMER' });
    expect(await screen.findByRole('heading', { name: /couldn’t find that page/i })).toBeInTheDocument();
  });

  it('renders the shell with one main navigation for the role, and settings in the account menu', async () => {
    server.use(http.get(apiUrl('/auth/me'), () => ok(aMe())));
    mockSecurityApi();
    const { user } = await renderRoute('/settings/security', { role: 'CUSTOMER' });
    // First load transforms the lazily imported page, which can take a moment under test
    expect(await screen.findByRole('heading', { name: 'Security', level: 1 }, { timeout: 8000 })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const item of NAVIGATION.CUSTOMER.flatMap((s) => s.items)) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('href', item.to);
    }
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    for (const link of ACCOUNT_LINKS.CUSTOMER) {
      expect(await screen.findByRole('menuitem', { name: link.label })).toBeInTheDocument();
    }
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('opens Sphere from the top bar on phones, never over the tab bar', async () => {
    server.use(
      http.get(apiUrl('/auth/me'), () => ok(aMe())),
      http.get(apiUrl('/assistant/meta'), () => ok({ provider: 'builtin', suggestions: [] }))
    );
    mockSecurityApi();
    const { user } = await renderRoute('/settings/security', { role: 'CUSTOMER' });
    await screen.findByRole('heading', { name: 'Security', level: 1 }, { timeout: 8000 });
    const banner = screen.getByRole('banner');
    const launcher = within(banner).getByRole('button', { name: 'Ask Sphere' });
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('button', { name: /sphere/i })).not.toBeInTheDocument();
    // A healthy real-time connection shows nothing
    expect(within(banner).queryByRole('status')).not.toBeInTheDocument();
    await user.click(launcher);
    expect(await screen.findByRole('dialog', { name: 'Sphere' }, { timeout: 8000 })).toBeInTheDocument();
  });

  it('lets customers open Add money', async () => {
    server.use(http.all(apiUrl('/*'), () => ok([])));
    await renderRoute('/add-money', { role: 'CUSTOMER' });
    expect(await screen.findByRole('heading', { name: 'Add money', level: 1 }, { timeout: 8000 })).toBeInTheDocument();
  });

  it.each<[Role, string, string]>([
    ['BANK_ADMIN', '/payments', 'Payments'],
    ['SUPPORT', '/payments', 'Payments'],
    ['FRAUD_ANALYST', '/payments', 'Payments'],
    ['BANK_ADMIN', '/security-centre', 'Security centre'],
    ['SUPPORT', '/security-centre', 'Security centre'],
  ])('lets %s open %s', async (role, path, title) => {
    server.use(http.all(apiUrl('/*'), () => ok([])));
    const { router } = await renderRoute(path, { role });
    expect(await screen.findByRole('heading', { name: title, level: 1 }, { timeout: 8000 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(path);
  });

  it('gives a fraud analyst three tabs on phones, with no “More”', async () => {
    server.use(http.all(apiUrl('/*'), () => ok([])));
    await renderRoute('/payments', { role: 'FRAUD_ANALYST' });
    const nav = await screen.findByRole('navigation', { name: 'Main' }, { timeout: 8000 });
    expect(within(nav).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/fraud', '/notifications', '/payments']);
    expect(within(nav).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('puts what doesn’t fit in the phone tab bar behind “More”', async () => {
    server.use(http.all(apiUrl('/*'), () => ok([])));
    const { user } = await renderRoute('/overview', { role: 'BANK_ADMIN' });
    const nav = await screen.findByRole('navigation', { name: 'Main' }, { timeout: 8000 });
    const all = NAVIGATION.BANK_ADMIN.flatMap((s) => s.items);
    // Four destinations and "More" fill the five tab slots
    expect(within(nav).getAllByRole('link')).toHaveLength(4);
    expect(within(nav).getByRole('link', { name: 'Teller sessions' })).toHaveTextContent('Sessions');
    await user.click(within(nav).getByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'All sections' });
    for (const item of all) expect(within(sheet).getByRole('link', { name: item.label })).toBeInTheDocument();
    await user.click(within(sheet).getByRole('link', { name: 'Notifications' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'All sections' })).not.toBeInTheDocument());
  });

  it('every navigation link points at a route the role may open', async () => {
    const { routes } = await import('./routes');
    const { RequireRole } = await import('./guards');
    /** Path → the roles allowed to open it; undefined when anyone signed in may */
    const allowedBy = new Map<string, readonly Role[] | undefined>();
    const walk = (rs: RouteObject[], allowed: readonly Role[] | undefined) =>
      rs.forEach((r) => {
        const guard = isValidElement(r.element) && r.element.type === RequireRole ? (r.element.props as { roles: readonly Role[] }).roles : undefined;
        const next = guard ?? allowed;
        if (r.path) allowedBy.set(r.path, next);
        if (r.children) walk(r.children, next);
      });
    walk(routes, undefined);
    for (const [role, sections] of Object.entries(NAVIGATION) as Array<[Role, NavSection[]]>) {
      for (const item of [...sections.flatMap((s) => s.items), ...ACCOUNT_LINKS[role]]) {
        expect(allowedBy.has(item.to), `${item.to} is not a route`).toBe(true);
        const allowed = allowedBy.get(item.to);
        expect(!allowed || allowed.includes(role), `${role} may not open ${item.to}`).toBe(true);
        // A tab-bar label is a word of the full label, so the visible text stays part of the accessible name
        if (item.short) expect(item.label.toLowerCase()).toContain(item.short.toLowerCase());
      }
    }
  });
});
