import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { makeAccessToken } from '@/test/tokens';
import { aMe } from '@/test/fixtures';
import MfaEnrolPage from '@/features/auth/MfaEnrolPage';
import { setEnrolmentToken } from '@/features/auth/enrolment';
import SecurityPage from './SecurityPage';
import { mockSecurityApi } from './testing';

const SETUP = { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/BankSphere:meera?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=BankSphere' };

afterEach(() => setEnrolmentToken(null));

describe('MfaEnrolPage (staff)', () => {
  it('enrols with the in-memory activation token and lands on the staff home page', async () => {
    setEnrolmentToken('enrol-token-0123456789abcdef');
    const bodies: unknown[] = [];
    server.use(
      http.post(apiUrl('/auth/mfa/setup'), async ({ request }) => {
        bodies.push(await request.json());
        return ok(SETUP);
      }),
      http.post(apiUrl('/auth/mfa/enable'), async ({ request }) => {
        bodies.push(await request.json());
        return ok({ tokens: { accessToken: makeAccessToken({ role: 'TELLER', mfa: true }), expiresInSeconds: 900 } });
      })
    );
    const { user, services } = renderWithApp(<MfaEnrolPage />, { role: 'TELLER', claims: { mfa: false }, route: '/mfa/enrol' });
    await user.type(screen.getByLabelText('Your password'), 'Teller-pass-123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('img', { name: /qr code/i })).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText('6-digit code from the app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor authentication' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/teller'));
    expect(bodies).toEqual([
      { password: 'Teller-pass-123', enrolmentToken: 'enrol-token-0123456789abcdef' },
      { code: '123456', enrolmentToken: 'enrol-token-0123456789abcdef' },
    ]);
    expect(services.session.user?.mfa).toBe(true);
  });

  it('asks for the enrolment code when there is none in memory or in the link', async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl('/auth/mfa/setup'), async ({ request }) => {
        body = await request.json();
        return ok(SETUP);
      })
    );
    const { user } = renderWithApp(<MfaEnrolPage />, { role: 'BANK_ADMIN', claims: { mfa: false }, route: '/mfa/enrol' });
    await user.type(screen.getByLabelText('Enrolment code'), 'printed-enrolment-token-0123456789');
    await user.type(screen.getByLabelText('Your password'), 'Admin-pass-123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('img', { name: /qr code/i });
    expect(body).toEqual({ password: 'Admin-pass-123', enrolmentToken: 'printed-enrolment-token-0123456789' });
  });

  it('uses the token from a re-enrolment email link', async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl('/auth/mfa/setup'), async ({ request }) => {
        body = await request.json();
        return ok(SETUP);
      })
    );
    const { user } = renderWithApp(<MfaEnrolPage />, {
      role: 'FRAUD_ANALYST',
      claims: { mfa: false },
      route: '/mfa/enrol#token=emailed-enrolment-token-0123456789',
    });
    expect(screen.queryByLabelText('Enrolment code')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Your password'), 'Analyst-pass-1');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('img', { name: /qr code/i });
    expect(body).toEqual({ password: 'Analyst-pass-1', enrolmentToken: 'emailed-enrolment-token-0123456789' });
  });

  it('explains a rejected enrolment token', async () => {
    server.use(http.post(apiUrl('/auth/mfa/setup'), () => fail(403, 'ENROLMENT_TOKEN_REQUIRED', 'needs token')));
    const { user } = renderWithApp(<MfaEnrolPage />, { role: 'TELLER', claims: { mfa: false }, route: '/mfa/enrol' });
    await user.type(screen.getByLabelText('Enrolment code'), 'wrong-enrolment-token-0123456789');
    await user.type(screen.getByLabelText('Your password'), 'Teller-pass-123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enrolment link required')).toBeInTheDocument();
  });

  it('sends customers to their security settings instead', async () => {
    renderWithApp(<MfaEnrolPage />, { role: 'CUSTOMER', route: '/mfa/enrol' });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings/security'));
  });
});

describe('SecurityPage', () => {
  // Sessions and sign-in activity have their own tests (Sessions.test.tsx)
  beforeEach(() => mockSecurityApi());

  it('changes the password and adopts the new session tokens', async () => {
    const fresh = makeAccessToken({ sub: 'u-new-token' });
    let body: unknown;
    server.use(
      http.get(apiUrl('/auth/me'), () => ok(aMe())),
      http.post(apiUrl('/auth/password/change'), async ({ request }) => {
        body = await request.json();
        return ok({ tokens: { accessToken: fresh, expiresInSeconds: 900 } });
      })
    );
    const { user, services } = renderWithApp(<SecurityPage />, { route: '/settings/security' });
    const card = (await screen.findByRole('heading', { name: 'Password' })).closest('section')!;
    await user.type(within(card).getByLabelText('Current password'), 'Old-pass-1234');
    await user.type(within(card).getByLabelText('New password'), 'New-pass-56789');
    await user.type(within(card).getByLabelText('Confirm new password'), 'New-pass-56789');
    await user.click(within(card).getByRole('button', { name: 'Update password' }));
    await waitFor(() => expect(services.session.getAccessToken()).toBe(fresh));
    expect(body).toEqual({ currentPassword: 'Old-pass-1234', newPassword: 'New-pass-56789' });
  });

  it('reports a wrong current password next to the field', async () => {
    server.use(
      http.get(apiUrl('/auth/me'), () => ok(aMe())),
      http.post(apiUrl('/auth/password/change'), () => fail(403, 'INVALID_PASSWORD', 'Current password is incorrect'))
    );
    const { user } = renderWithApp(<SecurityPage />, { route: '/settings/security' });
    const card = (await screen.findByRole('heading', { name: 'Password' })).closest('section')!;
    await user.type(within(card).getByLabelText('Current password'), 'Wrong-pass-123');
    await user.type(within(card).getByLabelText('New password'), 'New-pass-56789');
    await user.type(within(card).getByLabelText('Confirm new password'), 'New-pass-56789');
    await user.click(within(card).getByRole('button', { name: 'Update password' }));
    expect(await within(card).findByText('The current password is incorrect')).toBeInTheDocument();
  });

  it('keeps the person signed in after a wrong password during authenticator setup', async () => {
    server.use(
      http.get(apiUrl('/auth/me'), () => ok(aMe({ mfaEnabled: false }))),
      http.post(apiUrl('/auth/mfa/setup'), () => fail(403, 'INVALID_PASSWORD', 'Password is incorrect'))
    );
    const { user, services } = renderWithApp(<SecurityPage />, { route: '/settings/security' });
    await user.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
    await user.type(screen.getByLabelText('Your password'), 'Wrong-pass-1');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('The password is incorrect')).toBeInTheDocument();
    expect(services.session.status).toBe('authenticated');
  });

  it('lets a customer set up an authenticator', async () => {
    server.use(
      http.get(apiUrl('/auth/me'), () => ok(aMe({ mfaEnabled: false }))),
      http.post(apiUrl('/auth/mfa/setup'), () => ok(SETUP)),
      http.post(apiUrl('/auth/mfa/enable'), () => ok({ tokens: { accessToken: makeAccessToken({ mfa: true }), expiresInSeconds: 900 } }))
    );
    const { user, services } = renderWithApp(<SecurityPage />, { route: '/settings/security' });
    await user.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
    await user.type(screen.getByLabelText('Your password'), 'Customer-pass-1');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('6-digit code from the app'), '654321');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor authentication' }));
    await waitFor(() => expect(services.session.user?.mfa).toBe(true));
  });

  it('turns off a customer authenticator and signs out locally', async () => {
    server.use(
      http.get(apiUrl('/auth/me'), () => ok(aMe({ mfaEnabled: true }))),
      http.post(apiUrl('/auth/mfa/disable'), () => ok(undefined))
    );
    const { user, services } = renderWithApp(<SecurityPage />, { route: '/settings/security', claims: { mfa: true } });
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Password'), 'Customer-pass-1');
    await user.type(within(dialog).getByLabelText('Authenticator code'), '111222');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off two-factor' }));
    await waitFor(() => expect(services.session.status).toBe('anonymous'));
  });

  it('shows staff that two-factor is mandatory', async () => {
    server.use(http.get(apiUrl('/auth/me'), () => ok(aMe({ role: 'TELLER', mfaEnabled: true }))));
    renderWithApp(<SecurityPage />, { role: 'TELLER', route: '/settings/security' });
    expect(await screen.findByText(/required for all staff/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
  });
});
