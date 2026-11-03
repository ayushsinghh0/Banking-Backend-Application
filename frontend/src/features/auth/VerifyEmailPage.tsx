import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BadgeCheck, MailWarning } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { emailSchema } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Callout, Spinner } from '@/components/ui/primitives';
import { AuthHeading, AuthIcon } from '@/components/layout/AuthLayout';
import { useFragmentToken } from './fragment';

type State = 'verifying' | 'verified' | 'invalid' | 'error';

const resendSchema = z.object({ email: emailSchema });

export default function VerifyEmailPage() {
  const api = useApi();
  const token = useFragmentToken();
  const [state, setState] = useState<State>(token ? 'verifying' : 'invalid');
  const started = useRef(false);

  useEffect(() => {
    // Effects run twice in development; a verification token works only once
    if (!token || started.current) return;
    started.current = true;
    api.auth
      .verifyEmail(token)
      .then(() => setState('verified'))
      .catch((error: { code?: string }) => setState(error?.code === 'INVALID_OR_EXPIRED_TOKEN' ? 'invalid' : 'error'));
  }, [api, token]);

  if (state === 'verifying') {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Spinner label="Verifying your email" />
        <p className="text-[15px] text-muted-foreground">Verifying your email…</p>
      </div>
    );
  }

  if (state === 'verified') {
    return (
      <div>
        <AuthHeading
          icon={<AuthIcon><BadgeCheck aria-hidden="true" /></AuthIcon>}
          title="Email verified"
          description="Thanks — your email address is confirmed. Sign in to finish setting up your profile."
        />
        <Button asChild block size="lg">
          <Link to="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  return <ResendVerification failedTemporarily={state === 'error'} />;
}

function ResendVerification({ failedTemporarily }: { failedTemporarily: boolean }) {
  const api = useApi();
  const [sent, setSent] = useState(false);
  const form = useForm<{ email: string }>({ resolver: zodResolver(resendSchema), defaultValues: { email: '' } });
  const onSubmit = form.handleSubmit(async ({ email }) => {
    await api.auth.resendVerification(email).catch(() => undefined);
    setSent(true);
  });
  return (
    <div>
      <AuthHeading
        icon={<AuthIcon><MailWarning aria-hidden="true" /></AuthIcon>}
        title={failedTemporarily ? 'We couldn’t verify right now' : 'This link has expired'}
        description={
          failedTemporarily
            ? 'Our servers didn’t respond. Try the link again in a moment, or request a fresh one.'
            : 'Verification links work once and expire after 24 hours. Request a new one below.'
        }
      />
      {sent ? (
        <Callout tone="success" title="Check your inbox">
          If the address can receive email, a new verification link is on its way.
        </Callout>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Email" error={form.formState.errors.email?.message}>
            {(p) => <Input {...p} {...form.register('email')} type="email" autoComplete="email" />}
          </Field>
          <Button type="submit" block size="lg" loading={form.formState.isSubmitting}>
            Send a new link
          </Button>
        </form>
      )}
      <p className="mt-8 text-center text-[14px]">
        <Link to="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
