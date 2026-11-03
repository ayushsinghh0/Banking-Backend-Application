import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import type { AccountType, KycStatus } from '@/lib/api/types';
import { describeError, isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { notifySuccess } from '@/lib/notify';
import { formatAccountNumber } from '@/lib/validation';
import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Callout } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { accountTitle } from '../lib';
import { AccountSwatch } from './AccountCard';
import { openAccountBlocker } from './KycNotice';

const ACCOUNT_TYPES: Array<{ value: AccountType; title: string; description: string }> = [
  { value: 'SAVINGS', title: 'Savings account', description: 'For your personal money and everyday payments.' },
  { value: 'CURRENT', title: 'Current account', description: 'For frequent or high-value payments, such as running a business.' },
];

interface Problem {
  title: string;
  description: string;
  profileLink?: boolean;
}

function problemFrom(error: unknown): Problem {
  if (isApiError(error)) {
    if (error.code === 'KYC_NOT_VERIFIED') {
      return {
        title: 'Identity verification needed',
        description: 'You can open an account once we’ve verified your identity. You can check its progress on your profile.',
        profileLink: true,
      };
    }
    const cap = /at most (\d+)/.exec(error.message)?.[1];
    if (error.code === 'CONFLICT' && cap) {
      return {
        title: 'Account limit reached',
        description: `You can have up to ${cap} open accounts. Contact the bank if you need to close one first.`,
      };
    }
  }
  const { title, description } = describeError(error);
  return { title, description };
}

/** Choose savings or current, open it, then go straight to the new account */
export function OpenAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [type, setType] = useState<AccountType>('SAVINGS');
  const mutation = useMutation({
    mutationFn: (accountType: AccountType) => api.accounts.open(accountType),
    onSuccess: (account) => {
      void queryClient.invalidateQueries({ queryKey: qk.accounts });
      queryClient.setQueryData(qk.account(account.id), account);
      notifySuccess(`${accountTitle(account)} opened`, `Account number ${formatAccountNumber(account.accountNumber)}`);
      onOpenChange(false);
      navigate(`/accounts/${account.id}`);
    },
  });

  const change = (next: boolean) => {
    if (mutation.isPending) return;
    onOpenChange(next);
    if (!next) {
      mutation.reset();
      setType('SAVINGS');
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!mutation.isPending) mutation.mutate(type);
  };

  const problem = mutation.isError ? problemFrom(mutation.error) : null;

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <DialogHeader title="Open an account" description="Your new account is ready to use straight away, in rupees." />
          <fieldset className="grid gap-3">
            <legend className="sr-only">Account type</legend>
            {ACCOUNT_TYPES.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'flex cursor-pointer items-center gap-4 rounded-2xl border p-4 transition-colors duration-200 hover:bg-accent/60',
                  'has-[:checked]:border-primary has-[:checked]:bg-primary-soft/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-popover'
                )}
              >
                <AccountSwatch type={option.value} className="h-9 w-[54px] rounded-[7px]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold tracking-[-0.01em]">{option.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-[18px] text-muted-foreground">{option.description}</span>
                </span>
                {/* The real radio sits over a drawn check, so it stays clickable, focusable and announced */}
                <span className="relative flex size-6 shrink-0 items-center justify-center">
                  <input
                    type="radio"
                    name="accountType"
                    value={option.value}
                    checked={type === option.value}
                    onChange={() => setType(option.value)}
                    className="peer absolute inset-0 z-10 m-0 cursor-pointer appearance-none rounded-full opacity-0"
                  />
                  <span
                    aria-hidden="true"
                    className="size-6 rounded-full border-2 border-input transition-colors duration-200 peer-checked:border-primary peer-checked:bg-primary"
                  />
                  <Check
                    aria-hidden="true"
                    strokeWidth={3}
                    className="pointer-events-none absolute size-3.5 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100"
                  />
                </span>
              </label>
            ))}
          </fieldset>
          {problem ? (
            <Callout tone="danger" title={problem.title}>
              {problem.description}
              {problem.profileLink ? (
                <>
                  {' '}
                  <Link to="/profile" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => change(false)}>
                    Go to your profile
                  </Link>
                </>
              ) : null}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" size="lg" onClick={() => change(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" size="lg" loading={mutation.isPending}>
              Open {type === 'SAVINGS' ? 'savings' : 'current'} account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The "Open account" button. Disabled, with the reason written next to it, until the customer's identity
 * is verified (the API enforces this too; an unknown status leaves it enabled and the API decides).
 */
export function OpenAccountButton({
  kycStatus,
  label = 'Open account',
  variant,
  size,
  showReason = true,
  className,
}: {
  kycStatus: KycStatus | null | undefined;
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  showReason?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const blocker = openAccountBlocker(kycStatus);
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Button
        variant={variant}
        size={size}
        disabled={Boolean(blocker)}
        aria-describedby={blocker && showReason ? reasonId : undefined}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" /> {label}
      </Button>
      {blocker && showReason ? (
        <p id={reasonId} className="max-w-xs text-[13px] leading-[18px] text-muted-foreground">
          {blocker}
        </p>
      ) : null}
      <OpenAccountDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
