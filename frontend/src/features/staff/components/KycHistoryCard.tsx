import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import type { KycEvent } from '@/lib/api/types';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { ErrorState } from '@/components/ui/data';
import { Timeline } from './Timeline';
import { Panel } from './layout';
import { KYC_LABEL, detailEntries, kycActionLabel, shortId } from './format';

function Actor({ event, me }: { event: KycEvent; me: string }) {
  if (event.actorId === event.userId) return <>Customer</>;
  if (event.actorId === me) return <>You</>;
  return <span title={event.actorId}>Staff {shortId(event.actorId)}</span>;
}

function EventBody({ event }: { event: KycEvent }) {
  const entries = detailEntries(event.details);
  const changed = event.fromStatus !== event.toStatus && event.toStatus;
  if (!changed && !entries.length) return null;
  return (
    <div className="space-y-1.5">
      {changed ? (
        <p className="text-foreground/80">
          {event.fromStatus ? KYC_LABEL[event.fromStatus] : 'No status'} → {KYC_LABEL[event.toStatus!]}
        </p>
      ) : null}
      {entries.length ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px] leading-[18px]">
          {entries.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="text-muted-foreground">{entry.label}</dt>
              <dd className="min-w-0 break-words tnum">{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** Every KYC decision and identity change, newest first; details are shown as text, never as markup */
export function KycHistoryCard({ userId, me }: { userId: string; me: string }) {
  const api = useApi();
  const query = useQuery({ queryKey: qk.kycHistory(userId), queryFn: () => api.customers.kycHistory(userId) });

  return (
    <Panel title="KYC history" description="Newest first. Every decision and identity change is recorded.">
      {query.isPending ? (
        <div className="space-y-4 pt-1" aria-hidden="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-6" />
      ) : query.data.length === 0 ? (
        <EmptyState icon={History} title="No KYC activity yet" className="py-6" />
      ) : (
        <Timeline
          label="KYC history"
          className="pt-1"
          items={query.data.map((event) => ({
            id: event.id,
            title: kycActionLabel(event.action),
            actor: <Actor event={event} me={me} />,
            at: event.createdAt,
            children: <EventBody event={event} />,
          }))}
        />
      )}
    </Panel>
  );
}
