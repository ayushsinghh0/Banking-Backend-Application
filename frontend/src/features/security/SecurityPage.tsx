import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { LogOut, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { useAuth, useUser } from '@/lib/auth/AuthProvider';
import { isStaffRole } from '@/lib/auth/session';
import { describeError, isApiError } from '@/lib/api/errors';
import { qk } from '@/lib/query';
import { notifySuccess } from '@/lib/notify';
import { passwordSchema, totpSchema } from '@/lib/validation';
import { ROLE_LABEL } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { Field, OtpInput, PasswordInput } from '@/components/ui/input';
import { Badge, Callout, DescriptionList, PageHeader, Skeleton } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { ErrorState } from '@/components/ui/data';
import { PasswordChecklist } from '@/features/auth/components/PasswordFields';
import { AuthenticatorSetup } from './AuthenticatorSetup';
import { Section } from './Section';
import { SessionsSection } from './SessionsSection';
import { SignInActivity } from './SignInActivity';

const changeSchema = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password'), password: passwordSchema, confirm: z.string().min(1, 'Confirm your new password') })
  .refine((v) => v.password === v.confirm, { message: 'Passwords don’t match', path: ['confirm'] })
  .refine((v) => v.password !== v.currentPassword, { message: 'Choose a password you haven’t used here', path: ['password'] });
type ChangeValues = z.infer<typeof changeSchema>;

function ChangePassword() {
  const { api, applyTokens } = useAuth();
  const [problem, setProblem] = useState<{ title: string; description: string } | null>(null);
  const form = useForm<ChangeValues>({ resolver: zodResolver(changeSchema), defaultValues: { currentPassword: '', password: '', confirm: '' } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ currentPassword, password }) => {
    setProblem(null);
    try {
      const { tokens } = await api.auth.changePassword(currentPassword, password);
      applyTokens(tokens);
      form.reset();
      notifySuccess('Password updated', 'Every other device has been signed out.');
    } catch (error) {
      if (isApiError(error) && error.code === 'INVALID_PASSWORD') {
        form.setError('currentPassword', { message: 'The current password is incorrect' });
      } else if (isApiError(error) && error.code === 'PASSWORD_REUSED') {
        form.setError('password', { message: 'Choose a password you haven’t used here' });
      } else {
        setProblem(describeError(error));
      }
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid max-w-md gap-5" noValidate>
      {problem ? (
        <Callout tone="danger" title={problem.title}>
          {problem.description}
        </Callout>
      ) : null}
      <Field label="Current password" error={errors.currentPassword?.message}>
        {(p) => <PasswordInput {...p} {...form.register('currentPassword')} autoComplete="current-password" />}
      </Field>
      <Field label="New password" error={errors.password?.message}>
        {(p) => <PasswordInput {...p} {...form.register('password')} autoComplete="new-password" />}
      </Field>
      <PasswordChecklist value={form.watch('password')} />
      <Field label="Confirm new password" error={errors.confirm?.message}>
        {(p) => <PasswordInput {...p} {...form.register('confirm')} autoComplete="new-password" />}
      </Field>
      <div className="pt-1">
        <Button type="submit" loading={isSubmitting}>
          Update password
        </Button>
      </div>
    </form>
  );
}

const disableSchema = z.object({ password: z.string().min(1, 'Enter your password'), code: totpSchema });

function DisableMfaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { api, endLocalSession } = useAuth();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string>();
  const form = useForm<{ password: string; code: string }>({ resolver: zodResolver(disableSchema), defaultValues: { password: '', code: '' } });
  const onSubmit = form.handleSubmit(async ({ password, code }) => {
    setProblem(undefined);
    try {
      await api.auth.mfaDisable(password, code);
      // The server signed every session out
      endLocalSession();
      navigate('/login', { replace: true });
    } catch (error) {
      form.setValue('code', '');
      setProblem(
        isApiError(error) && (error.code === 'INVALID_PASSWORD' || error.code === 'INVALID_MFA_CODE')
          ? 'The password or code is incorrect.'
          : describeError(error).description
      );
    }
  });
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent size="sm">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader
            title="Turn off two-factor authentication?"
            description="Your account will be protected by your password alone, high-value actions will be unavailable, and you’ll be signed out everywhere."
          />
          {problem ? <Callout tone="danger" title={problem} /> : null}
          <Field label="Password" error={form.formState.errors.password?.message}>
            {(p) => <PasswordInput {...p} {...form.register('password')} autoComplete="current-password" />}
          </Field>
          <Field label="Authenticator code" error={form.formState.errors.code?.message}>
            {(p) => <OtpInput {...p} value={form.watch('code')} onValueChange={(v) => form.setValue('code', v)} />}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Keep it on
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting}>
              Turn off two-factor
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const user = useUser();
  const queryClient = useQueryClient();
  const [settingUp, setSettingUp] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const staff = isStaffRole(user.role);

  if (enabled) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-[22px] shrink-0 text-success" strokeWidth={1.75} aria-hidden="true" />
            <div>
              <p className="text-[15px] font-medium">Authenticator app is on</p>
              <p className="text-[13px] leading-[18px] text-muted-foreground">
                {user.mfaSince ? `Added ${format(new Date(user.mfaSince * 1000), 'd MMM yyyy')}. ` : ''}
                Codes are required at sign-in and for high-value actions.
              </p>
            </div>
          </div>
          {staff ? null : (
            <Button variant="secondary" size="sm" onClick={() => setDisabling(true)}>
              <ShieldOff aria-hidden="true" /> Turn off
            </Button>
          )}
        </div>
        {staff ? (
          <p className="border-t pt-4 text-[13px] leading-[18px] text-muted-foreground">
            Two-factor authentication is required for all staff. If you lose your phone, two administrators must approve a reset.
          </p>
        ) : null}
        <DisableMfaDialog open={disabling} onOpenChange={setDisabling} />
      </div>
    );
  }

  if (settingUp) {
    return (
      <div className="max-w-xl">
        <AuthenticatorSetup
          onCancel={() => setSettingUp(false)}
          onComplete={() => {
            setSettingUp(false);
            void queryClient.invalidateQueries({ queryKey: qk.me });
            notifySuccess('Two-factor authentication is on', 'Other devices were signed out. Use your app’s code next time you sign in.');
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex max-w-lg items-start gap-3">
        <ShieldAlert className="mt-0.5 size-[22px] shrink-0 text-warning" strokeWidth={1.75} aria-hidden="true" />
        <div>
        <p className="text-[15px] font-medium">Protect your money with an authenticator app</p>
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          Needed for transfers of ₹1,00,000 or more, instant payees and large cash withdrawals.
        </p>
        </div>
      </div>
      <Button onClick={() => setSettingUp(true)}>Set up authenticator</Button>
    </div>
  );
}

export default function SecurityPage() {
  const { api, signOut, user } = useAuth();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: qk.me, queryFn: () => api.auth.me() });
  // Turning off two-factor ends every session: render nothing on the way to the sign-in page
  if (!user) return null;

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader title="Security" description="Manage how you sign in and keep your account protected." />
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12 lg:gap-6">
        <div className="space-y-5 lg:col-span-8 lg:space-y-6">
          <Section title="Password" description="Use a long, unique password. Changing it signs out your other devices.">
            <ChangePassword />
          </Section>
          <Section
            title="Two-factor authentication"
            description="A second step at sign-in using codes from your phone."
            aside={me.data ? <Badge tone={me.data.mfaEnabled ? 'success' : 'warning'} dot>{me.data.mfaEnabled ? 'On' : 'Off'}</Badge> : null}
          >
            {me.isPending ? <Skeleton className="h-20 w-full" /> : me.isError ? <ErrorState error={me.error} onRetry={() => void me.refetch()} /> : <TwoFactor enabled={me.data.mfaEnabled} />}
          </Section>
          <SessionsSection />
          <SignInActivity />
        </div>
        <div className="space-y-5 lg:col-span-4 lg:space-y-6">
          <Section title="Account" description="Your sign-in identity.">
            <DescriptionList
              items={[
                { label: 'Email', value: user.email },
                { label: 'Role', value: ROLE_LABEL[user.role] },
                { label: 'Member since', value: me.data ? format(new Date(me.data.createdAt), 'd MMM yyyy') : '—' },
                {
                  label: 'Password changed',
                  value: me.data?.passwordChangedAt ? format(new Date(me.data.passwordChangedAt), 'd MMM yyyy') : 'Never',
                },
              ]}
            />
          </Section>
          <Section title="This device" description="Sessions end automatically after inactivity.">
            <Button
              variant="secondary"
              block
              onClick={async () => {
                await signOut();
                navigate('/login', { replace: true, state: { signedOut: true } });
              }}
            >
              <LogOut aria-hidden="true" /> Sign out of this device
            </Button>
          </Section>
        </div>
      </div>
    </div>
  );
}
