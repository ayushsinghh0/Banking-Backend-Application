import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/lib/auth/AuthProvider';
import { isApiError } from '@/lib/api/errors';
import type { BankAccount } from '@/lib/api/types';
import { formatPaise } from '@/lib/money';
import { notifySuccess } from '@/lib/notify';
import { formatAccountNumber, rupeesSchema } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { applyAccountUpdate } from './accountCache';
import { OutcomeCallout, outcomeFromError, type Outcome } from './Outcome';

const schema = z.object({ amount: rupeesSchema() });

function DailyLimitForm({ account, customerId, onDone }: { account: BankAccount; customerId: string; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { amount: '' } });

  const onSubmit = form.handleSubmit(async ({ amount }) => {
    setOutcome(null);
    try {
      const updated = await api.accounts.setDailyLimit(account.id, amount);
      applyAccountUpdate(queryClient, customerId, updated);
      notifySuccess('Daily limit updated', `${formatPaise(amount)} a day. The customer can lower it but not raise it above this.`);
      onDone();
    } catch (error) {
      const fieldError = isApiError(error) ? error.fieldErrors.dailyLimitPaise : undefined;
      if (fieldError) form.setError('amount', { message: fieldError }, { shouldFocus: true });
      else setOutcome(outcomeFromError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <DialogHeader
        title="Set daily limit"
        description={`Account ${formatAccountNumber(account.accountNumber)} · currently ${formatPaise(account.dailyLimitPaise)} a day.`}
      />
      <p className="rounded-xl bg-muted/70 px-4 py-3 text-pretty text-[13px] leading-[18px] text-muted-foreground">
        The limit you set becomes a bank-imposed ceiling: the customer can lower it but can’t raise it above this amount. Payments
        across all their accounts are still capped by the per-customer daily limit.
      </p>
      <OutcomeCallout outcome={outcome} onDismiss={() => setOutcome(null)} />
      <Field label="New daily limit" error={form.formState.errors.amount?.message} hint="The most that can leave this account in one day.">
        {(p) => <MoneyInput {...p} {...form.register('amount')} autoFocus />}
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={form.formState.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.formState.isSubmitting}>
          Save limit
        </Button>
      </DialogFooter>
    </form>
  );
}

export function DailyLimitDialog({
  open,
  onOpenChange,
  account,
  customerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: BankAccount;
  customerId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {/* Mounted only while open, so every opening starts with a clean form */}
        {open ? <DailyLimitForm account={account} customerId={customerId} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
