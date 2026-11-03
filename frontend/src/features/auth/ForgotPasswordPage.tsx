import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { KeyRound, MailCheck } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { describeError } from '@/lib/api/errors';
import { emailSchema } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/primitives';
import { AuthHeading, AuthIcon } from '@/components/layout/AuthLayout';

const schema = z.object({ email: emailSchema });

export default function ForgotPasswordPage() {
  const api = useApi();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ title: string; description: string } | null>(null);
  const form = useForm<{ email: string }>({ resolver: zodResolver(schema), defaultValues: { email: '' } });

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setProblem(null);
    try {
      await api.auth.forgotPassword(email);
      setSentTo(email);
    } catch (error) {
      setProblem(describeError(error));
    }
  });

  if (sentTo) {
    return (
      <div>
        <AuthHeading icon={<AuthIcon><MailCheck aria-hidden="true" /></AuthIcon>} title="Check your email" />
        <p className="-mt-4 mb-6 text-center text-[14px] text-muted-foreground">
          If an account exists for <span className="font-medium text-foreground">{sentTo}</span>, we’ve sent a link to reset the
          password. It works once and expires in 30 minutes.
        </p>
        <Button asChild block size="lg" variant="outline">
          <Link to="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div>
      <AuthHeading
        icon={<AuthIcon><KeyRound aria-hidden="true" /></AuthIcon>}
        title="Reset your password"
        description="Enter the email you sign in with and we’ll send you a secure reset link."
      />
      {problem ? (
        <Callout tone="danger" className="mb-5" title={problem.title}>
          {problem.description}
        </Callout>
      ) : null}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" error={form.formState.errors.email?.message}>
          {(p) => <Input {...p} {...form.register('email')} type="email" autoComplete="username" autoFocus />}
        </Field>
        <Button type="submit" block size="lg" loading={form.formState.isSubmitting}>
          Send reset link
        </Button>
      </form>
      <p className="mt-8 text-center text-[14px]">
        <Link to="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
