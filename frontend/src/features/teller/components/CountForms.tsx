import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import { formatPaise } from '@/lib/money';
import { notifySuccess } from '@/lib/notify';
import { qk } from '@/lib/query';
import { rupeesSchema } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/input';
import { Callout, MoneyInput } from '@/components/ui/primitives';
import { LargeMoneyInput } from '@/features/branch/components/cash';
import { ConfirmDialog } from '@/components/ui/overlays';

/** Blind counts may legitimately be zero */
const countSchema = z.object({ counted: rupeesSchema({ allowZero: true }) });

function ProblemCallout({ error, className }: { error: unknown; className?: string }) {
  const { title, description, reference } = describeError(error);
  return (
    <Callout tone="danger" title={title} className={className}>
      {description}
      {reference ? <span className="block font-mono text-[11.5px]">Reference: {reference}</span> : null}
    </Callout>
  );
}

/**
 * Step 2 of the day: the teller counts the float they were handed and enters the total. The issued amount is
 * never shown, so the count is genuinely independent; only an exact match books the cash into the drawer.
 */
export function AcceptFloatForm() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(countSchema), defaultValues: { counted: '' } });

  const onSubmit = form.handleSubmit(async ({ counted }) => {
    setProblem(null);
    try {
      await api.teller.acceptFloat(counted);
      notifySuccess('Float accepted', 'Your cash desk is open.');
      await queryClient.invalidateQueries({ queryKey: qk.tellerSession });
    } catch (error) {
      setProblem(error);
      if (isApiError(error)) {
        if (error.code === 'FLOAT_MISMATCH') {
          // A recount is a fresh blind count: don't leave the old figure to be nudged
          form.reset({ counted: '' });
          form.setFocus('counted');
        } else if (error.fieldErrors.countedFloatPaise) {
          form.setError('counted', { message: error.fieldErrors.countedFloatPaise });
        } else if (error.code === 'CONFLICT') {
          void queryClient.invalidateQueries({ queryKey: qk.tellerSession });
        }
      }
    }
  });

  const mismatch = isApiError(problem) && problem.code === 'FLOAT_MISMATCH';
  const stale = isApiError(problem) && problem.code === 'STALE_TELLER_SESSION';

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {mismatch ? (
        <Callout tone="danger" title="Your count doesn’t match the float issued">
          <p>Nothing has been booked. Count the cash again, note by note, and enter the new total.</p>
          <p>If your recount still doesn’t match, don’t take the cash: ask your supervisor to cancel this float and issue a new one.</p>
        </Callout>
      ) : stale ? (
        <Callout tone="danger" title="This float is from a previous business day">
          Ask your supervisor to cancel it and issue today’s float.
        </Callout>
      ) : problem ? (
        <ProblemCallout error={problem} />
      ) : null}
      <Field label="Total counted" error={form.formState.errors.counted?.message} hint="Enter 0 if you received no cash.">
        {(p) => <LargeMoneyInput {...p} {...form.register('counted')} />}
      </Field>
      <Button type="submit" size="lg" block loading={form.formState.isSubmitting}>
        Accept float
      </Button>
    </form>
  );
}

export interface DeclareCountFormProps {
  /** Label of the amount field */
  label: string;
  hint?: string;
  submitLabel: string;
  confirmTitle: string;
  confirmDescription: (amount: string) => string;
  confirmLabel: string;
  successTitle: string;
  successDescription?: string;
  onDone?: () => void;
}

/**
 * The teller's blind closing count, behind an explicit confirmation. Used to close the session and, while it
 * waits for sign-off, to re-declare a miscount (the same endpoint replaces the declared figure).
 */
export function DeclareCountForm({
  label,
  hint = 'Enter 0 if the drawer is empty.',
  submitLabel,
  confirmTitle,
  confirmDescription,
  confirmLabel,
  successTitle,
  successDescription,
  onDone,
}: DeclareCountFormProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(countSchema), defaultValues: { counted: '' } });

  const onSubmit = form.handleSubmit(({ counted }) => {
    setProblem(null);
    setPending(counted);
  });

  const confirm = async () => {
    if (pending === null) return;
    setProblem(null);
    try {
      await api.teller.closeSession(pending);
    } catch (error) {
      setProblem(error);
      if (isApiError(error) && error.code === 'CONFLICT') void queryClient.invalidateQueries({ queryKey: qk.tellerSession });
      throw error;
    }
    notifySuccess(successTitle, successDescription);
    form.reset({ counted: '' });
    onDone?.();
    await queryClient.invalidateQueries({ queryKey: qk.tellerSession });
  };

  return (
    <>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Field label={label} error={form.formState.errors.counted?.message} hint={hint}>
          {(p) => <MoneyInput {...p} {...form.register('counted')} />}
        </Field>
        <Button type="submit" variant="secondary" block className="max-sm:h-12">
          {submitLabel}
        </Button>
      </form>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setProblem(null);
          }
        }}
        title={confirmTitle}
        description={pending === null ? undefined : confirmDescription(formatPaise(pending))}
        confirmLabel={confirmLabel}
        cancelLabel="Go back"
        onConfirm={confirm}
      >
        {problem ? (
          <Callout tone="danger" title={describeError(problem).title}>
            <p>{describeError(problem).description}</p>
            {isApiError(problem) && problem.code === 'CONFLICT' ? (
              <p>
                <Link to="/teller/operations" className="font-medium text-primary underline-offset-2 hover:underline">
                  Review My operations
                </Link>
              </p>
            ) : null}
          </Callout>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
