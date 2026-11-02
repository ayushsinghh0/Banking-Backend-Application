import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError, type ErrorDescription } from '@/lib/api/errors';
import { formatPaise } from '@/lib/money';
import { newIdempotencyKey, notifySuccess } from '@/lib/notify';
import { useStepUp } from '@/features/security/StepUp';
import { Facts } from '@/features/staff/components/layout';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { Callout } from '@/components/ui/primitives';
import { opsKeys, useOpsApi, type TopUp } from '../api';
import { describeOpsError, methodLabel } from '../format';

const MAX_REASON = 300;

const schema = z.object({
  reason: z.string().trim().min(10, 'Write at least 10 characters').max(MAX_REASON, `Keep it to ${MAX_REASON} characters`),
});

/** The answer means the list is out of date (someone else acted, or the status moved on) */
const isStale = (error: unknown) => isApiError(error) && (error.status === 404 || error.status === 409);

/**
 * Refund a top-up: why (kept in the audit trail), then an explicit confirmation of what will happen, then the
 * request, behind step-up. One idempotency key per refund intent, reused when step-up retries the request.
 */
export function RefundDialog({ topUp, onOpenChange }: { topUp: TopUp; onOpenChange: (open: boolean) => void }) {
  const ops = useOpsApi();
  const queryClient = useQueryClient();
  const { run } = useStepUp();
  const [step, setStep] = useState<'reason' | 'confirm'>('reason');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ErrorDescription | null>(null);
  const intent = useRef<{ reason: string; key: string } | null>(null);
  const form = useForm<{ reason: string }>({ resolver: zodResolver(schema), defaultValues: { reason: '' } });
  const typed = form.watch('reason') ?? '';

  const amount = formatPaise(topUp.amountPaise);
  const account = `••••${topUp.accountNumberLast4}`;
  const credited = topUp.status !== 'CREDIT_BLOCKED';

  const review = form.handleSubmit(({ reason: text }) => {
    if (intent.current?.reason !== text) intent.current = { reason: text, key: newIdempotencyKey() };
    setReason(text);
    setProblem(null);
    setStep('confirm');
  });

  const submit = async () => {
    const current = intent.current;
    if (!current) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await run(() => ops.payments.refund(topUp.id, current.reason, current.key));
      queryClient.setQueryData<TopUp>(opsKeys.payment(topUp.id), (old) => ({ ...(old ?? topUp), ...result, history: result.history ?? old?.history }));
      void queryClient.invalidateQueries({ queryKey: opsKeys.payments });
      notifySuccess(
        result.status === 'REFUNDED' ? 'Refunded' : 'Refund started',
        `${amount} goes back to the customer’s ${methodLabel(topUp.method)} payment through Razorpay.`
      );
      onOpenChange(false);
    } catch (error) {
      // A cancelled step-up has already been explained by its own dialog: stay here so they can try again
      if (isApiError(error) && error.requiresStepUp) return;
      setProblem(describeOpsError(error));
      if (isStale(error)) void queryClient.invalidateQueries({ queryKey: opsKeys.payments });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent size="md">
        {step === 'reason' ? (
          <form onSubmit={review} className="grid gap-5" noValidate>
            <DialogHeader
              title="Refund this top-up"
              description={
                credited
                  ? `${amount} goes back to the customer’s original payment method through Razorpay, and the same amount is taken from account ${account}.`
                  : `${amount} goes back to the customer through Razorpay. The money never reached the account, so nothing is taken from it.`
              }
            />
            <Field
              label="Reason"
              error={form.formState.errors.reason?.message}
              hint={`Kept in the audit trail. ${typed.trim().length}/${MAX_REASON} characters.`}
            >
              {(p) => <Textarea {...p} {...form.register('reason')} maxLength={MAX_REASON} rows={4} autoFocus />}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit">Review refund</Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-5">
            <DialogHeader title={`Refund ${amount}?`} description="This can’t be undone. You’ll be asked for your authenticator code if you haven’t entered one recently." />
            <Facts
              items={[
                { label: 'Amount', value: <span className="tnum">{amount}</span> },
                { label: 'Taken from', value: credited ? <span className="tnum">Account {account}</span> : 'Nothing, it was never credited' },
                { label: 'Reason', value: <span className="whitespace-pre-line text-left">{reason}</span> },
              ]}
              layout="aligned"
            />
            {problem ? (
              <Callout tone="danger" title={problem.title}>
                {problem.description}
                {problem.reference ? <span className="mt-1 block font-mono text-[12px]">Reference: {problem.reference}</span> : null}
              </Callout>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" disabled={busy} onClick={() => setStep('reason')}>
                Back
              </Button>
              <Button variant="destructive" loading={busy} onClick={() => void submit()}>
                Refund {amount}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
