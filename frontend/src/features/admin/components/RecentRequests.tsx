import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Stamp } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { ErrorState } from '@/components/ui/data';
import { Badge, EmptyState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { RelativeTime, RequestSubject } from './People';
import { isExpired, requestTargetId, requestTitle } from './requests';
import { Panel } from './Panel';
import { useUserLookup } from './useUserLookup';

const RECENT = 5;

export function RecentRequests({ now, className }: { now: number; className?: string }) {
  const api = useApi();
  const query = useQuery({
    // Same family as the Approvals lists, so deciding a request refreshes this too
    queryKey: [...qk.adminRequests(undefined, 0), { limit: RECENT }],
    queryFn: () => api.admin.requests({ limit: RECENT }),
  });
  const rows = query.data;
  const resolve = useUserLookup(rows?.map(requestTargetId) ?? []);

  let body;
  if (query.isPending) {
    body = (
      <div className="space-y-4 py-1">
        <span className="sr-only">Loading</span>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-52 max-w-full" />
          </div>
        ))}
      </div>
    );
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-6" />;
  } else if (!rows || rows.length === 0) {
    body = (
      <EmptyState
        icon={Stamp}
        title="No administrative requests yet"
        description="Requests to add staff, change someone’s sign-in or reset an authenticator appear here."
        className="py-8"
      />
    );
  } else {
    body = (
      <ul className="divide-y divide-border/70">
        {rows.map((request) => (
          <li key={request.id} className="flex items-start gap-3 py-3 first:pt-1 last:pb-1">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium leading-5 tracking-[-0.01em]">{requestTitle(request)}</p>
              <p className="mt-0.5 flex min-w-0 items-baseline gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground">
                <span className="min-w-0 truncate">
                  <RequestSubject request={request} resolve={resolve} withRole={false} />
                </span>
                <span aria-hidden="true">·</span>
                <RelativeTime iso={request.createdAt} now={now} past className="shrink-0 whitespace-nowrap" />
              </p>
            </div>
            {isExpired(request, now) ? (
              <Badge tone="danger" dot className="shrink-0">
                Expired
              </Badge>
            ) : (
              <StatusBadge status={request.status} className="shrink-0" />
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Panel
      title="Recent requests"
      action={
        <Link to="/approvals" aria-label="View all requests" className="text-[14px] font-medium text-primary hover:underline">
          View all
        </Link>
      }
      className={className}
    >
      {body}
    </Panel>
  );
}
