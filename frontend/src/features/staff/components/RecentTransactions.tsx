import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ReceiptText } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { formatPaise } from '@/lib/money';
import { cn } from '@/lib/cn';
import { Amount, EmptyState, Skeleton, humanize } from '@/components/ui/primitives';
import { ErrorState } from '@/components/ui/data';
import { formatDateTime, formatListTime } from './format';

const LIMIT = 10;

function TransactionList({ accountId }: { accountId: string }) {
  const api = useApi();
  const query = useQuery({
    queryKey: qk.history(accountId, 0, LIMIT),
    queryFn: () => api.ledger.history(accountId, { limit: LIMIT, offset: 0 }),
  });
  if (query.isError && !query.data?.length) return <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-6" />;
  if (query.isPending) {
    return (
      <div className="space-y-4 py-2" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3.5">
            <Skeleton className="size-9 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    );
  }
  if (query.data.length === 0) return <EmptyState icon={ReceiptText} title="No transactions yet" className="py-6" />;
  const now = Date.now();
  return (
    <ul aria-label="Last 10 transactions, newest first" className="divide-y divide-border/70">
      {query.data.map((entry) => {
        const Icon = entry.entryType === 'CREDIT' ? ArrowDownLeft : ArrowUpRight;
        return (
          <li key={entry.entryId} className="flex items-center gap-3.5 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/80" aria-hidden="true">
              <Icon className="size-4" strokeWidth={1.8} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-[15px] leading-5 tracking-[-0.01em]">{entry.description || humanize(entry.type)}</p>
              <p className="truncate text-[13px] leading-[18px] text-muted-foreground tnum">
                <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
                  {formatListTime(entry.createdAt, now)}
                </time>
                <span className="hidden sm:inline"> · Ref {entry.referenceId}</span>
              </p>
            </div>
            <div className="shrink-0 text-right">
              <Amount paise={entry.amountInPaise} direction={entry.entryType} className="text-[15px]" />
              <p className="text-[12.5px] leading-[18px] text-muted-foreground tnum">
                Balance {formatPaise(entry.balanceAfterInPaise)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Loaded only when opened: every staff read of a ledger is audited, so don't read what nobody looks at */
export function RecentTransactions({ accountId, last4 }: { accountId: string; last4: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Recent transactions for account ending ${last4}`}
        onClick={() => setOpen((v) => !v)}
        className="-mx-2 flex h-11 w-[calc(100%+1rem)] cursor-pointer items-center justify-between gap-2 rounded-xl px-2 text-[14px] font-medium text-primary transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:h-9"
      >
        Recent transactions
        <ChevronDown className={cn('size-4 transition-transform duration-200', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!open} className="mt-1">
        {open ? <TransactionList accountId={accountId} /> : null}
      </div>
    </div>
  );
}
