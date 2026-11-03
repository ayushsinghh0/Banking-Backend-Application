import { Link } from 'react-router';
import { ChevronRight, RotateCw, Snowflake, Wallet } from 'lucide-react';
import type { BankAccount } from '@/lib/api/types';
import { formatPaise } from '@/lib/money';
import { maskAccountNumber } from '@/lib/validation';
import { BrandMark } from '@/components/layout/Brand';
import { ErrorState } from '@/components/ui/data';
import { Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useAccounts, useBalances, useProfile } from './hooks';
import { accountShortName, accountTitle } from './lib';
import { AccountCardFace, AccountSwatch } from './components/AccountCard';
import { AccountNumber } from './components/AccountNumber';
import { KycNotice } from './components/KycNotice';
import { OpenAccountButton } from './components/OpenAccountDialog';
import { Panel } from './components/Panel';

type BalanceState = ReturnType<typeof useBalances>[number];

export default function AccountsPage() {
  const profileQuery = useProfile();
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data;
  const open = (accounts ?? []).filter((a) => a.status !== 'CLOSED');
  const closed = (accounts ?? []).filter((a) => a.status === 'CLOSED');
  const balanceQueries = useBalances(open.map((a) => a.id));
  const balanceOf = new Map(open.map((a, i) => [a.id, balanceQueries[i]]));
  const kycStatus = profileQuery.isSuccess ? (profileQuery.data?.kycStatus ?? null) : undefined;

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="large-title">Accounts</h1>
        {open.length ? <OpenAccountButton kycStatus={kycStatus} showReason={false} /> : null}
      </div>

      <KycNotice profile={profileQuery.isSuccess ? profileQuery.data : undefined} />

      {accountsQuery.isError ? (
        <Card>
          <ErrorState error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} />
        </Card>
      ) : accountsQuery.isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6" aria-busy="true">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="aspect-[1.586/1] min-h-[196px] w-full rounded-[20px]" />
          ))}
        </div>
      ) : (
        <>
          {open.length === 0 ? (
            <Card>
              <EmptyState
                icon={Wallet}
                title={closed.length ? 'No open accounts' : 'No accounts yet'}
                description="Open a savings or current account. It’s ready to use as soon as it’s open."
                action={<OpenAccountButton kycStatus={kycStatus} size="lg" className="items-center text-center" />}
              />
            </Card>
          ) : (
            <ul aria-label="Your accounts" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
              {open.map((account) => (
                <li key={account.id}>
                  <AccountTile account={account} state={balanceOf.get(account.id)} />
                </li>
              ))}
            </ul>
          )}
          {closed.length ? <ClosedAccounts accounts={closed} /> : null}
        </>
      )}
    </div>
  );
}

/** A card per account, as in Wallet: the whole face opens the account; the number can be copied in place */
function AccountTile({ account, state }: { account: BankAccount; state: BalanceState | undefined }) {
  const frozen = account.status === 'FROZEN';
  return (
    <AccountCardFace
      account={account}
      className={[
        'group aspect-[1.586/1] min-h-[196px] transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-0.5 hover:shadow-elevated',
        'ring-offset-canvas has-[.card-link:focus-visible]:ring-2 has-[.card-link:focus-visible]:ring-ring has-[.card-link:focus-visible]:ring-offset-2',
      ].join(' ')}
    >
      <div className="flex h-full flex-col p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <Link
            to={`/accounts/${account.id}`}
            className="card-link text-[15px] font-semibold tracking-[-0.01em] outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            {accountTitle(account)}
          </Link>
          {frozen ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-full bg-white/15 px-2.5 text-[12px] font-semibold">
              <Snowflake className="size-3" aria-hidden="true" /> Frozen
            </span>
          ) : (
            <BrandMark className="size-6 text-white/90" />
          )}
        </div>

        <div className="mt-auto">
          <CardBalance account={account} state={state} />
          <p className="mt-1 text-[13px] text-white/80 tnum">Daily limit {formatPaise(account.dailyLimitPaise)}</p>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 sm:mt-4">
          <AccountNumber value={account.accountNumber} inverse className="relative z-10 -ml-0.5" />
          <ChevronRight
            className="size-5 shrink-0 text-white/60 transition-transform duration-200 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </div>
      </div>
    </AccountCardFace>
  );
}

function CardBalance({ account, state }: { account: BankAccount; state: BalanceState | undefined }) {
  if (!state || state.isPending) return <Skeleton className="h-8 w-40 bg-white/15 before:via-white/10" />;
  if (state.isError) {
    return (
      <p className="flex h-8 items-center gap-1 text-[15px] font-medium">
        Balance unavailable
        <button
          type="button"
          className="relative z-10 inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-white/90 transition-colors after:absolute after:-inset-1.5 hover:bg-white/15 hover:text-white focus-visible:ring-white focus-visible:ring-offset-0"
          aria-label={`Retry loading the balance of ${accountShortName(account)}`}
          onClick={() => void state.refetch()}
        >
          <RotateCw className="size-4" aria-hidden="true" />
        </button>
      </p>
    );
  }
  const text = formatPaise(state.data.balanceInPaise);
  const dot = text.lastIndexOf('.');
  return (
    <p className="text-[28px] font-semibold leading-8 tracking-[-0.03em] tnum">
      {text.slice(0, dot)}
      <span className="text-white/60">{text.slice(dot)}</span>
    </p>
  );
}

function ClosedAccounts({ accounts }: { accounts: BankAccount[] }) {
  return (
    <Panel title="Closed accounts" description="Their statements stay available.">
      <ul className="-mx-2">
        {accounts.map((account) => (
          <li key={account.id}>
            <Link
              to={`/accounts/${account.id}`}
              className="group flex min-h-[56px] items-center gap-3.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AccountSwatch type={account.accountType} className="saturate-0 opacity-60" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium tracking-[-0.01em]">{accountTitle(account)}</span>
                <span className="block text-[13px] text-muted-foreground tnum">{maskAccountNumber(account.accountNumber)}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
