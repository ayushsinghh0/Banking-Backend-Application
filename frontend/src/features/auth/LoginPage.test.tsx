import { http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { makeAccessToken } from '@/test/tokens';
import LoginPage from './LoginPage';

const tokensFor = (role: 'CUSTOMER' | 'BANK_ADMIN' = 'CUSTOMER', mfa = false) => ({
  user: { id: 'u1', email: 'asha@example.in', role },
  tokens: { accessToken: makeAccessToken({ role, mfa }), expiresInSeconds: 900 },
});

async function fillAndSubmit(user: ReturnType<typeof renderWithApp>['user'], email = 'asha@example.in', password = 'Secret-pass-1') {
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage', () => {
  it('validates before calling the API', async () => {
    const { user } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
  });

  it('signs a customer in and goes to their dashboard', async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl('/auth/login'), async ({ request }) => {
        body = await request.json();
        return ok(tokensFor());
      })
    );
    const { user, services } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await fillAndSubmit(user, '  Asha@Example.in ');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'));
    expect(body).toEqual({ email: 'asha@example.in', password: 'Secret-pass-1' });
    expect(services.session.status).toBe('authenticated');
  });

  it('returns to the page the person originally asked for', async () => {
    server.use(http.post(apiUrl('/auth/login'), () => ok(tokensFor())));
    const { user, router } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await router.navigate('/login', { state: { from: '/payees' } });
    await fillAndSubmit(user);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/payees'));
  });

  it('asks for the authenticator code when MFA is on, then signs in', async () => {
    let mfaBody: unknown;
    server.use(
      http.post(apiUrl('/auth/login'), () => ok({ mfaRequired: true, challengeToken: 'challenge-token-0123456789', expiresInSeconds: 300 })),
      http.post(apiUrl('/auth/login/mfa'), async ({ request }) => {
        mfaBody = await request.json();
        return ok(tokensFor('BANK_ADMIN', true));
      })
    );
    const { user } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await fillAndSubmit(user);
    expect(await screen.findByRole('heading', { name: 'Two-factor verification' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/overview'));
    expect(mfaBody).toEqual({ challengeToken: 'challenge-token-0123456789', code: '123456' });
  });

  it('keeps the person on the code step after a wrong code', async () => {
    server.use(
      http.post(apiUrl('/auth/login'), () => ok({ mfaRequired: true, challengeToken: 'challenge-token-0123456789', expiresInSeconds: 300 })),
      http.post(apiUrl('/auth/login/mfa'), () => fail(401, 'UNAUTHORIZED', 'Invalid or expired verification code'))
    );
    const { user } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await fillAndSubmit(user);
    await user.type(await screen.findByLabelText('Authenticator code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/code is incorrect or has expired/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Authenticator code')).toHaveValue('');
  });

  it('can go back from the code step to use another account', async () => {
    server.use(
      http.post(apiUrl('/auth/login'), () => ok({ mfaRequired: true, challengeToken: 'challenge-token-0123456789', expiresInSeconds: 300 }))
    );
    const { user } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await fillAndSubmit(user);
    await user.click(await screen.findByRole('button', { name: /use a different account/i }));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('shows one generic message for wrong credentials (no account enumeration)', async () => {
    server.use(http.post(apiUrl('/auth/login'), () => fail(401, 'UNAUTHORIZED', 'Invalid email or password')));
    const { user } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await fillAndSubmit(user);
    expect(await screen.findByText('The email or password is incorrect.')).toBeInTheDocument();
  });

  it('offers to resend the verification email for unverified accounts', async () => {
    let resent: unknown;
    server.use(
      http.post(apiUrl('/auth/login'), () => fail(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address before signing in')),
      http.post(apiUrl('/auth/email/resend-verification'), async ({ request }) => {
        resent = await request.json();
        return ok({ message: 'sent' }, 202);
      })
    );
    const { user } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await fillAndSubmit(user);
    await user.click(await screen.findByRole('button', { name: /resend verification email/i }));
    expect(await screen.findByText(/new verification link is on its way/i)).toBeInTheDocument();
    expect(resent).toEqual({ email: 'asha@example.in' });
  });

  it('explains account protection after distributed attacks', async () => {
    server.use(http.post(apiUrl('/auth/login'), () => fail(429, 'LOGIN_STEP_UP_REQUIRED', 'Too many failed sign-in attempts on this account.')));
    const { user } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await fillAndSubmit(user);
    expect(await screen.findByText('Account protected')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /reset your password/i })).toHaveAttribute('href', '/forgot-password');
  });

  it('explains the staff network requirement', async () => {
    server.use(http.post(apiUrl('/auth/login'), () => fail(403, 'NETWORK_NOT_ALLOWED', 'Staff network only')));
    const { user } = renderWithApp(<LoginPage />, { role: null, route: '/login' });
    await fillAndSubmit(user);
    expect(await screen.findByText('Staff network required')).toBeInTheDocument();
  });

  it('confirms a completed sign-out', () => {
    renderWithApp(<LoginPage />, { role: null, route: '/login' });
    expect(screen.queryByText(/you have been signed out/i)).not.toBeInTheDocument();
  });
});
