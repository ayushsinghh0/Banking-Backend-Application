import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { decodeAccessToken } from '@/lib/auth/session';
import { describeError, isApiError } from '@/lib/api/errors';
import { emailSchema, totpSchema } from '@/lib/validation';
import { HOME } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input, OtpInput, PasswordInput } from '@/components/ui/input';
import { Callout } from '@/components/ui/primitives';
import { AuthHeading, AuthIcon } from '@/components/layout/AuthLayout';
import { BrandMark } from '@/components/layout/Brand';

const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
});
type Credentials = z.infer<typeof credentialsSchema>;

type Problem =
  | { kind: 'credentials' }
  | { kind: 'unverified'; email: string }
  | { kind: 'protected' }
  | { kind: 'other'; title: string; description: string };

function problemFrom(error: unknown, email: string): Problem {
  if (isApiError(error)) {
    if (error.status === 401) return { kind: 'credentials' };
    if (error.code === 'EMAIL_NOT_VERIFIED') return { kind: 'unverified', email };
    if (error.code === 'LOGIN_STEP_UP_REQUIRED') return { kind: 'protected' };
  }
  const { title, description } = describeError(error);
  return { kind: 'other', title, description };
}

export default function LoginPage() {
  const { api, completeLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { from?: string; signedOut?: boolean; passwordReset?: boolean } | null;
  const [challenge, setChallenge] = useState<{ token: string; email: string } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [resent, setResent] = useState(false);

  const form = useForm<Credentials>({ resolver: zodResolver(credentialsSchema), defaultValues: { email: '', password: '' } });

  const finish = (accessToken: string) => {
    const user = decodeAccessToken(accessToken);
    const from = state?.from && state.from !== '/login' ? state.from : undefined;
    navigate(from ?? (user ? HOME[user.role] : '/'), { replace: true });
  };

  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setProblem(null);
    setResent(false);
    try {
      const result = await api.auth.login(email, password);
      const pending = completeLogin(result);
      if (pending) {
        setChallenge({ token: pending.challengeToken, email });
        return;
      }
      if (!('tokens' in result)) return;
      finish(result.tokens.accessToken);
    } catch (error) {
      setProblem(problemFrom(error, email));
      form.resetField('password');
    }
  });

  if (challenge) {
    return (
      <MfaStep
        challengeToken={challenge.token}
        onBack={() => {
          setChallenge(null);
          form.reset({ email: challenge.email, password: '' });
        }}
        onExpired={() => {
          setChallenge(null);
          setProblem({ kind: 'other', title: 'Verification timed out', description: 'Sign in again to get a new verification step.' });
        }}
        onSuccess={finish}
      />
    );
  }

  const { errors, isSubmitting } = form.formState;
  return (
    <div>
      <AuthHeading icon={<BrandMark className="size-12" />} title="Welcome back" description="Sign in to manage your accounts and payments." />
      {state?.signedOut ? <Callout tone="success" className="mb-5" title="You have been signed out" /> : null}
      {state?.passwordReset ? (
        <Callout tone="success" className="mb-5" title="Password updated">
          Sign in with your new password.
        </Callout>
      ) : null}
      {problem ? <ProblemCallout problem={problem} resent={resent} onResend={async (email) => {
        try {
          await api.auth.resendVerification(email);
        } finally {
          setResent(true);
        }
      }} /> : null}
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <Field label="Email" error={errors.email?.message}>
          {(p) => <Input {...p} {...form.register('email')} type="email" autoComplete="username" inputMode="email" autoFocus />}
        </Field>
        <Field
          label="Password"
          error={errors.password?.message}
          labelAside={
            <Link to="/forgot-password" className="text-[13px] font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          }
        >
          {(p) => <PasswordInput {...p} {...form.register('password')} autoComplete="current-password" />}
        </Field>
        <Button type="submit" block size="lg" loading={isSubmitting} className="!mt-7">
          Sign in
        </Button>
      </form>
      <p className="mt-8 text-center text-[14px] text-muted-foreground">
        New to BankSphere?{' '}
        <Link to="/register" className="font-medium text-primary hover:underline">
          Open an account
        </Link>
      </p>
    </div>
  );
}

function ProblemCallout({ problem, resent, onResend }: { problem: Problem; resent: boolean; onResend: (email: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  switch (problem.kind) {
    case 'credentials':
      return <Callout tone="danger" className="mb-5" title="The email or password is incorrect." />;
    case 'protected':
      return (
        <Callout tone="warning" className="mb-5" title="Account protected">
          There were too many failed sign-in attempts. To keep your money safe,{' '}
          <Link to="/forgot-password" className="font-medium text-primary underline-offset-2 hover:underline">
            reset your password
          </Link>{' '}
          by email to continue.
        </Callout>
      );
    case 'unverified':
      return (
        <Callout tone="warning" className="mb-5" title="Verify your email first">
          {resent ? (
            'A new verification link is on its way. Use the most recent email.'
          ) : (
            <>
              Open the link we emailed you.{' '}
              <Button
                variant="link"
                className="text-[13px]"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  await onResend(problem.email).catch(() => undefined);
                  setBusy(false);
                }}
              >
                Resend verification email
              </Button>
            </>
          )}
        </Callout>
      );
    default:
      return (
        <Callout tone="danger" className="mb-5" title={problem.title}>
          {problem.description}
        </Callout>
      );
  }
}

const codeSchema = z.object({ code: totpSchema });

function MfaStep({
  challengeToken,
  onBack,
  onExpired,
  onSuccess,
}: {
  challengeToken: string;
  onBack: () => void;
  onExpired: () => void;
  onSuccess: (accessToken: string) => void;
}) {
  const { api, completeLogin } = useAuth();
  const [error, setError] = useState<string>();
  const [attempts, setAttempts] = useState(0);
  const form = useForm<{ code: string }>({ resolver: zodResolver(codeSchema), defaultValues: { code: '' } });

  const onSubmit = form.handleSubmit(async ({ code }) => {
    setError(undefined);
    try {
      const result = await api.auth.loginMfa(challengeToken, code);
      completeLogin(result);
      onSuccess(result.tokens.accessToken);
    } catch (e) {
      form.setValue('code', '');
      if (isApiError(e) && e.status === 401) {
        // The challenge allows a few attempts; after that it is gone and the password step starts again
        if (attempts >= 4) return onExpired();
        setAttempts((n) => n + 1);
        setError('That code is incorrect or has expired. Enter the current code from your app.');
        return;
      }
      setError(describeError(e).description);
    }
  });

  return (
    <div>
      <AuthHeading
        icon={<AuthIcon><KeyRound aria-hidden="true" /></AuthIcon>}
        title="Two-factor verification"
        description="Open your authenticator app and enter the 6-digit code for BankSphere."
      />
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <Field label="Authenticator code" error={error ?? form.formState.errors.code?.message}>
          {(p) => (
            <OtpInput
              {...p}
              autoFocus
              value={form.watch('code')}
              onValueChange={(v) => form.setValue('code', v, { shouldValidate: form.formState.isSubmitted })}
            />
          )}
        </Field>
        <Button type="submit" block size="lg" loading={form.formState.isSubmitting}>
          Verify
        </Button>
      </form>
      <Button variant="ghost" className="mt-4 w-full text-muted-foreground" onClick={onBack}>
        <ArrowLeft aria-hidden="true" /> Use a different account
      </Button>
    </div>
  );
}
