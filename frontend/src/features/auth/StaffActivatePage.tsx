import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BriefcaseBusiness } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/primitives';
import { AuthHeading, AuthIcon } from '@/components/layout/AuthLayout';
import { useFragmentToken } from './fragment';
import { setEnrolmentToken } from './enrolment';
import { applyFieldErrors, NewPasswordFields, newPasswordShape, refineMatch } from './components/PasswordFields';

const schema = refineMatch(z.object(newPasswordShape));
type Values = z.infer<typeof schema>;

/** A new staff member sets their own password from the emailed link; administrators never know it */
export default function StaffActivatePage() {
  const { api, applyTokens } = useAuth();
  const navigate = useNavigate();
  const token = useFragmentToken();
  const [problem, setProblem] = useState<{ title: string; description: string } | null>(
    token ? null : { title: 'Activation link not valid', description: 'Open the most recent activation email from BankSphere.' }
  );
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: '', confirm: '' } });

  const onSubmit = form.handleSubmit(async ({ password }) => {
    if (!token) return;
    setProblem(null);
    try {
      const result = await api.auth.activateStaff(token, password);
      setEnrolmentToken(result.enrolmentToken);
      applyTokens(result.tokens);
      navigate('/mfa/enrol', { replace: true });
    } catch (error) {
      if (isApiError(error) && applyFieldErrors(form, error.fieldErrors)) return;
      if (isApiError(error) && error.code === 'INVALID_OR_EXPIRED_TOKEN') {
        setProblem({
          title: 'Activation link expired',
          description: 'Activation links work once and expire after 24 hours. Ask an administrator to send a new activation request.',
        });
        return;
      }
      setProblem(describeError(error));
    }
  });

  return (
    <div>
      <AuthHeading
        icon={<AuthIcon><BriefcaseBusiness aria-hidden="true" /></AuthIcon>}
        title="Activate your staff account"
        description="Choose your password. Next, you’ll connect an authenticator app — it’s required for every staff sign-in."
      />
      {problem ? (
        <Callout tone="danger" className="mb-5" title={problem.title}>
          {problem.description}
        </Callout>
      ) : null}
      {token ? (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <NewPasswordFields form={form} label="Choose a password" />
          <Button type="submit" block size="lg" loading={form.formState.isSubmitting}>
            Activate account
          </Button>
        </form>
      ) : null}
    </div>
  );
}
