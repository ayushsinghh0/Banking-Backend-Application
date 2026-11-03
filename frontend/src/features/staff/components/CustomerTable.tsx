import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { UserSearch } from 'lucide-react';
import type { CustomerProfile } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { DataTable, type Column } from '@/components/ui/data';
import { KycBadge, WaitingBadge } from './badges';
import { formatDateTime, formatListTime, maskPhone, waitingTime } from './format';
import { chevronColumn, rowListClass } from './layout';

export interface BackLink {
  from: string;
  fromLabel: string;
}

function Phone({ value }: { value: string }) {
  const masked = maskPhone(value);
  return (
    <span className="tnum whitespace-nowrap">
      <span aria-hidden="true">{masked}</span>
      <span className="sr-only">Phone ending in {value.slice(-4)}</span>
    </span>
  );
}

/**
 * Customer search results and the KYC queue. Each row reads as a list row: the name with the (masked) phone
 * under it, then the one value that matters for this list (waiting time, KYC status or date). A row opens
 * the customer record.
 */
export function CustomerTable({
  rows,
  loading,
  error,
  onRetry,
  empty,
  caption,
  showWaiting,
  showStatus,
  dateLabel,
  backLabel,
}: {
  rows: CustomerProfile[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  empty: { title: string; description?: ReactNode };
  caption: string;
  /** The pending queue: how long each profile has waited, escalating after a day */
  showWaiting: boolean;
  /** Lists that mix statuses show each customer's KYC status */
  showStatus: boolean;
  dateLabel: string;
  backLabel: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const now = Date.now();
  // On phones the row keeps one trailing value: the waiting time, else the status, else the date
  const dateTrails = !showWaiting && !showStatus;

  const columns: Column<CustomerProfile>[] = [
    {
      key: 'name',
      header: 'Customer',
      cell: (c) => (
        <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
          <span className="break-words text-[15px] font-medium leading-5 tracking-[-0.01em]">{c.fullName}</span>
          <span className="text-[13px] font-normal leading-[18px] text-muted-foreground">
            <Phone value={c.phoneNumber} />
          </span>
        </span>
      ),
    },
  ];
  if (showStatus) columns.push({ key: 'kyc', header: 'KYC status', className: 'max-md:text-right', cell: (c) => <KycBadge status={c.kycStatus} /> });
  columns.push({
    key: 'updated',
    header: dateLabel,
    hideOnMobile: !dateTrails,
    className: cn('whitespace-nowrap', dateTrails && 'max-md:text-right'),
    cell: (c) => (
      <time dateTime={c.updatedAt} title={formatDateTime(c.updatedAt)} className="text-[14px] text-muted-foreground tnum">
        {formatListTime(c.updatedAt, now)}
      </time>
    ),
  });
  if (showWaiting) {
    columns.push({
      key: 'waiting',
      header: 'Waiting',
      align: 'right',
      cell: (c) => {
        const wait = waitingTime(c.updatedAt, now);
        return <WaitingBadge label={wait.label} tone={wait.tone} />;
      },
    });
  }
  columns.push(chevronColumn);

  return (
    <DataTable
      className={rowListClass}
      columns={columns}
      rows={rows}
      getRowKey={(c) => c.userId}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={{ icon: UserSearch, ...empty }}
      caption={caption}
      onRowClick={(c) =>
        navigate(`/customers/${encodeURIComponent(c.userId)}`, {
          state: { from: `${location.pathname}${location.search}`, fromLabel: backLabel } satisfies BackLink,
        })
      }
      rowActionLabel={(c) => `Open ${c.fullName}`}
    />
  );
}
