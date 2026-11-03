import { useState } from 'react';
import { http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { makeAccessToken } from '@/test/tokens';
import { ApiError } from '@/lib/api/errors';
import { useStepUp } from './StepUp';

const stepUpRequired = () => new ApiError({ status: 403, code: 'STEP_UP_REQUIRED', message: 'Step-up required' });

function Harness({ action }: { action: () => Promise<string> }) {
  const { run } = useStepUp();
  const [result, setResult] = useState('idle');
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          try {
            setResult(await run(action));
          } catch (e) {
            setResult(`error:${(e as ApiError).code ?? 'unknown'}`);
          }
        }}
      >
        Send
      </button>
      <output>{result}</output>
    </>
  );
}

function EnsureHarness() {
  const { ensureFresh } = useStepUp();
  const [result, setResult] = useState('idle');
  return (
    <>
      <button type="button" onClick={async () => setResult(String(await ensureFresh()))}>
        Approve instantly
      </button>
      <output>{result}</output>
    </>
  );
}

describe('ensureFresh', () => {
  it('resolves immediately when the session was stepped up moments ago', async () => {
    const { user } = renderWithApp(<EnsureHarness />, { claims: { mfa: true, stepUpAt: Math.floor(Date.now() / 1000) - 10 } });
    await user.click(screen.getByRole('button', { name: 'Approve instantly' }));
    expect(await screen.findByText('true')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks for a code otherwise', async () => {
    const fresh = makeAccessToken({ mfa: true, stepUpAt: Math.floor(Date.now() / 1000) });
    server.use(http.post(apiUrl('/auth/mfa/step-up'), () => ok({ accessToken: fresh, expiresInSeconds: 900 })));
    const { user } = renderWithApp(<EnsureHarness />, { claims: { mfa: true } });
    await user.click(screen.getByRole('button', { name: 'Approve instantly' }));
    await user.type(await screen.findByLabelText(/authenticator code/i), '112233');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByText('true')).toBeInTheDocument();
  });

  it('resolves false without an authenticator', async () => {
    const { user } = renderWithApp(<EnsureHarness />, { claims: { mfa: false } });
    await user.click(screen.getByRole('button', { name: 'Approve instantly' }));
    expect(await screen.findByText('false')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /turn on two-factor/i })).toBeInTheDocument();
  });
});

describe('useStepUp', () => {
  it('passes straight through when no step-up is needed', async () => {
    const action = vi.fn(async () => 'done');
    const { user } = renderWithApp(<Harness action={action} />, { claims: { mfa: true } });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('done')).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('asks for a code, upgrades the session and retries the same action once', async () => {
    const fresh = makeAccessToken({ mfa: true, stepUpAt: Math.floor(Date.now() / 1000) });
    let sentCode = '';
    server.use(
      http.post(apiUrl('/auth/mfa/step-up'), async ({ request }) => {
        sentCode = ((await request.json()) as { code: string }).code;
        return ok({ accessToken: fresh, expiresInSeconds: 900 });
      })
    );
    const action = vi.fn().mockRejectedValueOnce(stepUpRequired()).mockResolvedValueOnce('sent');
    const { user, services } = renderWithApp(<Harness action={action} />, { claims: { mfa: true } });

    await user.click(screen.getByRole('button', { name: 'Send' }));
    const dialog = await screen.findByRole('dialog', { name: /confirm it’s you/i });
    expect(dialog).toBeInTheDocument();
    await user.type(screen.getByLabelText(/authenticator code/i), '246810');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));

    expect(await screen.findByText('sent')).toBeInTheDocument();
    expect(sentCode).toBe('246810');
    expect(action).toHaveBeenCalledTimes(2);
    expect(services.session.getAccessToken()).toBe(fresh);
  });

  it('keeps the dialog open with an inline error for a wrong code', async () => {
    server.use(http.post(apiUrl('/auth/mfa/step-up'), () => fail(400, 'INVALID_MFA_CODE', 'The verification code is not valid')));
    const action = vi.fn().mockRejectedValue(stepUpRequired());
    const { user } = renderWithApp(<Harness action={action} />, { claims: { mfa: true } });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.type(await screen.findByLabelText(/authenticator code/i), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByText(/enter the current 6-digit code/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('rejects with the original error when the person cancels', async () => {
    const action = vi.fn().mockRejectedValue(stepUpRequired());
    const { user } = renderWithApp(<Harness action={action} />, { claims: { mfa: true } });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('error:STEP_UP_REQUIRED')).toBeInTheDocument();
  });

  it('explains that two-factor authentication must be set up first when the session has none', async () => {
    const action = vi.fn().mockRejectedValue(stepUpRequired());
    const { user } = renderWithApp(<Harness action={action} />, { claims: { mfa: false } });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('dialog', { name: /turn on two-factor authentication/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /set up authenticator/i })).toHaveAttribute('href', '/settings/security');
  });

  it('explains the waiting period when a brand-new authenticator still cannot approve', async () => {
    const fresh = makeAccessToken({ mfa: true, stepUpAt: Math.floor(Date.now() / 1000), mfaSince: Math.floor(Date.now() / 1000) - 60 });
    server.use(http.post(apiUrl('/auth/mfa/step-up'), () => ok({ accessToken: fresh, expiresInSeconds: 900 })));
    const action = vi.fn().mockRejectedValue(stepUpRequired());
    const { user } = renderWithApp(<Harness action={action} />, { claims: { mfa: true } });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.type(await screen.findByLabelText(/authenticator code/i), '135790');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    await waitFor(() => expect(screen.getByText('error:STEP_UP_REQUIRED')).toBeInTheDocument());
    expect(await screen.findByText(/recently added authenticator/i)).toBeInTheDocument();
  });
});
