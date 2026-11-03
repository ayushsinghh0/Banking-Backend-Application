import { useCallback, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Receipt, Search } from 'lucide-react';
import { useUser } from '@/lib/auth/AuthProvider';
import { formatPaise } from '@/lib/money';
import { useRealtimeEvent, useRealtimeStatus, type PaymentUpdatedEvent } from '@/lib/realtime';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data';
import { Card, Mono, PageHeader } from '@/components/ui/primitives';
import { LoadingAnnouncement } from '@/features/staff/components/LoadingAnnouncement';
import { formatDateTime, formatListTime } from '@/features/staff/components/format';
import { useListParams } from '@/features/staff/components/hooks';
import { RupeeFigure, chevronColumn, rowListClass } from '@/features/staff/components/layout';
import { TOP_UP_STATUSES, opsKeys, useOpsApi, type TopUp, type TopUpFilters, type TopUpStatus } from './api';
import { methodLabel, topUpStatusLabel } from './format';
import { TopUpStatusBadge } from './components/badges';
import { CursorPagination, useCursorPages } from './components/CursorPagination';
import { PaymentFilters, type FilterChange } from './components/PaymentFilters';
import { PaymentSummary } from './components/PaymentSummary';
import { ReconcileButton } from './components/ReconcileButton';
import { TopUpSheet } from './components/TopUpSheet';

const LIMIT = 25;
/** When no live events arrive (support and fraud roles aren't sent payment events, or the stream is down) */
const POLL_MS = 30_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOP_UP_ID = /^[\w-]{1,64}$/;

const parseStatus = (value: string | null): TopUpStatus | undefined =>
  (TOP_UP_STATUSES as readonly string[]).includes(value ?? '') ? (value as TopUpStatus) : undefined;
const parseDay = (value: string | null) => (value && DAY.test(value) ? value : undefined);

/**
 * The payments console: today's figures, every Razorpay top-up with filters, and one top-up at a time in a
 * sheet with its history. Bank administrators can refund (with step-up) and run the reconciler. Live
 * `payment.updated` events refresh what's on screen; without them the page polls.
 */
export default function PaymentsPage() {
  const ops = useOpsApi();
  const user = useUser();
  const queryClient = useQueryClient();
  const realtime = useRealtimeStatus();
  const isAdmin = user.role === 'BANK_ADMIN';
  const { params, update } = useListParams();
  const [clears, setClears] = useState(0);

  const raw = {
    status: parseStatus(params.get('status')),
    customerId: params.get('customerId') ?? undefined,
    from: parseDay(params.get('from')),
    to: parseDay(params.get('to')),
  };
  const rangeError = Boolean(raw.from && raw.to && raw.from > raw.to);
  const filters: TopUpFilters = useMemo(
    () => ({ status: raw.status, customerId: raw.customerId, from: raw.from, to: rangeError ? undefined : raw.to }),
    [raw.status, raw.customerId, raw.from, raw.to, rangeError]
  );
  const filtered = Object.values(filters).some(Boolean);
  const pages = useCursorPages(JSON.stringify(filters));
  const selected = params.get('topUp');
  const openId = selected && TOP_UP_ID.test(selected) ? selected : null;

  const pollEvery = isAdmin && realtime === 'open' ? false : POLL_MS;
  const summary = useQuery({ queryKey: opsKeys.paymentSummary, queryFn: () => ops.payments.summary(), refetchInterval: pollEvery });
  const list = useQuery({
    queryKey: opsKeys.paymentList(filters, pages.cursor),
    queryFn: () => ops.payments.list({ ...filters, limit: LIMIT, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
    refetchInterval: pollEvery,
  });
  const rows = list.data?.items;

  // A hint, not the data: refetch what's on screen (and an open top-up) from the API
  useRealtimeEvent<PaymentUpdatedEvent>(
    'payment.updated',
    useCallback(() => void queryClient.invalidateQueries({ queryKey: opsKeys.payments }), [queryClient])
  );

  const onFilter = useCallback((change: FilterChange) => update(change), [update]);
  const clearFilters = () => {
    update({ status: undefined, customerId: undefined, from: undefined, to: undefined });
    setClears((n) => n + 1);
  };
  const now = Date.now();

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader
        title="Payments"
        description={isAdmin ? 'Razorpay top-ups, newest first.' : 'Razorpay top-ups, newest first. Refunds are made by bank administrators.'}
        actions={isAdmin ? <ReconcileButton /> : undefined}
      />

      <PaymentSummary query={summary} onShowBlocked={() => update({ status: 'CREDIT_BLOCKED', from: undefined, to: undefined })} />

      <Card className="overflow-hidden">
        <PaymentFilters key={clears} values={raw} rangeError={rangeError} onChange={onFilter} />
        <LoadingAnnouncement active={list.isFetching} label="Loading top-ups…" />
        <div aria-busy={list.isFetching} className={cn('transition-opacity', list.isPlaceholderData && 'opacity-60')}>
          <DataTable<TopUp>
            className={rowListClass}
            caption="Top-ups"
            rows={rows}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            getRowKey={(t) => t.id}
            empty={
              filtered
                ? {
                    icon: Search,
                    title: 'No top-ups match these filters',
                    description: 'Try another status or a wider date range.',
                    action: (
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ),
                  }
                : { icon: Receipt, title: 'No top-ups yet', description: 'Top-ups appear here as soon as a customer starts one.' }
            }
            onRowClick={(t) => update({ topUp: t.id })}
            rowActionLabel={(t) => `Open top-up: ${formatPaise(t.amountPaise)} to ••••${t.accountNumberLast4}, ${topUpStatusLabel(t.status).toLowerCase()}`}
            columns={[
              {
                key: 'amount',
                header: 'Amount',
                cell: (t) => (
                  <span className="flex min-w-0 flex-col items-start gap-0.5 py-0.5">
                    <RupeeFigure text={formatPaise(t.amountPaise)} className="text-[15px] font-medium leading-5" />
                    {/* Phones: the columns that are hidden, in one line */}
                    {/* Each separator travels with the part after it, so a wrapped line never starts or ends with one */}
                    <span className="flex flex-wrap gap-x-1.5 text-[13px] font-normal leading-[18px] text-muted-foreground md:hidden">
                      <span>{methodLabel(t.method)}</span>
                      <span className="whitespace-nowrap tnum">
                        <span aria-hidden="true">· </span>••••{t.accountNumberLast4}
                      </span>
                      <span className="whitespace-nowrap tnum">
                        <span aria-hidden="true">· </span>
                        <time dateTime={t.createdAt}>{formatListTime(t.createdAt, now)}</time>
                      </span>
                    </span>
                  </span>
                ),
              },
              { key: 'status', header: 'Status', className: 'max-md:text-right', cell: (t) => <TopUpStatusBadge status={t.status} /> },
              {
                key: 'account',
                header: 'Account',
                hideOnMobile: true,
                cell: (t) => <span className="whitespace-nowrap tnum">••••{t.accountNumberLast4}</span>,
              },
              { key: 'method', header: 'Method', hideOnMobile: true, cell: (t) => <span className="whitespace-nowrap">{methodLabel(t.method)}</span> },
              {
                key: 'customer',
                header: 'Customer',
                hideOnMobile: true,
                className: 'md:hidden xl:table-cell',
                cell: (t) => (t.customerId ? <Mono value={t.customerId} /> : <span className="text-muted-foreground">—</span>),
              },
              {
                key: 'created',
                header: 'Started',
                hideOnMobile: true,
                className: 'whitespace-nowrap',
                cell: (t) => (
                  <time dateTime={t.createdAt} title={formatDateTime(t.createdAt)} className="text-[14px] text-muted-foreground tnum">
                    {formatListTime(t.createdAt, now)}
                  </time>
                ),
              },
              chevronColumn,
            ]}
          />
        </div>
        {rows && (rows.length > 0 || pages.page > 1) ? (
          <CursorPagination
            page={pages.page}
            limit={LIMIT}
            count={rows.length}
            hasNext={Boolean(list.data?.nextCursor) && !list.isPlaceholderData}
            onNext={() => list.data?.nextCursor && pages.next(list.data.nextCursor)}
            onPrevious={pages.previous}
          />
        ) : null}
      </Card>

      {openId ? (
        <TopUpSheet
          key={openId}
          topUpId={openId}
          placeholder={rows?.find((t) => t.id === openId)}
          canRefund={isAdmin}
          onClose={() => update({ topUp: undefined })}
        />
      ) : null}
    </div>
  );
}
