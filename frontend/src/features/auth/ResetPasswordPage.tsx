import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { LockKeyhole } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/primitives';
import { AuthHeading, AuthIcon } from '@/components/layout/AuthLayout';
import { useFragmentToken } from './fragment';
import { applyFieldErrors, NewPasswordFields, newPasswordShape, refineMatch } from './components/PasswordFields';

const schema = refineMatch(z.object(newPasswordShape));
type Values = z.infer<typeof schema>;

function ExpiredLink() {
  return (
    <Callout
      tone="danger"
      title="Link expired or already used"
      action={
        <Button asChild size="sm" variant="outline">
          <Link to="/forgot-password">Request a new link</Link>
        </Button>
      }
    >
      Reset links work once and expire after 30 minutes.
    </Callout>
  );
}

export default function ResetPasswordPage() {
  const { api, status, endLocalSession } = useAuth();
  const navigate = useNavigate();
  const token = useFragmentToken();
  const [problem, setProblem] = useState<{ code?: string; title: string; description: string } | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: '', confirm: '' } });

  const onSubmit = form.handleSubmit(async ({ password }) => {
    if (!token) return;
    setProblem(null);
    try {
      await api.auth.resetPassword(token, password);
      // The server ended every session, including any on this device
      if (status === 'authenticated') endLocalSession();
      navigate('/login', { replace: true, state: { passwordReset: true } });
    } catch (error) {
      if (isApiError(error) && applyFieldErrors(form, error.fieldErrors, { newPassword: 'password' })) return;
      setProblem({ code: isApiError(error) ? error.code : undefined, ...describeError(error) });
    }
  });

  return (
    <div>
      <AuthHeading
        icon={<AuthIcon><LockKeyhole aria-hidden="true" /></AuthIcon>}
        title="Choose a new password"
        description="For your security, this signs you out on every device."
      />
      {!token || problem?.code === 'INVALID_OR_EXPIRED_TOKEN' ? (
        <ExpiredLink />
      ) : (
        <>
          {problem ? (
            <Callout tone="danger" className="mb-5" title={problem.title}>
              {problem.description}
            </Callout>
          ) : null}
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <NewPasswordFields form={form} label="New password" confirmLabel="Confirm new password" />
            <Button type="submit" block size="lg" loading={form.formState.isSubmitting}>
              Set new password
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
