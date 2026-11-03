import { forwardRef, useId, useState, type InputHTMLAttributes } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { describeError, isApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { formatPaise } from '@/lib/money';
import { notifySuccess } from '@/lib/notify';
import { accountNumberSchema } from '@/lib/validation';
import { cn } from '@/lib/cn';
import { useStepUp } from '@/features/security/StepUp';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { POLICY, formatDateTime, formatTime } from '../lib';

const schema = z.object({
  accountNumber: accountNumberSchema,
  nickname: z.string().trim().min(1, 'Enter a nickname').max(60, 'Use 60 characters or fewer'),
  instant: z.boolean(),
});
type FormInput = z.input<typeof schema>;
type Values = z.output<typeof schema>;

const readyAt = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDateTime(iso));

/**
 * Registers a payee. New payees activate after a cooling-off period, unless the customer approves them with
 * a fresh authenticator code (then the server activates them at once).
 */
export function AddPayeeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { api, user } = useAuth();
  const { ensureFresh } = useStepUp();
  const queryClient = useQueryClient();
  const hasAuthenticator = Boolean(user?.mfa);
  const instantId = useId();
  const [problem, setProblem] = useState<{ title: string; description: string } | null>(null);
  /** Instant approval was declined: the details wait for the customer to choose the normal route */
  const [declined, setDeclined] = useState<Values | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm<FormInput, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { accountNumber: '', nickname: '', instant: false },
  });
  const { errors } = form.formState;

  const change = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      form.reset();
      setProblem(null);
      setDeclined(null);
    }
  };

  const add = async (values: Values, instantRequested: boolean) => {
    setBusy(true);
    setProblem(null);
    setDeclined(null);
    try {
      const payee = await api.ledger.addBeneficiary(values.accountNumber, values.nickname);
      void queryClient.invalidateQueries({ queryKey: qk.beneficiaries });
      const activeNow = new Date(payee.activatesAt).getTime() <= Date.now() + 5_000;
      notifySuccess(
        `${payee.nickname} added`,
        activeNow
          ? 'They’re ready to pay now.'
          : instantRequested
            ? `Your authenticator is too new to skip the wait, so they’ll be ready to pay at ${readyAt(payee.activatesAt)}.`
            : `They’ll be ready to pay at ${readyAt(payee.activatesAt)}, after the cooling-off period.`
      );
      setBusy(false);
      change(false);
    } catch (error) {
      setBusy(false);
      if (!isApiError(error)) {
        setProblem(describeError(error));
        return;
      }
      switch (error.code) {
        case 'INVALID_DESTINATION':
          // Same answer whatever the reason, so account numbers can't be probed
          form.setError('accountNumber', { message: 'This account can’t be added. Check the number with the person you’re paying.' });
          return;
        case 'OWN_ACCOUNT':
          form.setError('accountNumber', { message: 'That’s one of your own accounts. You can transfer to it without adding it as a payee.' });
          return;
        case 'CONFLICT':
          form.setError('accountNumber', { message: 'This account is already one of your payees.' });
          return;
        case 'VALIDATION_ERROR': {
          const fields = error.fieldErrors;
          if (fields.accountNumber) form.setError('accountNumber', { message: 'Account numbers are 12 digits' });
          if (fields.nickname) form.setError('nickname', { message: 'Use a nickname of 1 to 60 characters' });
          if (!fields.accountNumber && !fields.nickname) setProblem(describeError(error));
          return;
        }
        case 'RATE_LIMIT_EXCEEDED':
          if (/today/i.test(error.message)) {
            setProblem({
              title: 'Too many payees added today',
              description: 'For your security, you can only add a limited number of payees each day. Please try again tomorrow.',
            });
            return;
          }
          setProblem(describeError(error));
          return;
        default:
          setProblem(describeError(error));
      }
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    if (busy) return;
    if (values.instant) {
      setBusy(true);
      const approved = await ensureFresh();
      setBusy(false);
      if (!approved) {
        setDeclined(values);
        return;
      }
    }
    await add(values, values.instant);
  });

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader title="Add a payee" description="Add someone’s BankSphere account once, then pay them whenever you need to." />
          <Field label="Account number" error={errors.accountNumber?.message} hint="The 12-digit number of the account you’ll pay">
            {(p) => (
              <Input
                {...p}
                {...form.register('accountNumber')}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                placeholder="1001 2345 6789"
                className="tracking-[0.06em] tnum"
              />
            )}
          </Field>
          <Field label="Nickname" error={errors.nickname?.message} hint="So you can recognise them, for example “Ravi (landlord)”">
            {(p) => <Input {...p} {...form.register('nickname')} maxLength={60} autoComplete="off" />}
          </Field>

          <div className="space-y-2">
            <label
              htmlFor={instantId}
              className={cn(
                'flex items-center gap-4 rounded-2xl bg-muted/70 p-4 transition-colors',
                hasAuthenticator ? 'cursor-pointer hover:bg-muted' : 'cursor-not-allowed opacity-60'
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium tracking-[-0.01em]">Activate now with my authenticator</span>
                <span className="mt-0.5 block text-[13px] leading-[18px] text-muted-foreground">
                  Skip the {POLICY.payeeCoolingMinutes}-minute wait by confirming with a code from your authenticator app.
                </span>
              </span>
              <Switch id={instantId} disabled={!hasAuthenticator} {...form.register('instant')} />
            </label>
            {hasAuthenticator ? null : (
              <p className="px-1 text-[13px] text-muted-foreground">
                <Link to="/settings/security" className="font-medium text-primary hover:underline">
                  Turn on two-factor authentication
                </Link>{' '}
                to approve new payees instantly.
              </p>
            )}
          </div>

          <p className="text-[13px] leading-[18px] text-muted-foreground">
            In a new payee’s first 24 hours you can send them up to {formatPaise(POLICY.newPayeeLimitPaise)} in total.
          </p>

          {declined ? (
            <Callout tone="warning" title="Not approved with your authenticator">
              <span className="block">
                You can still add {declined.nickname} now. They’ll be ready to pay after the usual {POLICY.payeeCoolingMinutes}-minute
                cooling-off period.
              </span>
              <span className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void add(declined, false)} loading={busy}>
                  Add with cooling-off period
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeclined(null)} disabled={busy}>
                  Not now
                </Button>
              </span>
            </Callout>
          ) : null}
          {problem ? (
            <Callout tone="danger" title={problem.title}>
              {problem.description}
            </Callout>
          ) : null}

          <DialogFooter>
            <Button variant="secondary" size="lg" onClick={() => change(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="lg" loading={busy && !declined}>
              Add payee
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An iOS-style switch drawn around a real checkbox, so labels, keyboard and form libraries just work */
const Switch = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) => (
  <span className={cn('relative inline-flex h-[31px] w-[51px] shrink-0', className)}>
    <input
      ref={ref}
      type="checkbox"
      className="peer absolute inset-0 z-10 m-0 cursor-pointer appearance-none rounded-full opacity-0 disabled:cursor-not-allowed"
      {...props}
    />
    <span
      aria-hidden="true"
      className="absolute inset-0 rounded-full bg-foreground/15 transition-colors duration-200 peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-popover"
    />
    <span
      aria-hidden="true"
      className="absolute left-[2px] top-[2px] size-[27px] rounded-full bg-white shadow-thumb transition-transform duration-200 ease-spring peer-checked:translate-x-5"
    />
  </span>
));
Switch.displayName = 'Switch';
