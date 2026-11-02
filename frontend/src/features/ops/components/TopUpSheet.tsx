import { useId, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, RotateCw } from 'lucide-react';
import { formatPaise } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Callout, Skeleton } from '@/components/ui/primitives';
import { formatDateTime, shortId } from '@/features/staff/components/format';
import { CopyableId, Facts, RupeeFigure } from '@/features/staff/components/layout';
import { Timeline } from '@/features/staff/components/Timeline';
import { REFUNDABLE, opsKeys, useOpsApi, type TopUp } from '../api';
import { methodLabel, sourceLabel, topUpStatusLabel } from '../format';
import { TopUpStatusBadge } from './badges';
import { DetailSheet } from './DetailSheet';
import { RefundDialog } from './RefundDialog';

function History({ history, loading, failed, onRetry }: { history: TopUp['history']; loading: boolean; failed: boolean; onRetry: () => void }) {
  if (loading) {
    return (
      <div className="space-y-4" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[14px] text-muted-foreground">The history couldn’t be loaded.</p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden="true" /> Try again
        </Button>
      </div>
    );
  }
  if (!history?.length) return <p className="text-[14px] text-muted-foreground">No status changes recorded yet.</p>;
  return (
    <Timeline
      label="Status history"
      items={history.map((entry, index) => ({
        id: `${index}-${entry.to}`,
        title: topUpStatusLabel(entry.to),
        actor: sourceLabel(entry.source),
        at: entry.at,
      }))}
    />
  );
}

/**
 * One top-up: the amount and status, every reference needed to trace it at Razorpay, how it got here, and
 * (for administrators) the refund. `placeholder` is the list's copy, shown while the full record loads.
 */
export function TopUpSheet({
  topUpId,
  placeholder,
  canRefund,
  onClose,
}: {
  topUpId: string;
  placeholder?: TopUp;
  canRefund: boolean;
  onClose: () => void;
}) {
  const ops = useOpsApi();
  const location = useLocation();
  const [refunding, setRefunding] = useState(false);
  const detailsId = useId();
  const historyId = useId();
  const query = useQuery({ queryKey: opsKeys.payment(topUpId), queryFn: () => ops.payments.get(topUpId) });
  const topUp = query.data ?? placeholder;
  const refundable = Boolean(topUp && canRefund && REFUNDABLE.includes(topUp.status));

  let body;
  if (!topUp) {
    body = query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-16" />
    ) : (
      <div className="space-y-4 pr-12" aria-hidden="true">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-6 h-40 w-full" />
      </div>
    );
  } else {
    const waiting = topUp.status === 'CREATED' || topUp.status === 'PENDING';
    body = (
      <div className="space-y-7">
        <div className="space-y-2.5 pr-12">
          <h2 className="text-[34px] font-semibold leading-10 tracking-[-0.03em]">
            <RupeeFigure text={formatPaise(topUp.amountPaise)} />
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-muted-foreground">
            <TopUpStatusBadge status={topUp.status} />
            <span className="tnum">
              To account ••••{topUp.accountNumberLast4} · {methodLabel(topUp.method)}
            </span>
          </p>
        </div>

        {topUp.failureReason ? (
          <Callout tone="info" title="Why it didn’t complete">
            {topUp.failureReason}
          </Callout>
        ) : null}
        {topUp.status === 'CREDIT_BLOCKED' ? (
          <Callout tone="warning" title="Paid but not credited">
            The account couldn’t receive the money. {canRefund ? 'Refund it so it goes back to the customer.' : 'A bank administrator needs to refund it.'}
          </Callout>
        ) : null}
        {topUp.status === 'REFUND_PENDING' ? (
          <Callout tone="info" title="Refund in progress">
            Razorpay is returning the money. This updates by itself when it’s done.
          </Callout>
        ) : null}

        <section aria-labelledby={detailsId} className="space-y-3">
          <h3 id={detailsId} className="text-headline">
            Details
          </h3>
          <Facts
            items={[
              { label: 'Started', value: <span className="tnum">{formatDateTime(topUp.createdAt)}</span> },
              topUp.creditedAt ? { label: 'Credited', value: <span className="tnum">{formatDateTime(topUp.creditedAt)}</span> } : null,
              waiting && topUp.expiresAt ? { label: 'Checkout expires', value: <span className="tnum">{formatDateTime(topUp.expiresAt)}</span> } : null,
              topUp.refundedAt ? { label: 'Refunded', value: <span className="tnum">{formatDateTime(topUp.refundedAt)}</span> } : null,
              topUp.refundReason ? { label: 'Refund reason', value: topUp.refundReason } : null,
              topUp.customerId ? { label: 'Customer', value: <CopyableId value={topUp.customerId} label="Copy customer ID" /> } : null,
              { label: 'Razorpay order', value: topUp.providerOrderId ? <CopyableId value={topUp.providerOrderId} label="Copy order ID" /> : '—' },
              topUp.providerPaymentId ? { label: 'Razorpay payment', value: <CopyableId value={topUp.providerPaymentId} label="Copy payment ID" /> } : null,
              { label: 'Top-up ID', value: <CopyableId value={topUp.id} label="Copy top-up ID" /> },
            ]}
            layout="aligned"
          />
          {topUp.customerId ? (
            <Link
              to={`/customers/${encodeURIComponent(topUp.customerId)}`}
              state={{ from: `${location.pathname}${location.search}`, fromLabel: 'Payments' }}
              className="-mx-2 flex h-11 items-center justify-between rounded-xl px-2 text-[15px] tracking-[-0.01em] text-primary transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open customer {shortId(topUp.customerId)}
              <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden="true" />
            </Link>
          ) : null}
        </section>

        <section aria-labelledby={historyId} className="space-y-3">
          <h3 id={historyId} className="text-headline">
            Status history
          </h3>
          <History
            history={query.data?.history}
            loading={query.isPending}
            failed={query.isError}
            onRetry={() => void query.refetch()}
          />
        </section>
      </div>
    );
  }

  return (
    <DetailSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title="Top-up details"
      footer={
        refundable ? (
          <Button variant="secondary" size="lg" block onClick={() => setRefunding(true)}>
            Refund top-up
          </Button>
        ) : undefined
      }
    >
      {body}
      {/* Inside the sheet's tree, so the sheet treats the dialog (and its step-up) as part of itself */}
      {refunding && topUp ? <RefundDialog topUp={topUp} onOpenChange={setRefunding} /> : null}
    </DetailSheet>
  );
}
