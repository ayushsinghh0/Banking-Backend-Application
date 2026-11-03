import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ReceiptText } from 'lucide-react';
import type { BankAccount, TopUp } from '@/lib/api/types';
import { useApi } from '@/lib/auth/AuthProvider';
import { formatPaise } from '@/lib/money';
import { qk } from '@/lib/query';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Amount, EmptyState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { ACCOUNT_TYPE_LABEL, dayKey, formatShortDate, formatTime } from '../lib';
import { methodLabel, TOP_UP_STATUS_LABEL } from '../topups';
import { Panel } from './Panel';

const PAGE_SIZE = 10;

function when(iso: string): string {
  return `${dayKey(iso) === dayKey(new Date()) ? 'Today' : formatShortDate(iso)}, ${formatTime(iso)}`;
}

function TopUpRow({ topUp, accounts }: { topUp: TopUp; accounts: BankAccount[] }) {
  const account = accounts.find((a) => a.id === topUp.accountId);
  const name = `${account ? ACCOUNT_TYPE_LABEL[account.accountType] : 'Account'} ••••${account?.accountNumber.slice(-4) ?? topUp.accountNumberLast4}`;
  const method = methodLabel(topUp.method);
  const credited = topUp.status === 'CREDITED';
  return (
    <li className="flex items-start gap-3.5 px-5 py-3 sm:px-6">
      <span className="mt-px flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground" aria-hidden="true">
        <ArrowDownLeft className="size-[18px]" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium tracking-[-0.01em]">{name}</p>
        <p className="truncate text-[13px] text-muted-foreground tnum">
          {when(topUp.creditedAt ?? topUp.createdAt)}
          {method ? ` · ${method}` : ''}
        </p>
        {/* Added is the normal ending: only the others need a word */}
        {credited ? null : <StatusBadge status={topUp.status} label={TOP_UP_STATUS_LABEL[topUp.status]} className="mt-1.5" />}
      </div>
      {credited ? (
        <Amount paise={topUp.amountPaise} direction="CREDIT" className="shrink-0 text-[15px]" />
      ) : (
        <span className="shrink-0 tnum whitespace-nowrap text-[15px] font-medium tracking-[-0.01em] text-muted-foreground">{formatPaise(topUp.amountPaise)}</span>
      )}
    </li>
  );
}

/** The customer's own top-ups, newest first, with cursor paging */
export function RecentTopUps({ accounts, className }: { accounts: BankAccount[]; className?: string }) {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: qk.topUps,
    queryFn: ({ pageParam }) => api.payments.topUps({ limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Panel
      title="Recent top-ups"
      flush
      className={className}
      footer={
        query.hasNextPage ? (
          <div className="border-t px-5 py-3 sm:px-6">
            <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Show more
            </Button>
          </div>
        ) : null
      }
    >
      {query.isError && items.length === 0 ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-10" />
      ) : query.isPending ? (
        <div className="space-y-5 px-5 py-5 sm:px-6" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3.5">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={ReceiptText} title="No top-ups yet" description="Money you add by UPI, card or net banking shows up here." className="py-10" />
      ) : (
        <ul aria-label="Recent top-ups" className="divide-y divide-border/70 pb-1">
          {items.map((topUp) => (
            <TopUpRow key={topUp.id} topUp={topUp} accounts={accounts} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
