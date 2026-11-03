import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import type { AccountStatus, BankAccount } from '@/lib/api/types';
import { comparePaise, formatPaise } from '@/lib/money';
import { notifyError, notifySuccess } from '@/lib/notify';
import { formatAccountNumber } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { ConfirmDialog } from '@/components/ui/overlays';
import { cn } from '@/lib/cn';
import { Amount, Callout, CopyButton, EmptyState, Skeleton } from '@/components/ui/primitives';
import { DailyLimitDialog } from './DailyLimitDialog';
import { RecentTransactions } from './RecentTransactions';
import { applyAccountUpdate } from './accountCache';
import { formatDate } from './format';
import { hasCode, isRefusal } from './hooks';
import { OutcomeCallout, outcomeFromError, type Outcome } from './Outcome';
import { Panel } from './layout';

type StatusAction = 'freeze' | 'unfreeze' | 'close';

const TARGET: Record<StatusAction, AccountStatus> = { freeze: 'FROZEN', unfreeze: 'ACTIVE', close: 'CLOSED' };
const DONE: Record<StatusAction, [string, string]> = {
  freeze: ['Account frozen', 'Payments in and out are blocked. The customer has been told by email.'],
  unfreeze: ['Account unfrozen', 'Payments in and out can resume.'],
  close: ['Account closed', 'The account can no longer be used.'],
};

function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium tracking-[-0.01em] tnum">{children}</dd>
      {hint ? <dd className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

const STATUS_LOOK: Record<AccountStatus, { label: string; dot: string; text?: string }> = {
  ACTIVE: { label: 'Active', dot: 'bg-success' },
  FROZEN: { label: 'Frozen', dot: 'bg-destructive', text: 'text-destructive' },
  CLOSED: { label: 'Closed', dot: 'bg-muted-foreground' },
};

/** Status as a word with a dot: it varies and matters to staff, but it isn't a badge on every row */
function AccountStatusText({ status }: { status: AccountStatus }) {
  const look = STATUS_LOOK[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5', look.text)}>
      <span className={cn('size-2 shrink-0 rounded-full', look.dot)} aria-hidden="true" />
      <span>{look.label}</span>
    </span>
  );
}

/** A small card swatch, so savings and current read apart at a glance (as on the customer's own pages) */
function AccountSwatch({ type }: { type: BankAccount['accountType'] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative mt-0.5 h-7 w-10 shrink-0 overflow-hidden rounded-[6px] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.12)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16)]',
        type === 'SAVINGS' ? 'bg-gradient-to-br from-[#2c2c2e] to-[#0b0b0c]' : 'bg-gradient-to-br from-[#2f7bf5] to-[#0a4fc4]'
      )}
    >
      <span className="absolute bottom-1 left-1 h-[3px] w-3 rounded-full bg-white/70" />
    </span>
  );
}

/** Pills are 32px on desktop and grow to a 44px touch target on phones */
const controlSize = 'max-sm:h-11 max-sm:px-4 max-sm:text-[14px]';

function AccountControls({ account, customerId, balance }: { account: BankAccount; customerId: string; balance: string | undefined }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<StatusAction | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const last4 = account.accountNumber.slice(-4);
  const number = formatAccountNumber(account.accountNumber);

  const run = async (current: StatusAction) => {
    setOutcome(null);
    try {
      const updated = await api.accounts.setStatus(account.id, TARGET[current]);
      applyAccountUpdate(queryClient, customerId, updated);
      notifySuccess(...DONE[current]);
    } catch (error) {
      if (!isRefusal(error)) {
        notifyError(error);
        throw error; // keep the dialog open to try again
      }
      if (current === 'unfreeze' && hasCode(error, 'FORBIDDEN')) {
        setOutcome({
          tone: 'danger',
          title: 'A different administrator must unfreeze this account',
          body: 'Dual control: an account frozen by an administrator can only be unfrozen by someone else. Ask a colleague to review it.',
        });
      } else {
        setOutcome(outcomeFromError(error));
      }
      void queryClient.invalidateQueries({ queryKey: qk.customerAccounts(customerId) });
      if (hasCode(error, 'BALANCE_NOT_ZERO')) void queryClient.invalidateQueries({ queryKey: qk.balance(account.id) });
    }
  };

  const holdsMoney = balance !== undefined && comparePaise(balance, '0') !== 0;
  const dialog = action
    ? {
        freeze: {
          title: `Freeze account ${number}?`,
          description:
            'No money can be paid in or out until the account is unfrozen, and the customer is told by email. Dual control applies: a different administrator will have to unfreeze it.',
          confirmLabel: 'Freeze account',
          tone: 'destructive' as const,
          body: null,
        },
        unfreeze: {
          title: `Unfreeze account ${number}?`,
          description:
            'Payments in and out resume straight away. If you froze this account yourself, a different administrator must unfreeze it.',
          confirmLabel: 'Unfreeze account',
          tone: 'primary' as const,
          body: null,
        },
        close: {
          title: `Close account ${number} permanently?`,
          description: 'Closing can’t be undone. The balance must be zero, so move any remaining money first.',
          confirmLabel: 'Close account',
          tone: 'destructive' as const,
          body: holdsMoney ? (
            <Callout tone="warning" title={`This account still holds ${formatPaise(balance)}`}>
              The bank will refuse to close it until the balance is zero.
            </Callout>
          ) : balance !== undefined ? (
            <p className="text-[13px] text-muted-foreground">Balance: {formatPaise(balance)}</p>
          ) : null,
        },
      }[action]
    : null;

  return (
    <div className="space-y-3">
      <OutcomeCallout outcome={outcome} onDismiss={() => setOutcome(null)} />
      <div className="flex flex-wrap gap-2">
        {account.status === 'ACTIVE' ? (
          <Button variant="secondary" size="sm" className={controlSize} aria-label={`Freeze account ending ${last4}`} onClick={() => setAction('freeze')}>
            Freeze
          </Button>
        ) : (
          <Button variant="secondary" size="sm" className={controlSize} aria-label={`Unfreeze account ending ${last4}`} onClick={() => setAction('unfreeze')}>
            Unfreeze
          </Button>
        )}
        <Button variant="secondary" size="sm" className={controlSize} aria-label={`Set daily limit for account ending ${last4}`} onClick={() => setLimitOpen(true)}>
          Set daily limit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(controlSize, 'text-destructive hover:bg-destructive-soft hover:text-destructive')}
          aria-label={`Close account ending ${last4}`}
          onClick={() => setAction('close')}
        >
          Close account
        </Button>
      </div>
      {account.status === 'FROZEN' ? (
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          Dual control: only an administrator other than the one who froze this account can unfreeze it.
        </p>
      ) : null}
      {dialog ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
          title={dialog.title}
          description={dialog.description}
          confirmLabel={dialog.confirmLabel}
          tone={dialog.tone}
          onConfirm={() => run(action!)}
        >
          {dialog.body}
        </ConfirmDialog>
      ) : null}
      <DailyLimitDialog open={limitOpen} onOpenChange={setLimitOpen} account={account} customerId={customerId} />
    </div>
  );
}

function AccountPanel({ account, customerId, canAdminister }: { account: BankAccount; customerId: string; canAdminister: boolean }) {
  const api = useApi();
  const typeLabel = account.accountType === 'SAVINGS' ? 'Savings account' : 'Current account';
  const balance = useQuery({ queryKey: qk.balance(account.id), queryFn: () => api.ledger.balance(account.id) });
  const last4 = account.accountNumber.slice(-4);
  const ceiling = account.bankLimitCeilingPaise;

  return (
    <section aria-label={`${typeLabel} ending ${last4}`} className="py-5 first:pt-1 last:pb-0">
      <div className="flex items-start gap-3.5">
        <AccountSwatch type={account.accountType} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium leading-5 tracking-[-0.01em]">{typeLabel}</h3>
          <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground">
            <span className="inline-flex items-center whitespace-nowrap tnum">
              {formatAccountNumber(account.accountNumber)}
              <CopyButton value={account.accountNumber} label="Copy account number" className="-my-1.5 size-7 max-sm:size-10" />
            </span>
            <span>Opened {formatDate(account.createdAt)}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[17px] font-semibold leading-5 tracking-[-0.02em]">
            {balance.isPending ? (
              <Skeleton className="h-5 w-28" />
            ) : balance.isError ? (
              <span className="flex items-center gap-2 text-[13px] font-normal text-muted-foreground">
                Unavailable
                <Button variant="link" className="text-[13px]" aria-label="Retry loading the balance" onClick={() => void balance.refetch()}>
                  Retry
                </Button>
              </span>
            ) : (
              <Amount paise={balance.data.balanceInPaise} className="font-semibold" />
            )}
          </div>
          <p className="text-[13px] leading-[18px] text-muted-foreground">Balance</p>
        </div>
      </div>
      <div className="mt-4 space-y-4 sm:pl-[54px]">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Stat label="Status">
            <AccountStatusText status={account.status} />
          </Stat>
          <Stat label="Daily limit">{formatPaise(account.dailyLimitPaise)}</Stat>
          <Stat label="Bank ceiling" hint={ceiling ? 'The customer can’t raise their limit above this.' : undefined}>
            {ceiling ? formatPaise(ceiling) : <span className="font-normal text-muted-foreground">None set</span>}
          </Stat>
        </dl>
        {canAdminister && account.status !== 'CLOSED' ? (
          <AccountControls account={account} customerId={customerId} balance={balance.data?.balanceInPaise} />
        ) : null}
        <RecentTransactions accountId={account.id} last4={last4} />
      </div>
    </section>
  );
}

export function AccountsSection({
  customerId,
  query,
  canAdminister,
  me,
  className,
}: {
  customerId: string;
  query: UseQueryResult<BankAccount[]>;
  canAdminister: boolean;
  me: string;
  className?: string;
}) {
  const accounts = query.data;
  return (
    <Panel
      className={className}
      title={
        <>
          Accounts{accounts?.length ? <> <span className="ml-0.5 font-normal text-muted-foreground tnum">{accounts.length}</span></> : null}
        </>
      }
      description="Read live from the ledger. Staff reads are audited."
    >
      {query.isPending ? (
        <div className="space-y-5 pt-1" aria-hidden="true">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-start gap-3.5">
              <Skeleton className="h-7 w-10 rounded-[6px]" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-6" />
      ) : accounts!.length === 0 ? (
        <EmptyState icon={Wallet} title="No accounts" description="The customer can open an account once their KYC is verified." className="py-8" />
      ) : (
        <div className="divide-y divide-border/70">
          {accounts!.map((account) => (
            <AccountPanel
              key={account.id}
              account={account}
              customerId={customerId}
              // On their own account an administrator has only a customer's rights
              canAdminister={canAdminister && account.customerId !== me}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
