import { useId } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import type { BankAccount, FraudAlert } from '@/lib/api/types';
import { formatAccountNumber } from '@/lib/validation';
import { Card } from '@/components/ui/primitives';
import { AlertStatusBadge, SeverityBadge } from './badges';
import { describeAlertReason, formatDateTime, shortId, type DescribedAlert } from './format';
import { CopyableId, Facts, RupeeFigure } from './layout';

const SEVERITY_TITLE = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' } as const;

/** The page title: what the alert is about, or its severity when the rule's wording isn't recognised */
export const alertTitle = (alert: FraudAlert, described: DescribedAlert = describeAlertReason(alert.reason)) =>
  described.known ? described.headline : `${SEVERITY_TITLE[alert.severity]}-severity alert`;

/** The header tile: what happened, how serious, where it stands, and the amount when the rule states it */
export function AlertOverview({ alert }: { alert: FraudAlert }) {
  const described = describeAlertReason(alert.reason);
  const title = alertTitle(alert, described);
  return (
    <Card className="px-6 py-6 sm:px-8 sm:py-7">
      <div className="flex flex-wrap items-center gap-2">
        {described.known ? <SeverityBadge severity={alert.severity} long /> : null}
        <AlertStatusBadge status={alert.status} />
      </div>
      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
        <div className="min-w-0">
          <h1 className="large-title text-balance">{title}</h1>
          <p className="mt-1.5 text-[15px] leading-[22px] text-muted-foreground">
            {described.direction ? <span>{described.direction}</span> : null}
            {described.direction ? ' · ' : null}
            Raised <time dateTime={alert.createdAt}>{formatDateTime(alert.createdAt)}</time>
          </p>
        </div>
        {described.amount ? (
          <div className="shrink-0 sm:text-right">
            <p className="text-[13px] font-medium text-muted-foreground">Amount</p>
            <RupeeFigure text={described.amount} className="text-[28px] font-semibold leading-9 tracking-[-0.03em] sm:text-[32px]" />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function AccountValue({ alert, account, failed }: { alert: FraudAlert; account: BankAccount | undefined; failed: boolean }) {
  const location = useLocation();
  if (!account) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <CopyableId value={alert.accountId} label="Copy account ID" />
        {failed ? <span className="text-[13px] text-muted-foreground">Account details unavailable</span> : null}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span>
        <span className="text-muted-foreground">{account.accountType === 'SAVINGS' ? 'Savings' : 'Current'} </span>
        <span className="tnum">{formatAccountNumber(account.accountNumber)}</span>
      </span>
      <Link
        to={`/customers/${encodeURIComponent(account.customerId)}`}
        state={{ from: `${location.pathname}${location.search}`, fromLabel: 'Fraud alert' }}
        className="text-[14px] font-medium text-primary hover:underline"
      >
        View customer
      </Link>
    </span>
  );
}

function InitiatorValue({ alert, account, me }: { alert: FraudAlert; account: BankAccount | undefined; me: string }) {
  if (!alert.initiatedBy) return <span className="text-muted-foreground">Not recorded</span>;
  if (alert.initiatedBy === me) return <>You</>;
  if (account && alert.initiatedBy === account.customerId) return <>Account holder</>;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      {alert.cashOperationId ? <span>Branch staff</span> : null}
      <CopyableId value={alert.initiatedBy} label="Copy staff ID" />
    </span>
  );
}

/** Why the alert fired and the records it points to */
export function AlertDetailsCard({ alert, me }: { alert: FraudAlert; me: string }) {
  const api = useApi();
  const reasonsId = useId();
  const account = useQuery({ queryKey: qk.account(alert.accountId), queryFn: () => api.accounts.get(alert.accountId) });
  const { reasons, known } = describeAlertReason(alert.reason);
  // A single recognised signal is already the page title: only its specifics are worth repeating
  const detailOnly = known && reasons.length === 1 && reasons[0]!.detail !== null;

  return (
    <Card className="px-5 py-5 sm:px-6 sm:py-6">
      <h2 id={reasonsId} className="text-headline">
        Why it was flagged
      </h2>
      <ul aria-labelledby={reasonsId} className="mt-3 divide-y divide-border/70">
        {reasons.map((reason, index) => (
          <li key={`${index}:${reason.text}`} className="py-3 first:pt-0 last:pb-0">
            {detailOnly ? (
              <p className="text-[15px] leading-[22px]">{reason.detail}</p>
            ) : (
              <>
                <p className="break-words text-[15px] font-medium leading-[22px] tracking-[-0.01em]">{reason.title}</p>
                {reason.detail ? <p className="text-[14px] leading-5 text-muted-foreground">{reason.detail}</p> : null}
              </>
            )}
          </li>
        ))}
      </ul>
      <Facts
        layout="aligned"
        className="mt-5 border-t border-border/70 pt-4"
        items={[
          { label: 'Transaction', value: <CopyableId value={alert.transactionId} label="Copy transaction ID" /> },
          { label: 'Account', value: <AccountValue alert={alert} account={account.data} failed={account.isError} /> },
          { label: 'Initiated by', value: <InitiatorValue alert={alert} account={account.data} me={me} /> },
          alert.cashOperationId ? { label: 'Branch cash operation', value: <CopyableId value={alert.cashOperationId} label="Copy cash operation ID" /> } : null,
          { label: 'Last updated', value: <time dateTime={alert.updatedAt}>{formatDateTime(alert.updatedAt)}</time> },
          {
            label: 'Last reviewed by',
            value: alert.reviewedBy ? (
              alert.reviewedBy === me ? (
                'You'
              ) : (
                <span title={alert.reviewedBy}>Analyst {shortId(alert.reviewedBy)}</span>
              )
            ) : (
              <span className="text-muted-foreground">Not yet reviewed</span>
            ),
          },
        ]}
      />
    </Card>
  );
}
