import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import type { DirectoryUser, TellerSession } from '@/lib/api/types';
import { formatPaise } from '@/lib/money';
import { notifySuccess } from '@/lib/notify';
import { qk } from '@/lib/query';
import { rupeesSchema } from '@/lib/validation';
import { useStepUp } from '@/features/security/StepUp';
import { Button } from '@/components/ui/button';
import { Field, NativeSelect } from '@/components/ui/input';
import { Callout } from '@/components/ui/primitives';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { describeDiscrepancy, formatBusinessDate, LargeMoneyInput } from './cash';

interface Problem {
  title: string;
  body: string[];
  reference?: string;
}

function genericProblem(error: unknown, title?: string): Problem {
  const described = describeError(error);
  return { title: title ?? described.title, body: [described.description], reference: described.reference };
}

function ProblemCallout({ problem }: { problem: Problem }) {
  return (
    <Callout tone="danger" title={problem.title}>
      {problem.body.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {problem.reference ? <p className="font-mono text-[11.5px]">Reference: {problem.reference}</p> : null}
    </Callout>
  );
}

// --- Issue an opening float -----------------------------------------------------------------------

const issueSchema = z.object({
  tellerId: z.string().min(1, 'Choose a teller'),
  // A zero float is legitimate (a deposits-only desk); the teller still has to confirm it
  amount: rupeesSchema({ allowZero: true }),
});

export function IssueFloatDialog({
  open,
  onOpenChange,
  tellers,
  tellersLoading,
  tellersError,
  onRetryTellers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tellers: DirectoryUser[];
  tellersLoading: boolean;
  tellersError: unknown;
  onRetryTellers: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Problem | null>(null);
  const form = useForm({ resolver: zodResolver(issueSchema), defaultValues: { tellerId: '', amount: '' } });
  const active = tellers.filter((t) => t.isActive && t.role === 'TELLER').sort((a, b) => a.email.localeCompare(b.email));

  const close = (next: boolean) => {
    if (form.formState.isSubmitting) return;
    onOpenChange(next);
    if (!next) {
      form.reset({ tellerId: '', amount: '' });
      setProblem(null);
    }
  };

  const onSubmit = form.handleSubmit(async ({ tellerId, amount }) => {
    setProblem(null);
    try {
      await api.supervisor.issueFloat(tellerId, amount);
      const email = active.find((t) => t.id === tellerId)?.email ?? 'The teller';
      notifySuccess('Float issued', `${email} can now count and accept ${formatPaise(amount)}.`);
      void queryClient.invalidateQueries({ queryKey: qk.sessionsAll });
      onOpenChange(false);
      form.reset({ tellerId: '', amount: '' });
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        const fields = error.fieldErrors;
        if (fields.tellerId) form.setError('tellerId', { message: fields.tellerId });
        if (fields.openingFloatPaise) form.setError('amount', { message: fields.openingFloatPaise });
      }
      setProblem(
        isApiError(error) && error.code === 'FORBIDDEN'
          ? { title: 'Float not issued', body: ['You can’t issue a float to yourself. Another administrator must issue it.'] }
          : genericProblem(error, 'Float not issued')
      );
    }
  });

  const { errors, isSubmitting } = form.formState;
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          <DialogHeader
            title="Issue opening float"
            description="Hand the cash to the teller. Nothing is booked until they count it blind and accept the exact amount."
          />
          {problem ? <ProblemCallout problem={problem} /> : null}
          {tellersError ? (
            <Callout
              tone="danger"
              title="We couldn’t load the list of tellers"
              action={
                <Button variant="secondary" size="sm" onClick={onRetryTellers}>
                  <RotateCw aria-hidden="true" /> Try again
                </Button>
              }
            />
          ) : null}
          <Field
            label="Teller"
            error={errors.tellerId?.message}
            hint={!tellersLoading && !tellersError && active.length === 0 ? 'There are no active tellers.' : undefined}
          >
            {(p) => (
              <NativeSelect {...p} {...form.register('tellerId')} disabled={tellersLoading || Boolean(tellersError)}>
                <option value="">{tellersLoading ? 'Loading tellers…' : 'Select a teller…'}</option>
                {active.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.email}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Opening float" error={errors.amount?.message} hint="The total cash you’re handing over.">
            {(p) => <LargeMoneyInput {...p} {...form.register('amount')} />}
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" loading={isSubmitting}>
              Issue float
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Count and sign off ---------------------------------------------------------------------------

const countSchema = z.object({ counted: rupeesSchema({ allowZero: true }) });

function signOffProblem(error: unknown): Problem {
  const code = isApiError(error) ? error.code : '';
  switch (code) {
    case 'COUNT_MISMATCH':
      return {
        title: 'Your count doesn’t match the teller’s',
        body: [
          'Your count has been recorded. Count the drawer again, ideally with the teller present, and enter the new total.',
          'If you’re certain of your count, ask a second administrator to count the drawer independently. When two supervisor counts match, the dispute is resolved and the difference is recorded.',
        ],
      };
    case 'FORBIDDEN':
      return {
        title: 'You can’t sign off this session',
        body: ['A different administrator must count and sign off this session.'],
      };
    case 'CONFLICT':
    case 'NOT_FOUND':
      return genericProblem(error, 'This session can’t be signed off now');
    default:
      return genericProblem(error);
  }
}

/**
 * The supervisor's independent, blind closing count. Neither the teller's declared figure nor the expected
 * cash is shown (nor fetched into this dialog), so the count can't be fitted to either.
 */
export function SignOffDialog({
  session,
  tellerLabel,
  dispute,
  onOpenChange,
}: {
  session: TellerSession | null;
  tellerLabel: string;
  /** A count that already disagreed with the teller's: by whom (never the figure) */
  dispute: { byYou: boolean; byLabel: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { run } = useStepUp();
  const [counted, setCounted] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({ resolver: zodResolver(countSchema), defaultValues: { counted: '' } });
  const summaryRef = useRef<HTMLDivElement>(null);

  // Announce the figure being signed off; never park focus on the irreversible button
  useEffect(() => {
    if (counted !== null) summaryRef.current?.focus();
  }, [counted]);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setCounted(null);
      setProblem(null);
      form.reset({ counted: '' });
    }
    onOpenChange(next);
  };

  const onContinue = form.handleSubmit(({ counted: value }) => {
    setProblem(null);
    setCounted(value);
  });

  const signOff = async () => {
    if (!session || counted === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await run(() => api.supervisor.signOff(session.id, counted));
      notifySuccess('Session signed off', describeDiscrepancy(result.discrepancy)?.label);
      void queryClient.invalidateQueries({ queryKey: qk.sessionsAll });
      setBusy(false);
      setCounted(null);
      form.reset({ counted: '' });
      onOpenChange(false);
      return;
    } catch (error) {
      setProblem(signOffProblem(error));
      if (isApiError(error)) {
        if (error.code === 'COUNT_MISMATCH') {
          // A recount is a fresh blind count; the list now shows the recorded dispute
          form.reset({ counted: '' });
          setCounted(null);
          setTimeout(() => form.setFocus('counted'), 0);
          void queryClient.invalidateQueries({ queryKey: qk.sessionsAll });
        } else if (error.code === 'CONFLICT' || error.code === 'NOT_FOUND') {
          void queryClient.invalidateQueries({ queryKey: qk.sessionsAll });
        }
      }
    }
    setBusy(false);
  };

  return (
    <Dialog open={session !== null} onOpenChange={close}>
      <DialogContent>
        {session ? (
          counted === null ? (
            <form onSubmit={onContinue} noValidate className="grid gap-5">
              <DialogHeader
                title="Count and sign off"
                description={`Count ${tellerLabel}’s drawer for ${formatBusinessDate(session.businessDate)} on your own and enter the total. The teller’s declared count and the expected cash stay hidden until sign-off, so your count is independent.`}
              />
              {problem ? (
                <ProblemCallout problem={problem} />
              ) : dispute?.byYou ? (
                <Callout tone="warning" title="You already counted this drawer">
                  <p>Your count didn’t match the teller’s. Recount, ideally with the teller present.</p>
                  <p>If you’re still certain, a different administrator must count it independently: your own count can’t confirm itself.</p>
                </Callout>
              ) : dispute ? (
                <Callout tone="warning" title="Count disputed">
                  <p>{dispute.byLabel} counted this drawer and disagreed with the teller.</p>
                  <p>Count it yourself, independently. If your count matches theirs, it settles the session in place of the teller’s declaration.</p>
                </Callout>
              ) : null}
              <Field label="Cash counted" error={form.formState.errors.counted?.message} hint="Enter 0 if the drawer is empty.">
                {(p) => <LargeMoneyInput {...p} {...form.register('counted')} autoFocus />}
              </Field>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Cancel</Button>
                </DialogClose>
                <Button type="submit">Continue</Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="grid gap-5">
              <DialogHeader title="Confirm sign-off" description={`${tellerLabel} · ${formatBusinessDate(session.businessDate)}`} />
              {problem ? <ProblemCallout problem={problem} /> : null}
              {/* Focused when this step opens, so the figure being signed off is announced */}
              <div ref={summaryRef} tabIndex={-1} className="rounded-2xl bg-muted/60 px-5 py-6 text-center outline-none">
                <p className="text-[13px] font-medium text-muted-foreground">You counted</p>
                <p className="mt-1 text-[36px] font-semibold leading-10 tracking-[-0.035em] tnum">{formatPaise(counted)}</p>
              </div>
              <p className="text-pretty text-[14px] leading-5 text-muted-foreground">
                Signing off returns this cash to the vault and records any difference against the ledger. This can’t be undone.
              </p>
              <DialogFooter>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setProblem(null);
                    setCounted(null);
                  }}
                >
                  Recount
                </Button>
                <Button onClick={signOff} loading={busy}>
                  Sign off
                </Button>
              </DialogFooter>
            </div>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
