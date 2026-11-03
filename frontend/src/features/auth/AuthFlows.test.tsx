import { http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { makeAccessToken } from '@/test/tokens';
import RegisterPage from './RegisterPage';
import VerifyEmailPage from './VerifyEmailPage';
import ForgotPasswordPage from './ForgotPasswordPage';
import ResetPasswordPage from './ResetPasswordPage';
import StaffActivatePage from './StaffActivatePage';

const TOKEN = 'Abcdefghijklmnopqrstuvwxyz0123456789_-AB';

describe('RegisterPage', () => {
  it('shows the password policy live and blocks weak passwords', async () => {
    const { user } = renderWithApp(<RegisterPage />, { role: null, route: '/register' });
    await user.type(screen.getByLabelText('Email'), 'new@example.in');
    await user.type(screen.getByLabelText('Password'), 'weak');
    expect(screen.getByText('At least 10 characters').closest('li')).toHaveAttribute('data-met', 'false');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 10 characters')).toBeInTheDocument();
  });

  it('requires the confirmation to match', async () => {
    const { user } = renderWithApp(<RegisterPage />, { role: null, route: '/register' });
    await user.type(screen.getByLabelText('Email'), 'new@example.in');
    await user.type(screen.getByLabelText('Password'), 'Strong-pass-123');
    await user.type(screen.getByLabelText('Confirm password'), 'Strong-pass-124');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Passwords don’t match')).toBeInTheDocument();
  });

  it('registers and shows the check-your-email screen (same answer for any email)', async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl('/auth/register'), async ({ request }) => {
        body = await request.json();
        return ok({ message: 'Registration received.' }, 202);
      })
    );
    const { user } = renderWithApp(<RegisterPage />, { role: null, route: '/register' });
    await user.type(screen.getByLabelText('Email'), 'New@Example.in');
    await user.type(screen.getByLabelText('Password'), 'Strong-pass-123');
    await user.type(screen.getByLabelText('Confirm password'), 'Strong-pass-123');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('new@example.in')).toBeInTheDocument();
    expect(body).toEqual({ email: 'new@example.in', password: 'Strong-pass-123' });
  });

  it('maps server-side field errors onto the form', async () => {
    server.use(
      http.post(apiUrl('/auth/register'), () =>
        fail(400, 'VALIDATION_ERROR', 'Invalid input parameters', { details: [{ field: 'email', message: 'Invalid email address format' }] })
      )
    );
    const { user } = renderWithApp(<RegisterPage />, { role: null, route: '/register' });
    await user.type(screen.getByLabelText('Email'), 'odd@example.in');
    await user.type(screen.getByLabelText('Password'), 'Strong-pass-123');
    await user.type(screen.getByLabelText('Confirm password'), 'Strong-pass-123');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Invalid email address format')).toBeInTheDocument();
  });
});

describe('VerifyEmailPage', () => {
  it('verifies the token from the link fragment automatically', async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl('/auth/email/verify'), async ({ request }) => {
        body = await request.json();
        return ok({ message: 'verified' });
      })
    );
    renderWithApp(<VerifyEmailPage />, { role: null, route: `/verify-email#token=${TOKEN}` });
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    expect(body).toEqual({ token: TOKEN });
  });

  it('offers a new link when the token is invalid or expired', async () => {
    let resentFor: unknown;
    server.use(
      http.post(apiUrl('/auth/email/verify'), () => fail(400, 'INVALID_OR_EXPIRED_TOKEN', 'expired')),
      http.post(apiUrl('/auth/email/resend-verification'), async ({ request }) => {
        resentFor = await request.json();
        return ok({ message: 'ok' }, 202);
      })
    );
    const { user } = renderWithApp(<VerifyEmailPage />, { role: null, route: `/verify-email#token=${TOKEN}` });
    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'asha@example.in');
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(await screen.findByText(/if the address can receive email/i)).toBeInTheDocument();
    expect(resentFor).toEqual({ email: 'asha@example.in' });
  });

  it('handles a link without a token', async () => {
    renderWithApp(<VerifyEmailPage />, { role: null, route: '/verify-email' });
    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
  });
});

describe('ForgotPasswordPage', () => {
  it('always confirms in the same words, whether or not the account exists', async () => {
    server.use(http.post(apiUrl('/auth/password/forgot'), () => ok({ message: 'If the address…' }, 202)));
    const { user } = renderWithApp(<ForgotPasswordPage />, { role: null, route: '/forgot-password' });
    await user.type(screen.getByLabelText('Email'), 'asha@example.in');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(/if an account exists for/i)).toBeInTheDocument();
  });

  it('explains rate limits', async () => {
    server.use(http.post(apiUrl('/auth/password/forgot'), () => fail(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests')));
    const { user } = renderWithApp(<ForgotPasswordPage />, { role: null, route: '/forgot-password' });
    await user.type(screen.getByLabelText('Email'), 'asha@example.in');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('Too many attempts')).toBeInTheDocument();
  });
});

describe('ResetPasswordPage', () => {
  it('resets the password and sends the person to sign in', async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl('/auth/password/reset'), async ({ request }) => {
        body = await request.json();
        return ok(undefined);
      })
    );
    const { user } = renderWithApp(<ResetPasswordPage />, { role: null, route: `/reset-password#token=${TOKEN}` });
    await user.type(screen.getByLabelText('New password'), 'Brand-new-pass-9');
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-new-pass-9');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
    expect(body).toEqual({ token: TOKEN, newPassword: 'Brand-new-pass-9' });
  });

  it('signs this device out too, because every session ends', async () => {
    server.use(http.post(apiUrl('/auth/password/reset'), () => ok(undefined)));
    const { user, services } = renderWithApp(<ResetPasswordPage />, { route: `/reset-password#token=${TOKEN}` });
    await user.type(screen.getByLabelText('New password'), 'Brand-new-pass-9');
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-new-pass-9');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    await waitFor(() => expect(services.session.status).toBe('anonymous'));
  });

  it('explains expired links', async () => {
    server.use(http.post(apiUrl('/auth/password/reset'), () => fail(400, 'INVALID_OR_EXPIRED_TOKEN', 'expired')));
    const { user } = renderWithApp(<ResetPasswordPage />, { role: null, route: `/reset-password#token=${TOKEN}` });
    await user.type(screen.getByLabelText('New password'), 'Brand-new-pass-9');
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-new-pass-9');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('Link expired or already used')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute('href', '/forgot-password');
  });

  it('refuses to show the form without a token', () => {
    renderWithApp(<ResetPasswordPage />, { role: null, route: '/reset-password' });
    expect(screen.getByText('Link expired or already used')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });
});

describe('StaffActivatePage', () => {
  it('sets the staff password, keeps the enrolment token in memory and continues to authenticator setup', async () => {
    server.use(
      http.post(apiUrl('/auth/staff/activate'), () =>
        ok({ tokens: { accessToken: makeAccessToken({ role: 'TELLER', mfa: false }), expiresInSeconds: 900 }, enrolmentToken: 'enrol-token-0123456789abcdef' })
      )
    );
    const { user, services } = renderWithApp(<StaffActivatePage />, { role: null, route: `/staff/activate#token=${TOKEN}` });
    await user.type(screen.getByLabelText('Choose a password'), 'Teller-pass-123');
    await user.type(screen.getByLabelText('Confirm password'), 'Teller-pass-123');
    await user.click(screen.getByRole('button', { name: 'Activate account' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/mfa/enrol'));
    expect(services.session.user?.role).toBe('TELLER');
    const { takeEnrolmentToken } = await import('./enrolment');
    expect(takeEnrolmentToken()).toBe('enrol-token-0123456789abcdef');
  });

  it('explains an expired activation link', async () => {
    server.use(http.post(apiUrl('/auth/staff/activate'), () => fail(400, 'INVALID_OR_EXPIRED_TOKEN', 'expired')));
    const { user } = renderWithApp(<StaffActivatePage />, { role: null, route: `/staff/activate#token=${TOKEN}` });
    await user.type(screen.getByLabelText('Choose a password'), 'Teller-pass-123');
    await user.type(screen.getByLabelText('Confirm password'), 'Teller-pass-123');
    await user.click(screen.getByRole('button', { name: 'Activate account' }));
    expect(await screen.findByText(/ask an administrator to send a new activation/i)).toBeInTheDocument();
  });
});
