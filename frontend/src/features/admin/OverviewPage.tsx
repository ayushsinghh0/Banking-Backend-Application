import { useId } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useApi, useUser } from '@/lib/auth/AuthProvider';
import { formatPaise } from '@/lib/money';
import { qk } from '@/lib/query';
import { humanize, PageHeader } from '@/components/ui/primitives';
import { AuditBreachNotice, AuditIntegrityCard } from '@/features/ops/AuditIntegrityCard';
import { useLiveFraudAlerts } from '@/features/ops/useLiveFraudAlerts';
import { describeAlertReason, severityTone } from './components/alerts';
import { AttentionList, type AttentionItem } from './components/AttentionList';
import { CashStatusChart } from './components/CashStatusChart';
import { countLabel, durationSince, formatDate, greeting, nameFromEmail, waitedLongerThan } from './components/format';
import { KeyFigures, type KeyFigure, type KpiState } from './components/KpiCard';
import { PersonName, RequestSubject } from './components/People';
import { RecentRequests } from './components/RecentRequests';
import { isExpired, requestTargetId, requestTitle } from './components/requests';
import { useUserLookup, type ResolvePerson } from './components/useUserLookup';

/** The list APIs have no totals: one page of this size is counted, and a full page reads "100+" */
const QUEUE_LIMIT = 100;
const ATTENTION_ITEMS = 6;

/**
 * Each queue, and how long something may wait in it before the wait itself is news: a cash approval has a
 * customer standing at the counter, a teller can't go home until they're signed off, a four-eyes request
 * expires after a day.
 */
const QUEUES = {
  requests: { label: 'Pending four-eyes requests', href: '/approvals', urgentAfterMinutes: 12 * 60 },
  cash: { label: 'Cash awaiting approval', href: '/cash-operations', urgentAfterMinutes: 15 },
  sessions: { label: 'Teller sessions to sign off', href: '/teller-sessions', urgentAfterMinutes: 60 },
  alerts: { label: 'Open fraud alerts', href: '/fraud', urgentAfterMinutes: 4 * 60 },
} as const;

type QueueId = keyof typeof QUEUES;
type Pending = AttentionItem & { people: string[]; render: (resolve: ResolvePerson) => AttentionItem['detail'] };

function kpiState<T>(query: UseQueryResult<T[]>, waitingSince: (row: T) => string, queue: QueueId, now: number): KpiState {
  if (query.isPending) return { status: 'loading' };
  if (query.isError) return { status: 'error', retry: () => void query.refetch() };
  const rows = query.data;
  const count = rows.length;
  const oldest = rows.map(waitingSince).sort()[0];
  let hint = 'Nothing waiting';
  if (count >= QUEUE_LIMIT) hint = `Showing the newest ${QUEUE_LIMIT}`;
  else if (oldest) hint = `Oldest waiting ${durationSince(oldest, now)}`;
  return {
    status: 'ready',
    count,
    value: countLabel(count, QUEUE_LIMIT),
    hint,
    urgent: waitedLongerThan(oldest, QUEUES[queue].urgentAfterMinutes, now),
  };
}

export default function OverviewPage() {
  const api = useApi();
  const me = useUser();
  const queuesId = useId();
  const now = Date.now();
  const name = nameFromEmail(me.email);
  // A new fraud alert refreshes its queue figure at once (the toast is for analysts)
  useLiveFraudAlerts({ notify: false });

  // Each queue is its own query, so one failing service never blanks the page. Keys extend the shared
  // families (qk.*) so any decision made elsewhere also refreshes these counts.
  const requests = useQuery({
    queryKey: [...qk.adminRequests('PENDING', 0), { limit: QUEUE_LIMIT }],
    queryFn: () => api.admin.requests({ status: 'PENDING', limit: QUEUE_LIMIT }),
  });
  const cash = useQuery({
    queryKey: [...qk.cashOperations('PENDING_APPROVAL', 0), { limit: QUEUE_LIMIT }],
    queryFn: () => api.teller.cashOperations({ status: 'PENDING_APPROVAL', limit: QUEUE_LIMIT }),
  });
  const sessions = useQuery({
    queryKey: [...qk.sessions('CLOSED', 0), { limit: QUEUE_LIMIT }],
    queryFn: () => api.supervisor.sessions({ status: 'CLOSED', limit: QUEUE_LIMIT }),
  });
  const alerts = useQuery({
    queryKey: [...qk.alerts('OPEN', 0), { limit: QUEUE_LIMIT }],
    queryFn: () => api.fraud.alerts({ status: 'OPEN', limit: QUEUE_LIMIT }),
  });

  const sessionSince = (s: { closedAt: string | null; openedAt: string }) => s.closedAt ?? s.openedAt;

  const pending: Pending[] = [
    // Only requests this administrator can actually approve: not their own, not about them, not expired
    // (expired ones can only be cleared, and are flagged on the Approvals page)
    ...(requests.data ?? [])
      .filter((r) => r.requestedBy !== me.id && requestTargetId(r) !== me.id && !isExpired(r, now))
      .map<Pending>((r) => ({
        key: `request-${r.id}`,
        kind: 'Four-eyes request',
        title: requestTitle(r),
        since: r.createdAt,
        href: '/approvals',
        detail: null,
        people: [requestTargetId(r) ?? ''],
        render: (resolve) => (
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <RequestSubject request={r} resolve={resolve} />
          </p>
        ),
      })),
    ...(cash.data ?? []).map<Pending>((op) => ({
      key: `cash-${op.id}`,
      kind: 'Cash approval',
      title: `${humanize(op.type)} of ${formatPaise(op.amountInPaise)}`,
      since: op.createdAt,
      href: '/cash-operations',
      detail: null,
      people: [],
      render: () => (op.description ? <p>{op.description}</p> : null),
    })),
    ...(sessions.data ?? []).map<Pending>((s) => ({
      key: `session-${s.id}`,
      kind: 'Teller sign-off',
      title: 'Sign off teller session',
      since: sessionSince(s),
      href: '/teller-sessions',
      detail: null,
      people: [s.tellerId],
      render: (resolve) => (
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <PersonName person={resolve(s.tellerId)} />
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <span className="text-muted-foreground">Business day {formatDate(s.businessDate)}</span>
        </p>
      ),
    })),
    ...(alerts.data ?? []).map<Pending>((a) => {
      const described = describeAlertReason(a.reason);
      return {
        key: `alert-${a.id}`,
        kind: 'Fraud alert',
        title: described.title,
        tag: described.direction ?? undefined,
        badge: { label: humanize(a.severity), tone: severityTone(a.severity) },
        since: a.createdAt,
        href: `/fraud/${encodeURIComponent(a.id)}`,
        detail: null,
        people: [],
        render: () => (described.reasons.length ? described.reasons.map((reason) => <p key={reason}>{reason}</p>) : null),
      };
    }),
  ]
    .sort((x, y) => new Date(x.since).getTime() - new Date(y.since).getTime())
    .slice(0, ATTENTION_ITEMS);

  const resolve = useUserLookup(pending.flatMap((p) => p.people));
  const items: AttentionItem[] = pending.map(({ people: _people, render, ...item }) => ({ ...item, detail: render(resolve) }));

  const queries = { requests, cash, sessions, alerts };
  const failed = (Object.keys(queries) as QueueId[]).filter((k) => queries[k].isError).map((k) => QUEUES[k].label);
  const loading = Object.values(queries).some((q) => q.isPending);

  const figures: KeyFigure[] = [
    { id: 'requests', ...QUEUES.requests, state: kpiState(requests, (r) => r.createdAt, 'requests', now) },
    { id: 'cash', ...QUEUES.cash, state: kpiState(cash, (op) => op.createdAt, 'cash', now) },
    { id: 'sessions', ...QUEUES.sessions, state: kpiState(sessions, sessionSince, 'sessions', now) },
    { id: 'alerts', ...QUEUES.alerts, state: kpiState(alerts, (a) => a.createdAt, 'alerts', now) },
  ];

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader title={name ? `${greeting(new Date(now))}, ${name}` : greeting(new Date(now))} />
      <AuditBreachNotice />

      <section aria-labelledby={queuesId}>
        <h2 id={queuesId} className="sr-only">
          Queues
        </h2>
        <KeyFigures figures={figures} />
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
        <AttentionList items={items} loading={loading} failed={failed} now={now} className="lg:col-span-8 lg:self-start" />
        <div className="min-w-0 space-y-5 lg:col-span-4 lg:space-y-6">
          <CashStatusChart />
          <RecentRequests now={now} />
          <AuditIntegrityCard />
        </div>
      </div>
    </div>
  );
}
