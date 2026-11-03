import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Check, CheckCircle2, CircleAlert } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { describeError, isApiError, type ErrorDescription } from '@/lib/api/errors';
import { qk } from '@/lib/query';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { ROLE_INFO, STAFF_ROLES } from './roles';

const schema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter their corporate email address')
    .max(254, 'Use at most 254 characters')
    .email('Enter a valid email address'),
  role: z.enum(STAFF_ROLES, { error: 'Choose a role' }),
});
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

/** Four-eyes staff onboarding: one administrator asks, a second approves, the colleague activates by email */
export function RequestStaffDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [sent, setSent] = useState<string | null>(null);
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setSent(null);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="lg">
        <DialogHeader
          title="Request a new staff member"
          description="A second administrator approves it. They then set their own password and authenticator from an activation email."
        />
        {sent ? (
          <Sent email={sent} onAnother={() => setSent(null)} onDone={() => close(false)} />
        ) : (
          <StaffForm onSent={setSent} onCancel={() => close(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Sent({ email, onAnother, onDone }: { email: string; onAnother: () => void; onDone: () => void }) {
  return (
    <>
      <div role="status" className="rounded-2xl bg-muted/60 px-5 py-6 text-center">
        <CheckCircle2 className="mx-auto size-9 text-success" strokeWidth={1.6} aria-hidden="true" />
        <p className="mt-3 text-headline">Sent for approval</p>
        <p className="mx-auto mt-1.5 max-w-md text-pretty text-[14px] leading-5 text-muted-foreground">
          A second administrator must approve this request. Once approved, <span className="font-medium text-foreground">{email}</span> receives an
          activation email to set their own password and authenticator. Administrators never see staff passwords.
        </p>
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onAnother}>
          Request another
        </Button>
        <Button onClick={onDone} autoFocus>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function StaffForm({ onSent, onCancel }: { onSent: (email: string) => void; onCancel: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const id = useId();
  const [problem, setProblem] = useState<ErrorDescription | null>(null);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const roleErrorId = `${id}-role-error`;

  const onSubmit = form.handleSubmit(async ({ email, role }) => {
    setProblem(null);
    try {
      await api.admin.requestStaff(email, role);
      void queryClient.invalidateQueries({ queryKey: qk.adminRequestsAll });
      onSent(email);
    } catch (error) {
      if (isApiError(error)) {
        if (error.code === 'STAFF_EMAIL_DOMAIN') {
          // The service names the required domain ("…must use an @bank.example address"): more useful than the generic copy
          const message = error.message.includes('@') ? error.message : describeError(error).description;
          form.setError('email', { message }, { shouldFocus: true });
          return;
        }
        if (error.code === 'CONFLICT') {
          form.setError('email', { message: 'An account with this email already exists.' }, { shouldFocus: true });
          return;
        }
        if (error.code === 'INVALID_ROLE') {
          form.setError('role', { message: 'Choose one of the staff roles.' });
          return;
        }
        const fields = error.fieldErrors;
        if (error.code === 'VALIDATION_ERROR' && (fields.email || fields.role)) {
          if (fields.email) form.setError('email', { message: fields.email });
          if (fields.role) form.setError('role', { message: fields.role });
          return;
        }
      }
      setProblem(describeError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {problem ? (
        <Callout tone="danger" title={problem.title}>
          {problem.description}
          {problem.reference ? ` (Ref: ${problem.reference})` : null}
        </Callout>
      ) : null}
      <Field
        label="Corporate email"
        error={errors.email?.message}
        hint="Their address on the bank’s email domain. The activation email goes here."
      >
        {(p) => (
          <Input {...p} {...form.register('email')} type="email" inputMode="email" autoComplete="off" spellCheck={false} autoFocus />
        )}
      </Field>

      <fieldset aria-describedby={errors.role ? roleErrorId : undefined}>
        <legend className="text-[13px] font-medium text-foreground">Role</legend>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {STAFF_ROLES.map((role) => {
            const info = ROLE_INFO[role];
            return (
              <label
                key={role}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-background p-4 transition-[border-color,background-color] duration-150 hover:border-foreground/20',
                  'has-[:checked]:border-primary has-[:checked]:bg-primary-soft/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-popover',
                  role === 'BANK_ADMIN' && 'sm:col-span-2'
                )}
              >
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span id={`${id}-${role}-label`} className="block text-[15px] font-medium leading-5 tracking-[-0.01em]">
                    {info.label}
                  </span>
                  <span id={`${id}-${role}-description`} className="block text-[13px] leading-[18px] text-muted-foreground">
                    {info.description}
                  </span>
                </span>
                {/* A real radio, drawn as a check circle: it stays clickable and keyboard-operable */}
                <span className="relative mt-px size-[22px] shrink-0">
                  <input
                    type="radio"
                    value={role}
                    {...form.register('role')}
                    aria-labelledby={`${id}-${role}-label`}
                    aria-describedby={`${id}-${role}-description`}
                    className="peer absolute inset-0 size-[22px] cursor-pointer appearance-none rounded-full border-[1.5px] border-input bg-background transition-colors checked:border-primary checked:bg-primary focus-visible:outline-none focus-visible:ring-0"
                  />
                  <Check
                    className="pointer-events-none absolute inset-0 m-auto size-3.5 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100"
                    strokeWidth={3}
                    aria-hidden="true"
                  />
                </span>
              </label>
            );
          })}
        </div>
        {errors.role ? (
          <p id={roleErrorId} role="alert" className="mt-2 flex items-start gap-1.5 text-[13px] font-medium leading-[18px] text-destructive">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {errors.role.message}
          </p>
        ) : null}
      </fieldset>

      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={isSubmitting}>
          Send for approval
        </Button>
      </DialogFooter>
    </form>
  );
}
