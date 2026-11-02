import { useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useApi, useUser } from '@/lib/auth/AuthProvider';
import { useLiveFraudAlerts } from '@/features/ops/useLiveFraudAlerts';
import { qk } from '@/lib/query';
import type { AlertStatus, FraudAlert } from '@/lib/api/types';
import { Badge, Callout, Card, Mono, PageHeader } from '@/components/ui/primitives';
import { DataTable, Pagination } from '@/components/ui/data';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { SecondAnalystBadge, SeverityBadge } from './components/badges';
import { LoadingAnnouncement } from './components/LoadingAnnouncement';
import { describeAlertReason, formatDateTime, formatListTime, type DescribedAlert } from './components/format';
import { useListParams } from './components/hooks';
import { DirectionGlyph, chevronColumn, rowListClass } from './components/layout';

const LIMIT = 20;

const TABS: Array<{ value: string; status: AlertStatus; label: string; empty: string }> = [
  { value: 'open', status: 'OPEN', label: 'Open', empty: 'No open alerts' },
  { value: 'under_review', status: 'UNDER_REVIEW', label: 'Under review', empty: 'No alerts under review' },
  { value: 'resolved', status: 'RESOLVED', label: 'Resolved', empty: 'No resolved alerts' },
  { value: 'dismissed', status: 'DISMISSED', label: 'Dismissed', empty: 'No dismissed alerts' },
];

function ReviewState({ alert, me }: { alert: FraudAlert; me: string }) {
  return (
    <span className="flex flex-wrap items-start gap-1">
      <SecondAnalystBadge />
      {alert.closeRequestedBy === me ? <Badge tone="neutral">Your proposal</Badge> : null}
    </span>
  );
}

/** What the row's button is called: the headline and the specifics, in the words on screen */
const summaryOf = (described: DescribedAlert) => {
  const details = described.reasons.map((r) => r.detail).filter(Boolean);
  return details.length ? `${described.headline}, ${details.join('; ')}` : described.headline;
};

export interface AlertRouteState {
  alert: FraudAlert;
  from: string;
  fromLabel: string;
}

export default function FraudAlertsPage() {
  const api = useApi();
  const user = useUser();
  const navigate = useNavigate();
  const location = useLocation();
  const { params, update, offset } = useListParams();
  const tab = TABS.find((t) => t.value === params.get('status')) ?? TABS[0]!;
  const triages = user.role === 'FRAUD_ANALYST';
  const now = Date.now();
  // New alerts arrive live: the list refreshes, and analysts get a quiet heads-up
  useLiveFraudAlerts({ notify: triages });

  const query = useQuery({
    queryKey: qk.alerts(tab.status, offset),
    queryFn: () => api.fraud.alerts({ status: tab.status, limit: LIMIT, offset }),
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === tab.status ? previous : undefined),
  });
  const rows = query.data;

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader
        title="Fraud alerts"
        description={triages ? 'Newest first. Closing a high or critical alert needs two analysts.' : 'Alerts raised by the risk rules, newest first.'}
      />
      {triages ? null : (
        <Callout tone="info" title="Read-only view">
          Only fraud analysts can triage alerts. You can see every alert and its history.
        </Callout>
      )}
      <Tabs
        value={tab.value}
        onValueChange={(value) => update({ status: value === 'open' ? undefined : value, offset: undefined })}
        className="space-y-4"
      >
        <TabsList aria-label="Alert status" className="w-full sm:w-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="flex-1 sm:flex-none">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab.value} className="mt-0">
          <Card className="overflow-hidden">
            <LoadingAnnouncement active={query.isFetching} label="Loading alerts…" />
            <DataTable<FraudAlert>
              className={rowListClass}
              caption={`${tab.label} fraud alerts`}
              rows={rows}
              loading={query.isPending}
              error={query.error}
              onRetry={() => void query.refetch()}
              getRowKey={(a) => a.id}
              empty={{ icon: ShieldCheck, title: tab.empty, description: tab.status === 'OPEN' ? 'New alerts appear here as soon as a rule fires.' : undefined }}
              onRowClick={(alert) =>
                navigate(`/fraud/${encodeURIComponent(alert.id)}`, {
                  state: { alert, from: `${location.pathname}${location.search}`, fromLabel: 'Fraud alerts' } satisfies AlertRouteState,
                })
              }
              rowActionLabel={(a) => `Open alert: ${summaryOf(describeAlertReason(a.reason))}`}
              columns={[
                {
                  key: 'reason',
                  header: 'Alert',
                  cell: (a) => {
                    const described = describeAlertReason(a.reason);
                    const details = described.reasons.map((r) => r.detail).filter(Boolean);
                    return (
                      <span className="flex min-w-0 items-start gap-3.5 py-0.5">
                        <DirectionGlyph direction={described.direction} className="mt-0.5 max-sm:hidden" />
                        <span className="flex min-w-0 flex-col items-start gap-0.5">
                          <span className="break-words text-[15px] font-medium leading-5 tracking-[-0.01em]">{described.headline}</span>
                          {/* Phones: the specifics, then "Incoming · 2:44 am". Wide screens: "Incoming · specifics" */}
                          <span className="flex flex-wrap gap-x-1 text-[13px] font-normal leading-[18px] text-muted-foreground">
                            {details.length ? (
                              <span className="line-clamp-2 w-full break-words md:order-2 md:w-auto md:flex-1 md:line-clamp-1">{details.join(' · ')}</span>
                            ) : null}
                            {described.direction ? (
                              <span className="md:order-1">
                                {described.direction}
                                {details.length ? (
                                  <span className="hidden md:inline" aria-hidden="true">
                                    {' '}
                                    ·
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                            <span className="md:hidden">
                              {described.direction ? '· ' : null}
                              <time dateTime={a.createdAt}>{formatListTime(a.createdAt, now)}</time>
                            </span>
                          </span>
                          {/* Small screens have no Review column: the four-eyes state goes under the reason */}
                          {a.closeRequestedBy ? (
                            <span className="mt-1 md:hidden">
                              <ReviewState alert={a} me={user.id} />
                            </span>
                          ) : null}
                        </span>
                      </span>
                    );
                  },
                },
                { key: 'severity', header: 'Severity', className: 'max-md:text-right', cell: (a) => <SeverityBadge severity={a.severity} /> },
                {
                  key: 'account',
                  header: 'Account',
                  hideOnMobile: true,
                  cell: (a) => <Mono value={a.accountId} />,
                },
                {
                  key: 'initiatedBy',
                  header: 'Initiated by',
                  hideOnMobile: true,
                  cell: (a) =>
                    a.initiatedBy === user.id ? (
                      <span className="text-[14px]">You</span>
                    ) : a.initiatedBy ? (
                      <Mono value={a.initiatedBy} />
                    ) : (
                      <span className="text-[14px] text-muted-foreground">Not recorded</span>
                    ),
                },
                {
                  key: 'created',
                  header: 'Raised',
                  hideOnMobile: true,
                  className: 'whitespace-nowrap',
                  cell: (a) => (
                    <time dateTime={a.createdAt} title={formatDateTime(a.createdAt)} className="text-[14px] text-muted-foreground tnum">
                      {formatListTime(a.createdAt, now)}
                    </time>
                  ),
                },
                {
                  key: 'review',
                  header: <span className="sr-only">Review</span>,
                  hideOnMobile: true,
                  cell: (a) => (a.closeRequestedBy ? <ReviewState alert={a} me={user.id} /> : null),
                },
                chevronColumn,
              ]}
            />
            {rows && (rows.length > 0 || offset > 0) ? (
              <Pagination offset={offset} limit={LIMIT} count={rows.length} onChange={(next) => update({ offset: next })} />
            ) : null}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
