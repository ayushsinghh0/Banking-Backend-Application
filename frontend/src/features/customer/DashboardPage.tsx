import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Banknote, ChevronRight, CirclePlus, Plus, ReceiptText, UserPlus, Wallet } from 'lucide-react';
import type { BankAccount, KycStatus } from '@/lib/api/types';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { addPaise, comparePaise, formatPaise, type Paise } from '@/lib/money';
import { maskAccountNumber } from '@/lib/validation';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Amount, BigAmount, Callout, Card, EmptyState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { buildBalanceSeries, buildCashFlow, type AccountEntry, type CashFlow } from './cashflow';
import { useAccounts, useBalances, useProfile } from './hooks';
import { ACCOUNT_TYPE_LABEL, dayKey, entryLabel, firstName, formatTime, greeting } from './lib';
import { BalanceChart } from './components/BalanceChart';
import { cashFlowSummary } from './components/CashFlowChart';
import { AccountSwatch } from './components/AccountCard';
import { KycNotice, openAccountBlocker } from './components/KycNotice';
import { Panel } from './components/Panel';
import { OpenAccountButton, OpenAccountDialog } from './components/OpenAccountDialog';

const HISTORY_LIMIT = 100;
const RECENT_COUNT = 8;
const MIN_CHART_DAYS = 7;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function DashboardPage() {
  const api = useApi();
  const profileQuery = useProfile();
  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const openAccounts = accounts.filter((a) => a.status !== 'CLOSED');
  const activeAccounts = accounts.filter((a) => a.status === 'ACTIVE');
  const frozenCount = accounts.filter((a) => a.status === 'FROZEN').length;

  const balanceQueries = useBalances(openAccounts.map((a) => a.id));
  const balanceOf = new Map(openAccounts.map((a, i) => [a.id, balanceQueries[i]]));
  const historyQueries = useQueries({
    queries: accounts.map((account) => ({
      queryKey: qk.history(account.id, 0, HISTORY_LIMIT),
      queryFn: () => api.ledger.history(account.id, { limit: HISTORY_LIMIT }),
    })),
  });

  // --- derived figures -------------------------------------------------------------------------
  const activeBalances = activeAccounts.map((a) => balanceOf.get(a.id));
  const balancesLoading = accountsQuery.isPending || activeBalances.some((q) => q?.isPending);
  const balancesFailed = accountsQuery.isError || activeBalances.some((q) => q?.isError);
  const totalBalance = addPaise(activeBalances.map((q) => q?.data?.balanceInPaise ?? '0'));

  const historyLoading = accountsQuery.isPending || historyQueries.some((q) => q.isPending);
  const historyError = historyQueries.find((q) => q.isError)?.error;
  // A handful of accounts with at most 100 entries each: cheap enough to derive on every render
  const entries: AccountEntry[] = accounts.flatMap((account, i) => (historyQueries[i]?.data ?? []).map((entry) => ({ account, entry })));
  const flow = historyLoading || historyError ? null : buildCashFlow(entries);
  const recent = [...entries].sort((a, b) => b.entry.createdAt.localeCompare(a.entry.createdAt)).slice(0, RECENT_COUNT);
  const spentToday = flow?.days[flow.days.length - 1]?.outPaise ?? '0';
  const series =
    historyLoading || historyError || balancesLoading || balancesFailed
      ? null
      : buildBalanceSeries(
          activeAccounts.map((account) => {
            const history = historyQueries[accounts.indexOf(account)]?.data ?? [];
            return {
              entries: history,
              currentPaise: balanceOf.get(account.id)?.data?.balanceInPaise,
              truncated: history.length >= HISTORY_LIMIT,
              openedAt: account.createdAt,
            };
          })
        );
  // A line needs a week of history to say anything; until then show where the money sits
  const showLine = Boolean(series && series.length >= MIN_CHART_DAYS);

  const retryFailed = (queries: Array<{ isError: boolean; refetch: () => Promise<unknown> }>) => () => {
    for (const q of queries) if (q.isError) void q.refetch();
  };
  const retryHistory = retryFailed(historyQueries);
  const retryBalances = retryFailed(balanceQueries);

  const profile = profileQuery.data;
  const kycStatus: KycStatus | null | undefined = profileQuery.isSuccess ? (profile?.kycStatus ?? null) : undefined;
  const title = profile ? `${greeting()}, ${firstName(profile.fullName)}` : profile === null ? 'Welcome to BankSphere' : 'Welcome back';
  const hasAccounts = openAccounts.length > 0;

  return (
    <div className="space-y-6 lg:space-y-8">
      <h1 className="large-title">{title}</h1>

      <KycNotice profile={profileQuery.isSuccess ? profile : undefined} />
      {profileQuery.isError ? (
        <Callout
          tone="warning"
          title="We couldn’t load your profile"
          action={
            <Button variant="secondary" size="sm" onClick={() => void profileQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
        {/* Hero: the one number people come for, and how it has moved */}
        <section aria-label="Summary" aria-busy={balancesLoading || historyLoading} className="lg:col-span-8 lg:row-span-2">
          <Card className="flex h-full flex-col overflow-hidden">
            <div className="px-6 pt-6 sm:px-8 sm:pt-8">
              <p className="text-[15px] font-medium text-muted-foreground">Total balance</p>
              <div className="mt-2 text-[40px] font-semibold leading-[44px] tracking-[-0.04em] sm:text-[52px] sm:leading-[56px]">
                {balancesLoading && !accountsQuery.isError ? (
                  <Skeleton className="h-11 w-60 sm:h-14" />
                ) : balancesFailed ? (
                  '—'
                ) : (
                  <BigAmount paise={totalBalance} />
                )}
              </div>
              <p className="mt-3 flex flex-col gap-0.5 text-[14px] leading-5 text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-1.5">
                {balancesFailed && !accountsQuery.isError ? (
                  <InlineRetry onRetry={retryBalances}>Some balances couldn’t be loaded.</InlineRetry>
                ) : accountsQuery.isSuccess ? (
                  <>
                    <span>
                      Across {plural(activeAccounts.length, 'active account')}
                      {frozenCount ? ` · ${plural(frozenCount, 'frozen account')} not included` : ''}
                    </span>
                    {hasAccounts && !historyError ? (
                      <span>
                        <span className="hidden sm:inline" aria-hidden="true">
                          ·{' '}
                        </span>
                        <span className="font-medium text-foreground tnum">{formatPaise(spentToday)}</span> spent today
                      </span>
                    ) : null}
                  </>
                ) : null}
              </p>
            </div>
            <div className="mt-auto px-6 pb-6 pt-8 sm:px-8 sm:pb-7">
              {showLine && series ? (
                <BalanceChart points={series} height={150} />
              ) : series || (!balancesLoading && !balancesFailed && activeAccounts.length > 0) ? (
                <Allocation accounts={activeAccounts} total={totalBalance} balance={(id) => balanceOf.get(id)?.data?.balanceInPaise ?? '0'} />
              ) : historyLoading && hasAccounts ? (
                <Skeleton className="h-16 w-full rounded-xl" />
              ) : null}
            </div>
          </Card>
        </section>

        <QuickActions kycStatus={kycStatus} className="lg:col-span-4 lg:col-start-9 lg:row-start-1" />

        {accountsQuery.isError ? (
          <Card className="lg:col-span-12">
            <ErrorState error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} />
          </Card>
        ) : (
          <AccountsList
            accounts={accounts}
            loading={accountsQuery.isPending}
            kycStatus={kycStatus}
            balance={(id) => balanceOf.get(id)}
            className={cn(hasAccounts || accountsQuery.isPending ? 'lg:col-span-4 lg:col-start-9 lg:row-start-2' : 'lg:col-span-12')}
          />
        )}

        {hasAccounts ? (
          <Panel title="Recent activity" className="lg:col-span-8 lg:col-start-1 lg:row-start-3">
            <RecentActivity items={recent} loading={historyLoading} error={historyError} onRetry={retryHistory} />
          </Panel>
        ) : null}

        {hasAccounts ? (
          <CashFlowPanel
            flow={flow}
            loading={historyLoading}
            error={historyError}
            onRetry={retryHistory}
            className="lg:col-span-4 lg:col-start-9 lg:row-start-3 lg:self-start"
          />
        ) : null}
      </div>
    </div>
  );
}

function InlineRetry({ onRetry, children }: { onRetry: () => void; children: ReactNode }) {
  return (
    <span>
      {children}{' '}
      <button type="button" className="cursor-pointer font-medium text-primary hover:underline" onClick={onRetry}>
        Try again
      </button>
    </span>
  );
}

// --- Quick actions ------------------------------------------------------------------------------

function QuickActions({ kycStatus, className }: { kycStatus: KycStatus | null | undefined; className?: string }) {
  const [opening, setOpening] = useState(false);
  const id = useId();
  const action =
    // Labels may wrap to a second line under their circle (as in Control Center), never run into a neighbour
    'group flex min-w-0 flex-col items-center gap-2 rounded-2xl px-0.5 py-1 text-center text-[12.5px] font-medium leading-4 tracking-[-0.01em] [text-wrap:balance] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer';
  const circle =
    // Five across: a touch smaller where the side column is narrowest (small laptops)
    'flex size-[52px] items-center justify-center rounded-full bg-muted text-foreground transition-[transform,background-color] duration-200 group-hover:bg-secondary group-active:scale-95 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-card lg:size-12 xl:size-[52px] [&_svg]:size-[22px]';
  const links = [
    { to: '/transfer', label: 'Transfer', Icon: ArrowLeftRight, primary: true },
    { to: '/add-money', label: 'Add money', Icon: CirclePlus },
    { to: '/payees?add=1', label: 'Add payee', Icon: UserPlus },
    { to: '/cash-withdrawal', label: 'Withdraw', name: 'Withdraw cash', Icon: Banknote },
  ];
  return (
    <Card role="region" aria-labelledby={id} className={cn('px-4 py-5 sm:px-6', className)}>
      <h2 id={id} className="sr-only">
        Quick actions
      </h2>
      <div className="grid grid-cols-5 gap-0.5 sm:gap-1">
        {links.map(({ to, label, name, Icon, primary }) => (
          <Link key={to} to={to} className={action} aria-label={name}>
            <span className={cn(circle, primary && 'bg-ink text-ink-foreground group-hover:bg-ink/85')}>
              <Icon strokeWidth={1.8} aria-hidden="true" />
            </span>
            {label}
          </Link>
        ))}
        <button type="button" className={action} disabled={Boolean(openAccountBlocker(kycStatus))} onClick={() => setOpening(true)}>
          <span className={circle}>
            <Plus strokeWidth={1.8} aria-hidden="true" />
          </span>
          New account
        </button>
      </div>
      <OpenAccountDialog open={opening} onOpenChange={setOpening} />
    </Card>
  );
}

// --- Cash flow ----------------------------------------------------------------------------------

function CashFlowPanel({
  flow,
  loading,
  error,
  onRetry,
  className,
}: {
  flow: CashFlow | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const largest = flow ? (comparePaise(flow.totalIn, flow.totalOut) >= 0 ? flow.totalIn : flow.totalOut) : '0';
  const share = (value: Paise) => (largest === '0' ? 0 : Math.max(2, Math.round((Number(value) / Number(largest)) * 100)));
  return (
    <Panel title="Cash flow" className={className}>
      {error ? (
        <ErrorState error={error} onRetry={onRetry} className="py-6" />
      ) : loading || !flow ? (
        <div className="space-y-4 py-1" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !flow.hasActivity ? (
        <p className="py-3 text-[14px] text-muted-foreground">No money in or out in the last 30 days</p>
      ) : (
        <>
          <p className="sr-only">{cashFlowSummary(flow)}</p>
          <dl className="space-y-4" aria-hidden="true">
            <FlowRow label="Money in" amount={formatPaise(flow.totalIn)} percent={share(flow.totalIn)} tone="in" />
            <FlowRow label="Money out" amount={formatPaise(flow.totalOut)} percent={share(flow.totalOut)} tone="out" />
          </dl>
        </>
      )}
      <p className="mt-4 text-[12.5px] leading-[18px] text-muted-foreground">Last 30 days. Transfers between your own accounts are not counted.</p>
    </Panel>
  );
}

function FlowRow({ label, amount, percent, tone }: { label: string; amount: string; percent: number; tone: 'in' | 'out' }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-[14px] text-muted-foreground">{label}</dt>
        <dd className={cn('text-[15px] font-semibold tracking-[-0.01em] tnum', tone === 'in' && 'text-success')}>{amount}</dd>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-out', tone === 'in' ? 'bg-success' : 'bg-foreground/80')}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

// --- Allocation ---------------------------------------------------------------------------------

const ALLOCATION_TONES: Record<BankAccount['accountType'], string[]> = {
  SAVINGS: ['bg-foreground', 'bg-foreground/55', 'bg-foreground/30'],
  CURRENT: ['bg-primary', 'bg-primary/60', 'bg-primary/35'],
};

/** How the total splits across accounts: one segmented bar and a legend with shares */
function Allocation({ accounts, total, balance }: { accounts: BankAccount[]; total: Paise; balance: (id: string) => Paise }) {
  const totalPaise = BigInt(total);
  const seen: Record<string, number> = {};
  const rows = accounts.map((account) => {
    const index = (seen[account.accountType] = (seen[account.accountType] ?? -1) + 1);
    const tones = ALLOCATION_TONES[account.accountType];
    // Basis points from exact paise, so shares never drift from the amounts
    const basis = totalPaise > 0n ? Number((BigInt(balance(account.id)) * 10000n) / totalPaise) : 0;
    return { account, tone: tones[Math.min(index, tones.length - 1)]!, basis };
  });
  return (
    <div>
      <p className="group-label">Where your money is</p>
      <div className="mt-3 flex h-2.5 gap-[3px] overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {rows.map(({ account, tone, basis }) =>
          basis > 0 ? <div key={account.id} className={cn('h-full rounded-full', tone)} style={{ width: `${basis / 100}%` }} /> : null
        )}
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2">
        {rows.map(({ account, tone, basis }) => (
          <li key={account.id} className="flex items-center gap-2.5 text-[14px]">
            <span className={cn('size-2.5 shrink-0 rounded-full', tone)} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {ACCOUNT_TYPE_LABEL[account.accountType]} <span className="text-muted-foreground tnum">{maskAccountNumber(account.accountNumber)}</span>
            </span>
            <span className="font-medium tnum">{Math.round(basis / 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Accounts -----------------------------------------------------------------------------------

interface BalanceState {
  data?: { balanceInPaise: string };
  isPending: boolean;
  isError: boolean;
}

function AccountsList({
  accounts,
  loading,
  kycStatus,
  balance,
  className,
}: {
  accounts: BankAccount[];
  loading: boolean;
  kycStatus: KycStatus | null | undefined;
  balance: (id: string) => BalanceState | undefined;
  className?: string;
}) {
  const visible = accounts.filter((a) => a.status !== 'CLOSED');
  return (
    <Panel
      title="Your accounts"
      className={className}
      action={
        visible.length ? (
          <Link to="/accounts" className="text-[14px] font-medium text-primary hover:underline">
            See all
          </Link>
        ) : null
      }
    >
      {loading ? (
        <div className="space-y-3 py-1" aria-busy="true">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Open your first account"
          description="Choose a savings or current account. It’s ready to use as soon as it’s open."
          action={<OpenAccountButton kycStatus={kycStatus} size="lg" className="items-center text-center" />}
          className="py-10"
        />
      ) : (
        <ul className="-mx-2">
          {visible.map((account) => {
            const state = balance(account.id);
            const amount = state?.isPending ? 'balance loading' : state?.isError ? 'balance unavailable' : formatPaise(state?.data?.balanceInPaise);
            const status = account.status !== 'ACTIVE' ? `, ${account.status.toLowerCase()}` : '';
            return (
              <li key={account.id}>
                <Link
                  to={`/accounts/${account.id}`}
                  aria-label={`${ACCOUNT_TYPE_LABEL[account.accountType]} ${maskAccountNumber(account.accountNumber)}${status}, ${amount}`}
                  className="group flex items-center gap-3.5 rounded-xl px-2 py-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AccountSwatch type={account.accountType} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium tracking-[-0.01em]">{ACCOUNT_TYPE_LABEL[account.accountType]} </span>
                    <span className="flex items-center gap-2 text-[13px] text-muted-foreground tnum">
                      {maskAccountNumber(account.accountNumber)}
                      {account.status !== 'ACTIVE' ? <StatusBadge status={account.status} /> : null}
                    </span>
                  </span>
                  <span className="text-right text-[15px] font-semibold tracking-[-0.01em] tnum">
                    {state?.isPending ? <Skeleton className="h-5 w-24" /> : state?.isError ? 'Unavailable' : formatPaise(state?.data?.balanceInPaise)}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// --- Activity -----------------------------------------------------------------------------------

function dayHeading(iso: string, now = new Date()): string {
  const key = dayKey(iso);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
}

function RecentActivity({ items, loading, error, onRetry }: { items: AccountEntry[]; loading: boolean; error: unknown; onRetry: () => void }) {
  if (error) return <ErrorState error={error} onRetry={onRetry} className="py-8" />;
  if (loading) {
    return (
      <div className="space-y-5 py-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3.5">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return <EmptyState icon={ReceiptText} title="No transactions yet" description="Money you send or receive will show up here." className="py-10" />;
  }
  const groups: Array<{ heading: string; items: AccountEntry[] }> = [];
  for (const item of items) {
    const heading = dayHeading(item.entry.createdAt);
    const last = groups[groups.length - 1];
    if (last?.heading === heading) last.items.push(item);
    else groups.push({ heading, items: [item] });
  }
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.heading}>
          <h3 className="group-label pb-1">{group.heading}</h3>
          <ul className="divide-y divide-border/70">
            {group.items.map(({ account, entry }) => {
              const credit = entry.entryType === 'CREDIT';
              const Icon = credit ? ArrowDownLeft : ArrowUpRight;
              return (
                <li key={`${account.id}:${entry.entryId}`} className="flex items-center gap-3.5 py-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/80" aria-hidden="true">
                    <Icon className="size-[18px]" strokeWidth={1.8} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium tracking-[-0.01em]">{entryLabel(entry)}</p>
                    <p className="truncate text-[13px] text-muted-foreground tnum">
                      <span className="hidden sm:inline">{ACCOUNT_TYPE_LABEL[account.accountType]} </span>
                      {maskAccountNumber(account.accountNumber)} · {formatTime(entry.createdAt)}
                    </p>
                  </div>
                  <Amount paise={entry.amountInPaise} direction={entry.entryType} className="text-[15px]" />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

