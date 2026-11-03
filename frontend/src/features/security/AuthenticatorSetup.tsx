import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import QRCode from 'qrcode';
import { Smartphone } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import type { MfaSetup } from '@/lib/api/types';
import { totpSchema } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Field, OtpInput, PasswordInput } from '@/components/ui/input';
import { Callout, CopyButton, Skeleton } from '@/components/ui/primitives';

const passwordStep = z.object({ password: z.string().min(1, 'Enter your password') });
const codeStep = z.object({ code: totpSchema });

/** "JBSWY3DP…" -> "JBSW Y3DP …" for typing into an app by hand */
export const groupSecret = (secret: string) => secret.replace(/(.{4})(?=.)/g, '$1 ');

function QrImage({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    // Generated locally: the secret never goes to a third-party QR service
    QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b1222', light: '#ffffff' } })
      .then((svg) => !cancelled && setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => !cancelled && setSrc(undefined));
    return () => {
      cancelled = true;
    };
  }, [uri]);
  if (!src) return <Skeleton className="size-44 rounded-lg" />;
  return <img src={src} alt="QR code for your authenticator app" className="size-44 rounded-xl bg-white p-2.5 shadow-card" />;
}

export interface AuthenticatorSetupProps {
  /** Staff only: the one-time enrolment token */
  enrolmentToken?: string;
  onComplete: () => void;
  onCancel?: () => void;
}

/** Two steps: re-confirm the password, then scan and confirm a code. Ends with an MFA-upgraded session. */
export function AuthenticatorSetup({ enrolmentToken, onComplete, onCancel }: AuthenticatorSetupProps) {
  const { api, applyTokens } = useAuth();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [problem, setProblem] = useState<{ title: string; description: string } | null>(null);
  const pwForm = useForm<{ password: string }>({ resolver: zodResolver(passwordStep), defaultValues: { password: '' } });
  const codeForm = useForm<{ code: string }>({ resolver: zodResolver(codeStep), defaultValues: { code: '' } });

  const start = pwForm.handleSubmit(async ({ password }) => {
    setProblem(null);
    try {
      setSetup(await api.auth.mfaSetup(password, enrolmentToken));
    } catch (error) {
      pwForm.resetField('password');
      if (isApiError(error) && error.code === 'INVALID_PASSWORD') {
        pwForm.setError('password', { message: 'The password is incorrect' });
        return;
      }
      setProblem(describeError(error));
    }
  });

  const confirm = codeForm.handleSubmit(async ({ code }) => {
    setProblem(null);
    try {
      const { tokens } = await api.auth.mfaEnable(code, enrolmentToken);
      applyTokens(tokens);
      onComplete();
    } catch (error) {
      codeForm.setValue('code', '');
      if (isApiError(error) && error.code === 'INVALID_MFA_CODE') {
        codeForm.setError('code', { message: 'That code didn’t match. Check the time on your phone and use the newest code.' });
        return;
      }
      setProblem(describeError(error));
    }
  });

  if (!setup) {
    return (
      <form onSubmit={start} className="space-y-4" noValidate>
        {problem ? (
          <Callout tone="danger" title={problem.title}>
            {problem.description}
          </Callout>
        ) : null}
        <Field label="Your password" hint="We ask again before changing how you sign in." error={pwForm.formState.errors.password?.message}>
          {(p) => <PasswordInput {...p} {...pwForm.register('password')} autoComplete="current-password" autoFocus />}
        </Field>
        <div className="flex gap-2">
          {onCancel ? (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" loading={pwForm.formState.isSubmitting} className="flex-1">
            Continue
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={confirm} className="space-y-5" noValidate>
      {problem ? (
        <Callout tone="danger" title={problem.title}>
          {problem.description}
        </Callout>
      ) : null}
      <ol className="space-y-3.5 text-[15px] leading-[22px]">
        <li className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[12px] font-semibold text-foreground tnum">1</span>
          <span>
            Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) and add an account.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[12px] font-semibold text-foreground tnum">2</span>
          <span>Scan this QR code, or type the key by hand.</span>
        </li>
      </ol>
      <div className="flex flex-col items-center gap-5 rounded-2xl bg-muted/70 p-5 sm:flex-row sm:items-center">
        <QrImage uri={setup.otpauthUri} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="flex items-center gap-1.5 text-[13px] font-medium">
            <Smartphone className="size-4 text-muted-foreground" aria-hidden="true" /> Setup key
          </p>
          <div className="flex items-start gap-1">
            <code className="break-all rounded-lg bg-background px-2.5 py-1.5 font-mono text-[13.5px] tracking-wide">{groupSecret(setup.secret)}</code>
            <CopyButton value={setup.secret} label="Copy setup key" />
          </div>
          <p className="text-[12.5px] text-muted-foreground">Keep this key private. Anyone with it can generate your codes.</p>
        </div>
      </div>
      <Field label="6-digit code from the app" error={codeForm.formState.errors.code?.message}>
        {(p) => (
          <OtpInput
            {...p}
            value={codeForm.watch('code')}
            onValueChange={(v) => codeForm.setValue('code', v, { shouldValidate: codeForm.formState.isSubmitted })}
          />
        )}
      </Field>
      <Button type="submit" block size="lg" loading={codeForm.formState.isSubmitting}>
        Turn on two-factor authentication
      </Button>
    </form>
  );
}
