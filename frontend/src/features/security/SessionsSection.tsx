import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';
import type { DeviceSession } from '@/lib/api/types';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { notifyError, notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Badge, Skeleton } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlays';
import { Section } from './Section';

const ACTIVE_NOW_MS = 5 * 60_000;
const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** A phone, a tablet or a computer, read from the device label ("Safari on iPhone") */
export function DeviceIcon({ label, className }: { label: string; className?: string }) {
  const Icon = /ipad|tablet/i.test(label) ? Tablet : /iphone|android|mobile|ios\b/i.test(label) ? Smartphone : Monitor;
  return <Icon className={className} strokeWidth={1.7} aria-hidden="true" />;
}

function lastActive(session: DeviceSession): string {
  if (session.current) return 'Active now';
  if (!session.lastSeenAt) return 'Not used since signing in';
  const at = new Date(session.lastSeenAt);
  return Date.now() - at.getTime() < ACTIVE_NOW_MS ? 'Active now' : `Last active ${formatDistanceToNowStrict(at, { addSuffix: true })}`;
}

const newestFirst = (a: DeviceSession, b: DeviceSession) => (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt);

/** Every browser and device signed in to this account, with remote sign-out */
export function SessionsSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: qk.deviceSessions, queryFn: () => api.security.sessions() });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const list = [...(sessions.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || newestFirst(a, b));
  const others = list.filter((s) => !s.current);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.deviceSessions }),
      queryClient.invalidateQueries({ queryKey: qk.securityEvents }),
    ]);

  const signOut = async (session: DeviceSession) => {
    setRevoking(session.id);
    try {
      await api.security.revokeSession(session.id);
      await refresh();
      notifySuccess('Device signed out', `${session.deviceLabel} has been signed out.`);
    } catch (error) {
      notifyError(error);
    } finally {
      setRevoking(null);
    }
  };

  const signOutOthers = async () => {
    const count = others.length;
    try {
      const result = await api.security.revokeOtherSessions();
      const revoked = result?.revoked ?? count;
      await refresh();
      notifySuccess(`Signed out of ${revoked} other device${revoked === 1 ? '' : 's'}`, 'Only this device is still signed in.');
    } catch (error) {
      notifyError(error);
      throw error;
    }
  };

  return (
    <Section title="Sessions and devices" description="Where your account is signed in. Sign out anything you don’t recognise.">
      {sessions.isError ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} className="py-8" />
      ) : sessions.isPending ? (
        <div className="space-y-4 py-1" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3.5">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <ul aria-label="Signed-in devices" className="-mx-5 divide-y divide-border/70 border-y border-border/70 sm:-mx-6">
            {list.map((session) => (
              <li key={session.id} className="flex items-center gap-3.5 px-5 py-3.5 sm:px-6">
                <span className="flex size-10 shrink-0 items-center justify-center text-muted-foreground">
                  <DeviceIcon label={session.deviceLabel} className="size-[22px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium tracking-[-0.01em]">
                    <span className="min-w-0 break-words">{session.deviceLabel}</span>
                    {session.current ? <Badge>This device</Badge> : null}
                  </p>
                  <p className="text-[13px] leading-[18px] text-muted-foreground tnum">
                    {lastActive(session)}
                    {session.ipMasked ? ` · ${session.ipMasked}` : ''}
                  </p>
                  <p className="text-[13px] leading-[18px] text-muted-foreground">
                    Signed in {dateFormat.format(new Date(session.createdAt))}
                    {session.mfa ? ' with two-factor' : ''}
                  </p>
                </div>
                {session.current ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-10 shrink-0 px-4 sm:h-8"
                    loading={revoking === session.id}
                    disabled={revoking !== null && revoking !== session.id}
                    aria-label={`Sign out ${session.deviceLabel}`}
                    onClick={() => void signOut(session)}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {others.length ? (
            <div className="pt-4">
              <Button variant="secondary" onClick={() => setConfirming(true)}>
                <LogOut aria-hidden="true" /> Sign out everywhere else
              </Button>
            </div>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="destructive"
        title="Sign out everywhere else?"
        description={`This signs out ${others.length} other device${others.length === 1 ? '' : 's'}. You’ll stay signed in here.`}
        confirmLabel="Sign out other devices"
        onConfirm={signOutOthers}
      />
    </Section>
  );
}
