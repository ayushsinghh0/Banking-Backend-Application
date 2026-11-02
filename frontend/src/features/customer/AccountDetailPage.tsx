import { useId, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronLeft, CirclePlus, Gauge, ReceiptText, SearchX, Snowflake } from 'lucide-react';
import type { BankAccount, LedgerEntry } from '@/lib/api/types';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { comparePaise, formatPaise } from '@/lib/money';
import { notifyError, notifySuccess } from '@/lib/notify';
import { UUID_PATTERN, maskAccountNumber } from '@/lib/validation';
import { isApiError } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { BrandMark } from '@/components/layout/Brand';
import { Button } from '@/components/ui/button';
import { ErrorState, Pagination } from '@/components/ui/data';
import { Amount, BigAmount, Callout, Card, EmptyState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlays';
import { useBalance } from './hooks';
import { ACCOUNT_TYPE_LABEL, POLICY, accountTitle, entryLabel, formatDate, formatTime, groupByDay } from './lib';
import { buildBalanceSeries } from './cashflow';
import { AccountCardFace } from './components/AccountCard';
import { AccountNumber } from './components/AccountNumber';
import { BalanceChart } from './components/BalanceChart';
import { DailyLimitDialog } from './components/DailyLimitDialog';
import { Panel } from './components/Panel';

const PAGE_SIZE = 20;

/** Customers may always lower a bank-set limit, and raise it up to the ceiling or their own cap, whichever is lower */
function ceilingNote(ceiling: string): string {
  const cap = POLICY.customerDailyLimitCapPaise;
  return comparePaise(ceiling, cap) <= 0
    ? `Limit set by the bank: you can lower it, or raise it up to ${formatPaise(ceiling)}`
    : `Limit set by the bank: you can lower it, but raising it above ${formatPaise(cap)} needs the bank’s approval`;
}

function BackLink() {
  return (
    <Link
      to="/accounts"
      className="-ml-1.5 inline-flex h-9 items-center gap-0.5 rounded-full pl-0.5 pr-2.5 text-[15px] font-medium tracking-[-0.01em] text-primary transition-colors hover:bg-primary-soft"
    >
      <ChevronLeft className="size-5" strokeWidth={2.2} aria-hidden="true" /> Accounts
    </Link>
  );
}

function NotFound() {
  return (
    <div className="space-y-4">
      <BackLink />
      <Card>
        <div className="flex flex-col items-center px-6 py-16 text-center">
          <SearchX className="mb-3 size-9 text-muted-foreground/60" strokeWidth={1.4} aria-hidden="true" />
          <h1 className="text-headline">Account not found</h1>
          <p className="mt-1 max-w-sm text-pretty text-[14px] leading-5 text-muted-foreground">
            We couldn’t find this account among yours. The link may be incomplete, or the account may belong to someone else.
          </p>
          <Button asChild variant="secondary" className="mt-5">
            <Link to="/accounts">Back to accounts</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function AccountDetailPage() {
  const api = useApi();
  const { accountId = '' } = useParams();
  const valid = UUID_PATTERN.test(accountId);
  const query = useQuery({ queryKey: qk.account(accountId), queryFn: () => api.accounts.get(accountId), enabled: valid });

  const missing = isApiError(query.error) && (query.error.status === 404 || query.error.code === 'VALIDATION_ERROR');
  if (!valid || missing) return <NotFound />;
  if (query.isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div className="space-y-6 lg:space-y-8" aria-busy="true">
        <div className="space-y-2">
          <BackLink />
          <Skeleton className="h-9 w-56" />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
          <Skeleton className="aspect-[1.586/1] w-full rounded-[20px] lg:col-span-4 lg:col-start-9" />
          <Skeleton className="h-64 w-full rounded-2xl lg:col-span-8 lg:row-start-1" />
          <Skeleton className="h-72 w-full rounded-2xl lg:col-span-8" />
        </div>
      </div>
    );
  }
  return <AccountView account={query.data} />;
}

function AccountView({ account }: { account: BankAccount }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [limitOpen, setLimitOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const active = account.status === 'ACTIVE';
  const closed = account.status === 'CLOSED';

  const freeze = async () => {
    try {
      const updated = await api.accounts.setStatus(account.id, 'FROZEN');
      queryClient.setQueryData(qk.account(account.id), updated);
      void queryClient.invalidateQueries({ queryKey: qk.accounts, exact: true });
      notifySuccess('Account frozen', `No money can move in or out of ${maskAccountNumber(account.accountNumber)} until the bank unfreezes it.`);
    } catch (error) {
      notifyError(error, 'The account could not be frozen');
      throw error;
    }
  };

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="space-y-1">
        <BackLink />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="large-title">{accountTitle(account)}</h1>
          {active ? null : <StatusBadge status={account.status} />}
        </div>
      </div>

      {account.status === 'FROZEN' ? (
        <Callout tone="warning" title="This account is frozen">
          No money can be sent from it or paid into it. Only the bank can unfreeze it: contact us when you’re ready to use it
          again.
        </Callout>
      ) : null}
      {closed ? (
        <Callout tone="info" title="This account is closed">
          It can no longer send or receive money. Its statement stays available below.
        </Callout>
      ) : null}

      {/*
        Desktop: two independent columns (balance and statement; the card and its actions, which stay in view).
        Phones: one column in reading order: card, balance, actions, statement.
      */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start lg:gap-6">
        <div className="contents lg:col-span-8 lg:flex lg:flex-col lg:gap-6">
          <Overview account={account} className="order-2" />
          <Statement accountId={account.id} className="order-4" />
        </div>
        <div className="contents lg:sticky lg:top-24 lg:col-span-4 lg:flex lg:flex-col lg:gap-6">
          <IdentityCard account={account} className="order-1" />
          {closed ? null : (
            <AccountActions account={account} onChangeLimit={() => setLimitOpen(true)} onFreeze={() => setFreezeOpen(true)} className="order-3" />
          )}
        </div>
      </div>

      {closed ? null : <DailyLimitDialog account={account} open={limitOpen} onOpenChange={setLimitOpen} />}
      <ConfirmDialog
        open={freezeOpen}
        onOpenChange={setFreezeOpen}
        tone="destructive"
        title="Freeze this account?"
        description={`Freezing stops all money moving in or out of ${maskAccountNumber(account.accountNumber)} straight away. Use it if you think someone else may be using your account.`}
        confirmLabel="Freeze account"
        onConfirm={freeze}
      >
        <Callout tone="warning" title="You can’t unfreeze it yourself">
          Only the bank can unfreeze the account, after checking with you. Your money stays safe in the meantime.
        </Callout>
      </ConfirmDialog>
    </div>
  );
}

/** The account's card, carrying its number: the one place to read or copy it */
function IdentityCard({ account, className }: { account: BankAccount; className?: string }) {
  const closed = account.status === 'CLOSED';
  return (
    <AccountCardFace account={account} className={cn('aspect-[1.586/1] min-h-[196px] w-full', closed && 'opacity-60 saturate-0', className)}>
      <div className="flex h-full flex-col justify-between p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <span className="inline-flex items-center gap-2">
            <BrandMark className="size-6 text-white" />
            <span className="text-[15px] font-semibold tracking-[-0.02em]">BankSphere</span>
          </span>
          <span className="inline-flex h-6 items-center gap-1 rounded-full bg-white/15 px-2.5 text-[12px] font-semibold">
            {account.status === 'FROZEN' ? <Snowflake className="size-3" aria-hidden="true" /> : null}
            {ACCOUNT_TYPE_LABEL[account.accountType]}
          </span>
        </div>
        <div>
          <p className="text-[13px] font-medium text-white/80">Account number</p>
          <AccountNumber value={account.accountNumber} inverse size="lg" className="-ml-0.5 mt-0.5" />
        </div>
      </div>
    </AccountCardFace>
  );
}

/** A line needs a week of history to say anything */
const MIN_CHART_DAYS = 7;

function Overview({ account, className }: { account: BankAccount; className?: string }) {
  const api = useApi();
  const balance = useBalance(account.id);
  // The statement's first page (same query, so no extra request) is enough to draw the last few weeks
  const latest = useQuery({
    queryKey: qk.history(account.id, 0, PAGE_SIZE),
    queryFn: () => api.ledger.history(account.id, { limit: PAGE_SIZE, offset: 0 }),
  });
  const series =
    latest.data && balance.data
      ? buildBalanceSeries([
          {
            entries: latest.data,
            currentPaise: balance.data.balanceInPaise,
            truncated: latest.data.length >= PAGE_SIZE,
            openedAt: account.createdAt,
          },
        ])
      : null;
  const showLine = Boolean(series && series.length >= MIN_CHART_DAYS);

  return (
    <Card role="region" aria-label="Account overview" className={cn('flex flex-col', className)}>
      <div className="px-6 pt-6 sm:px-8 sm:pt-8">
        <p className="text-[15px] font-medium text-muted-foreground">Balance</p>
        <div className="mt-2 text-[40px] font-semibold leading-[44px] tracking-[-0.04em] sm:text-[52px] sm:leading-[56px]">
          {balance.isPending ? (
            <Skeleton className="h-11 w-60 sm:h-14" />
          ) : balance.isError ? (
            <span className="flex items-center gap-3 text-[17px] font-normal leading-6 tracking-[-0.01em] text-muted-foreground">
              Unavailable
              <button type="button" className="cursor-pointer font-medium text-primary hover:underline" onClick={() => void balance.refetch()}>
                Try again
              </button>
            </span>
          ) : (
            <BigAmount paise={balance.data.balanceInPaise} />
          )}
        </div>
      </div>
      {showLine && series ? (
        <div className="px-6 pt-6 sm:px-8">
          <BalanceChart points={series} height={120} />
        </div>
      ) : null}
      <dl className="mx-6 mb-6 mt-7 grid grid-cols-2 gap-x-5 gap-y-5 border-t pt-5 sm:mx-8 sm:mb-7 sm:gap-x-8 sm:pt-6">
        <Fact label="Daily limit" value={<span className="tnum">{formatPaise(account.dailyLimitPaise)}</span>}>
          {account.bankLimitCeilingPaise ? ceilingNote(account.bankLimitCeilingPaise) : 'The most that can leave this account each day'}
        </Fact>
        <Fact label="Opened" value={formatDate(account.createdAt)}>
          In Indian rupees
        </Fact>
      </dl>
    </Card>
  );
}

function Fact({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-[17px] font-semibold tracking-[-0.015em]">{value}</dd>
      {children ? <dd className="mt-1 text-pretty text-[13px] leading-[18px] text-muted-foreground">{children}</dd> : null}
    </div>
  );
}

const ACTION_GRID = ['grid-cols-1', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4'];

/** Round actions, as on the dashboard: what you can do with this account right now */
function AccountActions({
  account,
  onChangeLimit,
  onFreeze,
  className,
}: {
  account: BankAccount;
  onChangeLimit: () => void;
  onFreeze: () => void;
  className?: string;
}) {
  const id = useId();
  const active = account.status === 'ACTIVE';
  const action =
    'group flex flex-col items-center gap-2 whitespace-nowrap rounded-2xl py-1 text-center text-[12.5px] font-medium leading-4 tracking-[-0.01em] focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 cursor-pointer';
  const circle =
    'flex size-[52px] items-center justify-center rounded-full bg-muted text-foreground transition-[transform,background-color] duration-200 group-hover:bg-secondary group-active:scale-95 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-card [&_svg]:size-[22px]';
  const count = active ? 4 : 1;
  return (
    <Card role="region" aria-labelledby={id} className={cn('px-4 py-5 sm:px-6', className)}>
      <h2 id={id} className="sr-only">
        Account actions
      </h2>
      <div className={cn('grid gap-1', ACTION_GRID[count])}>
        {active ? (
          <Link to={`/transfer?from=${account.id}`} className={action} aria-label="Transfer from this account">
            <span className={cn(circle, 'bg-ink text-ink-foreground group-hover:bg-ink/85')}>
              <ArrowLeftRight strokeWidth={1.8} aria-hidden="true" />
            </span>
            Transfer
          </Link>
        ) : null}
        {active ? (
          <Link to={`/add-money?account=${account.id}`} className={action} aria-label="Add money to this account">
            <span className={circle}>
              <CirclePlus strokeWidth={1.8} aria-hidden="true" />
            </span>
            Add money
          </Link>
        ) : null}
        <button type="button" className={action} aria-label="Change daily limit" onClick={onChangeLimit}>
          <span className={circle}>
            <Gauge strokeWidth={1.8} aria-hidden="true" />
          </span>
          Daily limit
        </button>
        {active ? (
          <button type="button" className={action} aria-label="Freeze account" onClick={onFreeze}>
            <span className={circle}>
              <Snowflake strokeWidth={1.8} aria-hidden="true" />
            </span>
            Freeze
          </button>
        ) : null}
      </div>
    </Card>
  );
}

// --- Statement ----------------------------------------------------------------------------------

function Statement({ accountId, className }: { accountId: string; className?: string }) {
  const api = useApi();
  const [offset, setOffset] = useState(0);
  const history = useQuery({
    queryKey: qk.history(accountId, offset, PAGE_SIZE),
    queryFn: () => api.ledger.history(accountId, { limit: PAGE_SIZE, offset }),
    placeholderData: keepPreviousData,
  });
  const rows = history.data;
  // One short page has nowhere to go: the pager appears once there is more than one page
  const paged = Boolean(rows && rows.length > 0 && (offset > 0 || rows.length >= PAGE_SIZE));
  return (
    <Panel
      title="Statement"
      description="Newest first, with the balance after each payment."
      flush
      className={cn('overflow-hidden', className)}
      footer={paged && rows ? <Pagination offset={offset} limit={PAGE_SIZE} count={rows.length} onChange={(next) => setOffset(next)} /> : null}
    >
      {history.error && !rows?.length ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} className="py-10" />
      ) : !rows ? (
        <StatementSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title={offset === 0 ? 'No transactions yet' : 'No more transactions'}
          description={offset === 0 ? 'Money you send or receive will appear here.' : 'You’ve reached the start of this account’s history.'}
          action={
            offset > 0 ? (
              <Button variant="secondary" size="sm" onClick={() => setOffset(0)}>
                Back to the latest
              </Button>
            ) : undefined
          }
          className="py-12"
        />
      ) : (
        <div
          aria-busy={history.isPlaceholderData || undefined}
          className={cn('space-y-4 px-5 pb-2 transition-opacity duration-200 sm:px-6', !paged && 'pb-3 sm:pb-4', history.isPlaceholderData && 'opacity-50')}
        >
          {groupByDay(rows, (entry) => entry.createdAt).map((group) => (
            <div key={group.key}>
              <h3 className="group-label pb-1">{group.heading}</h3>
              <ul className="divide-y divide-border/70">
                {group.items.map((entry) => (
                  <StatementRow key={entry.entryId} entry={entry} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function StatementRow({ entry }: { entry: LedgerEntry }) {
  const credit = entry.entryType === 'CREDIT';
  const Icon = credit ? ArrowDownLeft : ArrowUpRight;
  return (
    <li className="flex items-center gap-3.5 py-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/80" aria-hidden="true">
        <Icon className="size-[18px]" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium tracking-[-0.01em]">{entryLabel(entry)}</p>
        <p className="truncate text-[13px] text-muted-foreground">
          <span className="tnum">{formatTime(entry.createdAt)}</span>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, reference </span>
          <span className="tnum">{entry.referenceId}</span>
        </p>
      </div>
      <div className="shrink-0 text-right">
        <Amount paise={entry.amountInPaise} direction={entry.entryType} className="block text-[15px]" />
        <p className="text-[13px] text-muted-foreground tnum">
          <span className="sr-only">Balance after: </span>
          {formatPaise(entry.balanceAfterInPaise)}
        </p>
      </div>
    </li>
  );
}

function StatementSkeleton() {
  return (
    <div className="space-y-5 px-5 pb-5 pt-2 sm:px-6" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3.5">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="ml-auto h-4 w-20" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}
