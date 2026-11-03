import { Link, useLocation, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SearchX } from 'lucide-react';
import { useApi, useUser } from '@/lib/auth/AuthProvider';
import type { FraudAlert } from '@/lib/api/types';
import { UUID_PATTERN } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Callout, Card, EmptyState, PageHeader, Skeleton } from '@/components/ui/primitives';
import { AlertDetailsCard, AlertOverview } from './components/AlertDetailsCard';
import { AlertHistoryCard } from './components/AlertHistoryCard';
import { LoadingAnnouncement } from './components/LoadingAnnouncement';
import { TriagePanel } from './components/TriagePanel';
import { SCAN_MAX_PAGES, SCAN_PAGE_SIZE, alertKey, findAlert } from './components/alertLookup';
import { ALERT_STATUS_LABEL, shortId } from './components/format';
import { BackLink, Panel } from './components/layout';
import type { AlertRouteState } from './FraudAlertsPage';

/** The list hands over the alert it showed; only trust it for this exact alert */
function readRouteState(state: unknown, alertId: string): Partial<AlertRouteState> {
  const candidate = state as Partial<AlertRouteState> | null;
  const alert = candidate?.alert && candidate.alert.id === alertId ? candidate.alert : undefined;
  const from = typeof candidate?.from === 'string' && candidate.from.startsWith('/') && !candidate.from.startsWith('//') ? candidate.from : undefined;
  return {
    alert,
    from,
    fromLabel: from && typeof candidate?.fromLabel === 'string' ? candidate.fromLabel : undefined,
  };
}

function NotFound() {
  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader title="Alert not found" />
      <Card>
        <EmptyState
          icon={SearchX}
          title="We couldn’t find this alert"
          description={`It isn’t among the ${(SCAN_PAGE_SIZE * SCAN_MAX_PAGES).toLocaleString('en-IN')} most recent alerts, or the link is wrong. Open it from the alert list instead.`}
          action={
            <Button asChild variant="secondary">
              <Link to="/fraud">Back to fraud alerts</Link>
            </Button>
          }
        />
      </Card>
    </div>
  );
}

export default function FraudAlertDetailPage() {
  const { alertId = '' } = useParams();
  const api = useApi();
  const user = useUser();
  const location = useLocation();
  const queryClient = useQueryClient();
  const valid = UUID_PATTERN.test(alertId);
  const routeState = readRouteState(location.state, alertId);

  const query = useQuery({
    queryKey: alertKey(alertId),
    queryFn: async (): Promise<FraudAlert | null> => {
      const known = queryClient.getQueryData<FraudAlert | null>(alertKey(alertId)) ?? routeState.alert ?? null;
      return (await findAlert(api, alertId, known?.status)) ?? known;
    },
    enabled: valid,
    // Show what the list already had straight away, then confirm it with the API
    initialData: routeState.alert,
    initialDataUpdatedAt: 0,
  });

  if (!valid || query.data === null) return <NotFound />;

  const alert = query.data;
  const back = <BackLink to={routeState.from ?? '/fraud'} label={routeState.fromLabel ?? 'Fraud alerts'} />;

  if (!alert) {
    return (
      <div className="space-y-6 lg:space-y-8">
        {back}
        <LoadingAnnouncement active={query.isFetching} label="Loading alert…" />
        {query.isError ? (
          <>
            <PageHeader title="Fraud alert" />
            <Card>
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            </Card>
          </>
        ) : (
          <>
            <h1 className="sr-only">Fraud alert</h1>
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6" aria-hidden="true">
              <Card className="space-y-4 px-6 py-7 sm:px-8 lg:col-span-8">
                <Skeleton className="h-[22px] w-40 rounded-full" />
                <Skeleton className="h-9 w-72" />
                <Skeleton className="h-4 w-56" />
              </Card>
              <Card className="space-y-3 p-6 lg:col-span-4">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-11 w-full rounded-full" />
              </Card>
            </div>
          </>
        )}
      </div>
    );
  }

  const closed = alert.status === 'RESOLVED' || alert.status === 'DISMISSED';
  const proposal = !closed && alert.closeRequestedBy && alert.closeRequestedStatus ? alert : null;
  const analyst = user.role === 'FRAUD_ANALYST';

  return (
    <div className="space-y-6 lg:space-y-8">
      {back}
      {proposal ? (
        <Callout
          tone="warning"
          title={`${proposal.closeRequestedBy === user.id ? 'You' : `Analyst ${shortId(proposal.closeRequestedBy)}`} proposed ${
            ALERT_STATUS_LABEL[proposal.closeRequestedStatus!]
          } — a second analyst must confirm`}
        >
          High and critical alerts close only when two different analysts agree.
        </Callout>
      ) : null}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
        <section aria-label="Alert details" className="min-w-0 space-y-5 lg:col-span-8 lg:space-y-6">
          <AlertOverview alert={alert} />
          <AlertDetailsCard alert={alert} me={user.id} />
        </section>
        <div className="min-w-0 lg:col-span-4 lg:row-span-2 lg:self-start">
          {analyst ? (
            <TriagePanel alert={alert} me={user.id} />
          ) : (
            <Panel title="Triage">
              <p className="text-[14px] leading-5 text-muted-foreground">Read-only: only fraud analysts can triage alerts.</p>
            </Panel>
          )}
        </div>
        <AlertHistoryCard alertId={alert.id} me={user.id} className="min-w-0 lg:col-span-8" />
      </div>
    </div>
  );
}
