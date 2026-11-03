import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import type { BankAccount } from '@/lib/api/types';
import { describeError, isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { formatPaise, paiseToInput } from '@/lib/money';
import { notifySuccess } from '@/lib/notify';
import { rupeesSchema } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/input';
import { Callout } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { POLICY, paiseInMessage } from '../lib';
import { AmountField } from './AmountField';

const schemaFor = (ceiling: string | null | undefined) =>
  z.object({
    limit: rupeesSchema().refine((paise) => !ceiling || BigInt(paise) <= BigInt(ceiling), {
      message: `You can set up to ${formatPaise(ceiling)}, the limit set by the bank`,
    }),
  });

type FormInput = { limit: string };

/** Lower or raise the account's daily outgoing limit, within what the customer may set themselves */
export function DailyLimitDialog({
  account,
  open,
  onOpenChange,
}: {
  account: BankAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const ceiling = account.bankLimitCeilingPaise;
  const [problem, setProblem] = useState<{ title: string; description: string } | null>(null);
  const form = useForm<FormInput, unknown, { limit: string }>({
    resolver: zodResolver(schemaFor(ceiling)),
    defaultValues: { limit: paiseToInput(account.dailyLimitPaise) },
  });

  const change = (next: boolean) => {
    if (form.formState.isSubmitting) return;
    onOpenChange(next);
    if (!next) {
      setProblem(null);
      form.reset({ limit: paiseToInput(account.dailyLimitPaise) });
    }
  };

  const onSubmit = form.handleSubmit(async ({ limit }) => {
    setProblem(null);
    try {
      const updated = await api.accounts.setDailyLimit(account.id, limit);
      queryClient.setQueryData(qk.account(account.id), updated);
      void queryClient.invalidateQueries({ queryKey: qk.accounts, exact: true });
      notifySuccess('Daily limit updated', `You can now send up to ${formatPaise(updated.dailyLimitPaise)} a day from this account.`);
      onOpenChange(false);
      form.reset({ limit: paiseToInput(updated.dailyLimitPaise) });
    } catch (error) {
      if (isApiError(error) && error.code === 'FORBIDDEN') {
        const cap = paiseInMessage(error.message);
        form.setError('limit', {
          message: cap
            ? `That’s above the most you can set yourself (${cap}). Contact the bank to raise it.`
            : 'That’s above the most you can set yourself. Contact the bank to raise it.',
        });
        return;
      }
      if (isApiError(error) && (error.code === 'VALIDATION_ERROR' || error.code === 'BAD_REQUEST')) {
        form.setError('limit', { message: error.fieldErrors.dailyLimitPaise ?? 'Enter an amount greater than ₹0.00' });
        return;
      }
      setProblem(describeError(error));
    }
  });

  const hint = ceiling
    ? `The bank has set a ceiling of ${formatPaise(ceiling)} for this account.`
    : `You can set up to ${formatPaise(POLICY.customerDailyLimitCapPaise)} a day yourself. For more, contact the bank.`;

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent size="sm" className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader
            title="Change daily limit"
            description={`The most that can leave this account in a day. It is ${formatPaise(account.dailyLimitPaise)} now.`}
          />
          <Field label="New daily limit" error={form.formState.errors.limit?.message} hint={hint}>
            {(p) => <AmountField {...p} {...form.register('limit')} size="md" autoFocus />}
          </Field>
          {problem ? (
            <Callout tone="danger" title={problem.title}>
              {problem.description}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" size="lg" onClick={() => change(false)} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
              Save limit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
