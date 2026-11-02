import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, MonitorSmartphone, Smartphone } from 'lucide-react';
import { isApiError } from '@/lib/api/errors';
import { notifySuccess } from '@/lib/notify';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { ConfirmDialog } from '@/components/ui/overlays';
import { Badge, EmptyState, Skeleton } from '@/components/ui/primitives';
import { LoadingAnnouncement } from '@/features/staff/components/LoadingAnnouncement';
import { formatDateTime } from '@/features/staff/components/format';
import { Panel } from '@/features/staff/components/layout';
import { timeAgo } from '@/features/admin/components/format';
import { opsKeys, useOpsApi, type UserSession } from './api';
import { notifyOpsError } from './notify';

const PHONE = /iphone|ipad|ios|android|mobile/i;

/** A bare device glyph: what kind of device, never a tinted tile */
function DeviceGlyph({ label }: { label: string }) {
  const Icon = PHONE.test(label) ? Smartphone : /windows|mac|linux|chrome ?os/i.test(label) ? Laptop : MonitorSmartphone;
  return <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />;
}

const lastActive = (session: UserSession) => (session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0) || new Date(session.createdAt).getTime();

/**
 * A person's signed-in sessions: device, network (masked by the API), when it started and was last used, and
 * whether the second factor was used. Bank administrators can sign a session out remotely; support can look.
 */
export function UserSessionsPanel({
  userId,
  name,
  canRevoke,
  className,
}: {
  userId: string;
  /** Who, in dialog copy ("Sign Asha Rao out of …") */
  name: string;
  canRevoke: boolean;
  className?: string;
}) {
  const ops = useOpsApi();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<UserSession | null>(null);
  const query = useQuery({
    queryKey: opsKeys.sessions(userId),
    // Someone with no sign-in has no sessions
    queryFn: () => ops.security.sessions(userId).catch((error) => (isApiError(error) && error.status === 404 ? [] : Promise.reject(error))),
  });
  const sessions = query.data ? [...query.data].sort((a, b) => lastActive(b) - lastActive(a)) : undefined;
  const now = Date.now();

  const revoke = async (session: UserSession) => {
    try {
      await ops.security.revokeSession(userId, session.id);
      notifySuccess('Signed out', `${name} is signed out of ${session.deviceLabel}.`);
    } catch (error) {
      if (!isApiError(error) || error.status !== 404) {
        notifyOpsError(error);
        throw error;
      }
      notifySuccess('Session already ended', 'It was signed out or expired before you got to it.');
    }
    await queryClient.invalidateQueries({ queryKey: opsKeys.sessions(userId) });
  };

  let body;
  if (query.isPending) {
    body = (
      <div className="space-y-4 py-1" aria-hidden="true">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        ))}
      </div>
    );
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-6" />;
  } else if (!sessions?.length) {
    body = <EmptyState icon={MonitorSmartphone} title="No active sessions" description="They’re not signed in anywhere right now." className="py-8" />;
  } else {
    body = (
      <ul className="-my-1 divide-y divide-border/70">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-start gap-3 py-3">
            <DeviceGlyph label={session.deviceLabel} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium leading-5 tracking-[-0.01em]">
                <span className="min-w-0 break-words">{session.deviceLabel}</span>
                {session.current ? <Badge>This device</Badge> : null}
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground">
                <span className={cn(session.ipMasked && 'font-mono text-[12.5px]')}>{session.ipMasked ?? 'Address not recorded'}</span>
                {session.lastSeenAt ? (
                  <span className="whitespace-nowrap">
                    <span aria-hidden="true">· </span>
                    <time dateTime={session.lastSeenAt} title={formatDateTime(session.lastSeenAt)} className="tnum">
                      Active {timeAgo(session.lastSeenAt, now)}
                    </time>
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground">
                <span className="tnum">Signed in {formatDateTime(session.createdAt)}</span>
                <span className="whitespace-nowrap">
                  <span aria-hidden="true">· </span>
                  {session.mfa ? 'With two-factor' : <span className="font-medium text-foreground">Password only</span>}
                </span>
              </p>
            </div>
            {canRevoke && !session.current ? (
              <Button
                variant="ghost"
                size="sm"
                className="-mr-2 shrink-0 text-destructive max-md:h-11"
                aria-label={`Sign out ${session.deviceLabel}${session.ipMasked ? `, ${session.ipMasked}` : ''}`}
                onClick={() => setRevoking(session)}
              >
                Sign out
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Panel title="Sessions and devices" description="Where they’re signed in. Addresses show the network only." className={className}>
      <LoadingAnnouncement active={query.isFetching} label="Loading sessions…" />
      {body}
      {revoking ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRevoking(null)}
          title={`Sign ${name} out of ${revoking.deviceLabel}?`}
          description="That device is signed out straight away and has to sign in again. Their other sessions aren’t affected."
          confirmLabel="Sign out"
          tone="destructive"
          onConfirm={() => revoke(revoking)}
        />
      ) : null}
    </Panel>
  );
}
