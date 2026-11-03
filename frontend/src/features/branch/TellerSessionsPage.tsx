import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Vault } from 'lucide-react';
import { useApi, useUser } from '@/lib/auth/AuthProvider';
import { isApiError } from '@/lib/api/errors';
import type { TellerSession, TellerSessionStatus } from '@/lib/api/types';
import { formatPaise } from '@/lib/money';
import { notifyError, notifySuccess } from '@/lib/notify';
import { qk } from '@/lib/query';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/data';
import { Amount, Badge, Callout, Card, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlays';
import {
  Discrepancy,
  PAGE_SIZE,
  StatusTabs,
  formatBusinessDate,
  formatTimeOnDay,
  keepPageWithinFilter,
  settledByDispute,
  useStaffDirectory,
  type StatusTab,
  type SupervisorSession,
} from './components/cash';
import { RowTable, type RowColumn } from './components/RowTable';
import { IssueFloatDialog, SignOffDialog } from './components/SessionDialogs';

type Filter = 'ALL' | TellerSessionStatus;

const TABS: ReadonlyArray<StatusTab<Filter>> = [
  { value: 'ALL', label: 'All' },
  { value: 'ISSUED', label: 'Issued' },
  { value: 'OPEN', label: 'Open' },
  { value: 'CLOSED', label: 'Awaiting sign-off' },
  { value: 'RECONCILED', label: 'Reconciled' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/**
 * Only "awaiting sign-off" asks something of an administrator, so only it is amber; an open desk is live
 * (green); everything else is settled or waiting on the teller (grey).
 */
const STATUS_BADGE: Record<TellerSessionStatus, { label: string; tone: BadgeTone }> = {
  ISSUED: { label: 'Float issued', tone: 'neutral' },
  OPEN: { label: 'Open', tone: 'success' },
  CLOSED: { label: 'Awaiting sign-off', tone: 'warning' },
  RECONCILED: { label: 'Reconciled', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const EMPTY: Record<Filter, { title: string; description: string }> = {
  ALL: { title: 'No teller sessions yet', description: 'A teller’s day starts when an administrator issues their opening float.' },
  ISSUED: { title: 'No floats waiting to be accepted', description: 'Floats appear here until the teller counts and accepts them.' },
  OPEN: { title: 'No open sessions', description: 'Tellers serving customers right now appear here.' },
  CLOSED: { title: 'Nothing awaiting sign-off', description: 'Sessions appear here once a teller declares their closing count.' },
  RECONCILED: { title: 'No signed-off sessions', description: 'Counted and signed-off days appear here.' },
  CANCELLED: { title: 'No cancelled floats', description: 'Floats withdrawn before the teller accepted them appear here.' },
};

/** The latest thing that happened to a session, for scanning the list */
function lastActivity(s: TellerSession): { label: string; at: string | null } {
  if (s.signedOffAt) return { label: 'Signed off', at: s.signedOffAt };
  if (s.closedAt) return { label: 'Closed', at: s.closedAt };
  if (s.acceptedAt) return { label: 'Accepted', at: s.acceptedAt };
  return { label: s.status === 'CANCELLED' ? 'Issued, then cancelled' : 'Issued', at: s.openedAt };
}

export default function TellerSessionsPage() {
  const api = useApi();
  const user = useUser();
  const queryClient = useQueryClient();
  const canAct = user.role === 'BANK_ADMIN';
  const [filter, setFilter] = useState<Filter>('ALL');
  const [offset, setOffset] = useState(0);
  const [issuing, setIssuing] = useState(false);
  const [cancelling, setCancelling] = useState<TellerSession | null>(null);
  const [signingOff, setSigningOff] = useState<SupervisorSession | null>(null);
  const status = filter === 'ALL' ? undefined : filter;

  const tellers = useStaffDirectory('TELLER');
  const admins = useStaffDirectory('BANK_ADMIN');
  const query = useQuery({
    queryKey: qk.sessions(status, offset),
    queryFn: () => api.supervisor.sessions({ status, limit: PAGE_SIZE, offset }),
    placeholderData: keepPageWithinFilter(status),
    refetchInterval: 30_000,
  });

  const adminLabel = (id: string | null) => (id && id === user.id ? 'you' : admins.label(id));

  const cancelFloat = async (session: TellerSession) => {
    try {
      await api.supervisor.cancelFloat(session.id);
      notifySuccess('Float cancelled', `${tellers.label(session.tellerId)}’s float for ${formatBusinessDate(session.businessDate)} was withdrawn.`);
    } catch (error) {
      notifyError(error, 'Float not cancelled');
      // Already accepted or cancelled elsewhere: show the latest state instead of offering a pointless retry
      if (!(isApiError(error) && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND'))) throw error;
    } finally {
      void queryClient.invalidateQueries({ queryKey: qk.sessionsAll });
    }
  };

  const columns: RowColumn<SupervisorSession>[] = [
    {
      key: 'teller',
      header: 'Teller',
      phone: 'title',
      cell: (s) => {
        const label = tellers.label(s.tellerId);
        return (
          <span className="block truncate font-medium tracking-[-0.01em] md:max-w-[17rem]" title={label}>
            {label}
          </span>
        );
      },
    },
    {
      key: 'date',
      header: 'Business date',
      phone: 'detail',
      cell: (s) => <span className="whitespace-nowrap">{formatBusinessDate(s.businessDate)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      phone: 'end',
      cell: (s) => {
        const badge = STATUS_BADGE[s.status];
        const activity = lastActivity(s);
        return (
          <div className="space-y-1">
            <Badge tone={badge.tone} dot>
              {badge.label}
            </Badge>
            <p className="whitespace-nowrap text-[12.5px] leading-4 text-muted-foreground max-md:hidden">
              {activity.label} <span className="tnum">{formatTimeOnDay(activity.at, s.businessDate)}</span>
            </p>
          </div>
        );
      },
    },
    {
      key: 'float',
      header: 'Opening float',
      align: 'right',
      phone: 'detail',
      cell: (s) => (
        <span className="whitespace-nowrap">
          <span className="md:hidden">Float </span>
          <Amount paise={s.openingFloat} className="max-md:font-normal" />
        </span>
      ),
    },
    {
      key: 'closeout',
      header: 'Close-out',
      phone: 'block',
      cell: (s) =>
        s.status === 'RECONCILED' ? (
          <div className="space-y-0.5 text-[13px] leading-[18px] md:min-w-[12rem]">
            <Discrepancy paise={s.discrepancy} className="text-[14px] max-md:text-[13px]" />
            <p className="tnum text-muted-foreground">
              Declared {formatPaise(s.declaredClosing)} · Expected {formatPaise(s.expectedClosing)}
            </p>
            {settledByDispute(s) ? <p className="font-medium text-warning">Settled by two administrators’ matching counts</p> : null}
            <p className="text-muted-foreground">Signed off by {adminLabel(s.signedOffBy)}</p>
          </div>
        ) : s.status === 'CLOSED' && s.disputedBy ? (
          // A first supervisor disagreed with the teller: who, never the figure
          <div className="space-y-0.5 text-[13px] leading-[18px] md:min-w-[12rem]">
            <p className="font-medium text-warning">Count disputed</p>
            <p className="text-muted-foreground">
              Disputed by {adminLabel(s.disputedBy)} · needs {s.disputedBy === user.id ? 'a different' : 'a second'} administrator’s count
            </p>
          </div>
        ) : s.status === 'CLOSED' ? (
          // Declared and expected figures stay hidden until a supervisor has counted blind
          <span className="text-[13px] text-muted-foreground">Awaiting count</span>
        ) : null,
    },
    ...(canAct
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            phone: 'action' as const,
            cell: (s: SupervisorSession) =>
              s.status === 'ISSUED' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="max-md:h-11 max-md:w-full max-md:text-[15px]"
                  aria-label={`Cancel float for ${tellers.label(s.tellerId)}`}
                  onClick={() => setCancelling(s)}
                >
                  Cancel float
                </Button>
              ) : s.status === 'CLOSED' ? (
                <Button
                  size="sm"
                  className="max-md:h-11 max-md:w-full max-md:text-[15px]"
                  aria-label={`Count and sign off for ${tellers.label(s.tellerId)}`}
                  onClick={() => setSigningOff(s)}
                >
                  Count and sign off
                </Button>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader
        title="Teller sessions"
        description="Opening floats, closing counts and sign-off for every teller’s business day."
        actions={
          canAct ? (
            <Button onClick={() => setIssuing(true)}>
              <Plus aria-hidden="true" /> Issue opening float
            </Button>
          ) : null
        }
      />
      {canAct ? null : (
        <Callout tone="info" title="Read-only">
          Only bank administrators can issue floats, cancel them or sign off sessions.
        </Callout>
      )}
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
            caption="Teller sessions"
            columns={columns}
            rows={query.data}
            getRowKey={(s) => s.id}
            loading={query.isFetching}
            error={query.error}
            onRetry={() => void query.refetch()}
            empty={offset > 0 ? { icon: Vault, title: 'No more sessions', description: 'Go back to see earlier pages.' } : { icon: Vault, ...EMPTY[filter] }}
            className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}
          />
          {query.data && (query.data.length > 0 || offset > 0) ? (
            <Pagination offset={offset} limit={PAGE_SIZE} count={query.data.length} onChange={setOffset} />
          ) : null}
        </Card>
      </StatusTabs>

      {canAct ? (
        <>
          <IssueFloatDialog
            open={issuing}
            onOpenChange={setIssuing}
            tellers={tellers.users}
            tellersLoading={tellers.query.isPending}
            tellersError={tellers.query.error}
            onRetryTellers={() => void tellers.query.refetch()}
          />
          <ConfirmDialog
            open={cancelling !== null}
            onOpenChange={(open) => !open && setCancelling(null)}
            title="Cancel this float?"
            description={
              cancelling
                ? `${tellers.label(cancelling.tellerId)}’s opening float of ${formatPaise(cancelling.openingFloat)} for ${formatBusinessDate(cancelling.businessDate)} will be withdrawn. Nothing has been booked yet: take the cash back into the vault. You can issue a new float afterwards.`
                : undefined
            }
            confirmLabel="Cancel float"
            cancelLabel="Keep float"
            tone="destructive"
            onConfirm={() => (cancelling ? cancelFloat(cancelling) : undefined)}
          />
          <SignOffDialog
            session={signingOff}
            tellerLabel={signingOff ? tellers.label(signingOff.tellerId) : ''}
            dispute={
              signingOff?.disputedBy
                ? { byYou: signingOff.disputedBy === user.id, byLabel: adminLabel(signingOff.disputedBy) }
                : null
            }
            onOpenChange={(open) => !open && setSigningOff(null)}
          />
        </>
      ) : null}
    </div>
  );
}
