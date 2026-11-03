import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import type { AlertStatus, FraudAlertEvent } from '@/lib/api/types';
import { ErrorState } from '@/components/ui/data';
import { Skeleton } from '@/components/ui/primitives';
import { Timeline } from './Timeline';
import { Panel } from './layout';
import { ALERT_STATUS_LABEL, shortId } from './format';

/** The service records a proposal as "Proposed RESOLVED: <note>" */
const PROPOSAL = /^Proposed (RESOLVED|DISMISSED)(?::\s*([\s\S]*))?$/;

function describeEvent(event: FraudAlertEvent): { title: string; note: string | null } {
  const proposal = event.note ? PROPOSAL.exec(event.note) : null;
  if (proposal) {
    return { title: `Proposed ${ALERT_STATUS_LABEL[proposal[1] as AlertStatus]}`, note: proposal[2] || null };
  }
  const title =
    event.fromStatus === event.toStatus
      ? `Kept ${ALERT_STATUS_LABEL[event.toStatus].toLowerCase()}`
      : `${ALERT_STATUS_LABEL[event.fromStatus]} → ${ALERT_STATUS_LABEL[event.toStatus]}`;
  return { title, note: event.note };
}

export function AlertHistoryCard({ alertId, me, className }: { alertId: string; me: string; className?: string }) {
  const api = useApi();
  const query = useQuery({ queryKey: qk.alertHistory(alertId), queryFn: () => api.fraud.history(alertId) });

  return (
    <Panel title="History" description="Oldest first. Every status change is attributed to the analyst who made it." className={className}>
      {query.isPending ? (
        <div className="space-y-4 pt-1" aria-hidden="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-6" />
      ) : query.data.length === 0 ? (
        <p className="pt-1 text-[14px] text-muted-foreground">
          <History className="mr-1.5 inline size-4 -translate-y-px" aria-hidden="true" />
          No activity yet. Nobody has triaged this alert.
        </p>
      ) : (
        <Timeline
          label="Alert history"
          className="pt-1"
          items={query.data.map((event) => {
            const { title, note } = describeEvent(event);
            return {
              id: event.id,
              title,
              actor: event.actorId === me ? 'You' : <span title={event.actorId}>Analyst {shortId(event.actorId)}</span>,
              at: event.createdAt,
              children: note ? <p className="whitespace-pre-wrap break-words text-foreground/80">{note}</p> : null,
            };
          })}
        />
      )}
    </Panel>
  );
}
