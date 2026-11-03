import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import type { CashOperation, CashOperationStatus } from '@/lib/api/types';
import { CASH_TYPE_LABEL, PAGE_SIZE, StatusTabs, formatDateTime, keepPageWithinFilter, type StatusTab } from '@/features/branch/components/cash';
import { Pagination } from '@/components/ui/data';
import { RowTable, type RowColumn } from '@/features/branch/components/RowTable';
import { Amount, Card, Mono, PageHeader, StatusBadge } from '@/components/ui/primitives';

type Filter = 'ALL' | CashOperationStatus;

const TABS: ReadonlyArray<StatusTab<Filter>> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'EXECUTED', label: 'Executed' },
  { value: 'REJECTED', label: 'Rejected' },
];

const EMPTY: Record<Filter, { title: string; description: string }> = {
  ALL: { title: 'No cash operations yet', description: 'Deposits and withdrawals you handle at your desk appear here.' },
  PENDING_APPROVAL: { title: 'Nothing waiting for approval', description: 'Large operations you send to a supervisor appear here until they decide.' },
  EXECUTED: { title: 'No completed operations', description: 'Deposits and withdrawals that went through appear here.' },
  REJECTED: { title: 'No rejected operations', description: 'Operations a supervisor rejected, or that expired, appear here.' },
};

const COLUMNS: RowColumn<CashOperation>[] = [
  { key: 'type', header: 'Type', phone: 'title', cell: (op) => <span className="font-medium tracking-[-0.01em]">{CASH_TYPE_LABEL[op.type]}</span> },
  {
    key: 'time',
    header: 'Time',
    phone: 'detail',
    cell: (op) => <span className="whitespace-nowrap tnum md:text-muted-foreground">{formatDateTime(op.createdAt)}</span>,
  },
  { key: 'status', header: 'Status', phone: 'detail', cell: (op) => <StatusBadge status={op.status} /> },
  { key: 'account', header: 'Account', phone: 'hidden', cell: (op) => <Mono value={op.accountId} /> },
  {
    key: 'decided',
    header: 'Decided',
    phone: 'hidden',
    cell: (op) =>
      op.decidedAt ? (
        <span className="whitespace-nowrap text-muted-foreground tnum">{formatDateTime(op.decidedAt)}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'amount', header: 'Amount', align: 'right', phone: 'end', cell: (op) => <Amount paise={op.amountInPaise} className="font-semibold" /> },
];

export default function TellerOperationsPage() {
  const api = useApi();
  const [filter, setFilter] = useState<Filter>('ALL');
  const [offset, setOffset] = useState(0);
  const status = filter === 'ALL' ? undefined : filter;

  const query = useQuery({
    queryKey: qk.cashOperations(status, offset),
    queryFn: () => api.teller.cashOperations({ status, limit: PAGE_SIZE, offset }),
    placeholderData: keepPageWithinFilter(status),
    // A supervisor decides pending operations: keep that tab current while it's open
    refetchInterval: filter === 'PENDING_APPROVAL' ? 15_000 : false,
  });

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader
        title="My operations"
        description="Cash deposits and withdrawals you’ve handled. Those above your approval limits wait here until a supervisor decides."
      />
      <StatusTabs
        label="Filter by status"
        tabs={TABS}
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setOffset(0);
        }}
      >
        <Card className="overflow-hidden">
          <RowTable
            caption="Your cash operations"
            columns={COLUMNS}
            rows={query.data}
            getRowKey={(op) => op.id}
            loading={query.isFetching}
            error={query.error}
            onRetry={() => void query.refetch()}
            empty={offset > 0 ? { icon: ReceiptText, title: 'No more operations', description: 'Go back to see earlier pages.' } : { icon: ReceiptText, ...EMPTY[filter] }}
            className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}
          />
          {query.data && (query.data.length > 0 || offset > 0) ? (
            <Pagination offset={offset} limit={PAGE_SIZE} count={query.data.length} onChange={setOffset} />
          ) : null}
        </Card>
      </StatusTabs>
    </div>
  );
}
