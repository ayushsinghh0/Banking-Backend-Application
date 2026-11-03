import { useQuery } from '@tanstack/react-query';
import { HandCoins } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import type { CashOperationStatus } from '@/lib/api/types';
import { qk } from '@/lib/query';
import { cn } from '@/lib/cn';
import { ErrorState } from '@/components/ui/data';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { Panel } from './Panel';

const SAMPLE = 100;

/*
 * Colour means something: amber is the only status that needs someone (it waits for an approval); executed
 * operations are ink and rejected ones grey. Every segment is named, with its count, in the legend.
 */
const STATUSES: Array<{ status: CashOperationStatus; label: string; tone: string }> = [
  { status: 'PENDING_APPROVAL', label: 'Awaiting approval', tone: 'bg-warning' },
  { status: 'EXECUTED', label: 'Executed', tone: 'bg-foreground/80' },
  { status: 'REJECTED', label: 'Rejected', tone: 'bg-muted-foreground/35' },
];

/** Recent cash operations by outcome: one segmented bar, and the same numbers as a legend */
export function CashStatusChart({ className }: { className?: string }) {
  const api = useApi();
  const query = useQuery({
    queryKey: [...qk.cashOperations(undefined, 0), { limit: SAMPLE }],
    queryFn: () => api.teller.cashOperations({ limit: SAMPLE }),
  });
  const rows = query.data;
  const data = STATUSES.map((s) => ({ ...s, count: rows?.filter((op) => op.status === s.status).length ?? 0 }));
  const total = rows?.length ?? 0;
  const counted = data.reduce((sum, d) => sum + d.count, 0);

  let body;
  if (query.isPending) {
    body = (
      <div className="space-y-4 py-1">
        <span className="sr-only">Loading</span>
        <Skeleton className="h-8 w-16" />
        <Skeleton className="h-2.5 w-full rounded-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-6" />;
  } else if (total === 0) {
    body = <EmptyState icon={HandCoins} title="No cash operations yet" className="py-8" />;
  } else {
    body = (
      <>
        <p className="text-[28px] font-semibold leading-8 tracking-[-0.028em] tnum">
          {total}
          <span className="ml-1.5 text-[15px] font-normal tracking-[-0.01em] text-muted-foreground">{total === 1 ? 'operation' : 'operations'}</span>
        </p>
        {/* Decorative: the legend below carries the same numbers for everyone */}
        <div className="mt-4 flex h-2.5 gap-[3px] overflow-hidden rounded-full bg-muted" aria-hidden="true">
          {data.map((d) =>
            d.count > 0 ? (
              <div
                key={d.status}
                className={cn('h-full min-w-[6px] rounded-full transition-[width] duration-700 ease-out', d.tone)}
                style={{ width: `${(d.count / Math.max(counted, 1)) * 100}%` }}
              />
            ) : null
          )}
        </div>
        <ul className="mt-4 space-y-2.5">
          {data.map((d) => (
            <li key={d.status} className="flex items-center gap-2.5 text-[14px]">
              <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', d.tone)} />
              <span className="min-w-0 flex-1 text-muted-foreground">{d.label}</span>
              <span className={cn('font-semibold tnum', d.status === 'PENDING_APPROVAL' && d.count > 0 && 'text-warning')}>{d.count}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <Panel
      title="Cash operations by status"
      description={total >= SAMPLE ? `The latest ${SAMPLE} across branches` : 'Recent operations across branches'}
      className={className}
    >
      {body}
    </Panel>
  );
}
