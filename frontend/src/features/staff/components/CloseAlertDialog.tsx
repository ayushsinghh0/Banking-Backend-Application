import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { isApiError } from '@/lib/api/errors';
import type { FraudAlert } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { shortId } from './format';
import { OutcomeCallout, outcomeFromError, type Outcome } from './Outcome';

export type CloseStatus = 'RESOLVED' | 'DISMISSED';

const NOTE_MAX = 1000;
const schema = z.object({
  note: z
    .string()
    .trim()
    .min(1, 'Add a note explaining your decision')
    .max(NOTE_MAX, 'Keep the note to 1,000 characters or fewer'),
});

export const isSevere = (alert: Pick<FraudAlert, 'severity'>) => alert.severity === 'HIGH' || alert.severity === 'CRITICAL';

function copyFor(alert: FraudAlert, status: CloseStatus, confirming: boolean) {
  const resolving = status === 'RESOLVED';
  if (confirming) {
    const title = resolving ? 'Confirm resolution' : 'Confirm dismissal';
    return {
      title,
      submit: title,
      description: `Analyst ${shortId(alert.closeRequestedBy)} proposed this. Confirming closes the alert.`,
    };
  }
  if (isSevere(alert)) {
    return {
      title: resolving ? 'Propose resolving this alert' : 'Propose dismissing this alert',
      submit: resolving ? 'Propose resolution' : 'Propose dismissal',
      description: `This is a ${alert.severity.toLowerCase()}-severity alert, so your decision is recorded as a proposal. A different analyst must confirm it before the alert closes.`,
    };
  }
  return {
    title: resolving ? 'Resolve alert' : 'Dismiss alert',
    submit: resolving ? 'Resolve alert' : 'Dismiss alert',
    description: 'The alert closes straight away.',
  };
}

function CloseForm({
  alert,
  status,
  confirming,
  onSubmitNote,
  onDone,
}: {
  alert: FraudAlert;
  status: CloseStatus;
  confirming: boolean;
  onSubmitNote: (note: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { note: '' } });
  const copy = copyFor(alert, status, confirming);
  const length = form.watch('note').trim().length;

  const onSubmit = form.handleSubmit(async ({ note }) => {
    setOutcome(null);
    try {
      await onSubmitNote(note);
      onDone();
    } catch (error) {
      const fieldError = isApiError(error) ? error.fieldErrors.note : undefined;
      if (fieldError) form.setError('note', { message: fieldError }, { shouldFocus: true });
      else setOutcome(outcomeFromError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <DialogHeader title={copy.title} description={copy.description} />
      <p className="rounded-xl bg-muted/70 px-4 py-3 text-pretty text-[13px] leading-[18px] text-muted-foreground">
        {status === 'RESOLVED'
          ? 'Resolve when the activity was a genuine risk and it has been dealt with.'
          : 'Dismiss when the alert was a false alarm and no action is needed.'}
      </p>
      <OutcomeCallout outcome={outcome} onDismiss={() => setOutcome(null)} />
      <Field
        label="Note"
        error={form.formState.errors.note?.message}
        hint="Saved in the alert history. Say what you checked and why."
        labelAside={
          <span className={cn('text-[12px] tnum text-muted-foreground', length > NOTE_MAX && 'font-medium text-destructive')} aria-hidden="true">
            {length.toLocaleString('en-IN')}/1,000
          </span>
        }
      >
        {(p) => <Textarea {...p} {...form.register('note')} rows={4} autoFocus />}
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={form.formState.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.formState.isSubmitting}>
          {copy.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Closing an alert always needs a note; for severe alerts the first close is a proposal */
export function CloseAlertDialog({
  alert,
  intent,
  onOpenChange,
  onSubmitNote,
}: {
  alert: FraudAlert;
  intent: { status: CloseStatus; confirming: boolean } | null;
  onOpenChange: (open: boolean) => void;
  onSubmitNote: (note: string) => Promise<unknown>;
}) {
  return (
    <Dialog open={intent !== null} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        {intent ? (
          <CloseForm
            alert={alert}
            status={intent.status}
            confirming={intent.confirming}
            onSubmitNote={onSubmitNote}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
