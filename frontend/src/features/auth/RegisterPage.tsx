import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MailCheck, UserPlus } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import { emailSchema } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/primitives';
import { AuthHeading, AuthIcon } from '@/components/layout/AuthLayout';
import { applyFieldErrors, NewPasswordFields, newPasswordShape, refineMatch } from './components/PasswordFields';

const schema = refineMatch(z.object({ email: emailSchema, ...newPasswordShape }));
type Values = z.infer<typeof schema>;

export default function RegisterPage() {
  const api = useApi();
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ title: string; description: string } | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '', confirm: '' } });

  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setProblem(null);
    try {
      await api.auth.register(email, password);
      setRegisteredEmail(email);
    } catch (error) {
      if (isApiError(error) && applyFieldErrors(form, error.fieldErrors)) return;
      setProblem(describeError(error));
    }
  });

  if (registeredEmail) {
    return (
      <div>
        <AuthHeading
          icon={<AuthIcon><MailCheck aria-hidden="true" /></AuthIcon>}
          title="Check your email"
          description="We’ve sent a verification link to"
        />
        <p className="-mt-4 mb-6 font-medium">{registeredEmail}</p>
        <Callout tone="info" title="Didn’t get it?">
          It can take a minute. Check your spam folder, or request a new link from the sign-in page. The link expires in 24 hours.
        </Callout>
        <Button asChild block size="lg" className="mt-6">
          <Link to="/login">Continue to sign in</Link>
        </Button>
      </div>
    );
  }

  const { errors, isSubmitting } = form.formState;
  return (
    <div>
      <AuthHeading
        icon={<AuthIcon><UserPlus aria-hidden="true" /></AuthIcon>}
        title="Open your BankSphere account"
        description="It takes two minutes. You’ll verify your email, then your identity."
      />
      {problem ? (
        <Callout tone="danger" className="mb-5" title={problem.title}>
          {problem.description}
        </Callout>
      ) : null}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" error={errors.email?.message}>
          {(p) => <Input {...p} {...form.register('email')} type="email" autoComplete="email" inputMode="email" autoFocus />}
        </Field>
        <NewPasswordFields form={form} />
        <Button type="submit" block size="lg" loading={isSubmitting}>
          Create account
        </Button>
        <p className="text-center text-[12.5px] text-muted-foreground">
          By continuing you agree to identity verification (KYC) as required by banking regulations.
        </p>
      </form>
      <p className="mt-8 text-center text-[14px] text-muted-foreground">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
