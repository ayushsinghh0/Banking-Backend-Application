import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { Ban, KeyRound, LogIn, LogOut, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { SecurityEvent } from '@/lib/api/types';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { cn } from '@/lib/cn';
import { ErrorState } from '@/components/ui/data';
import { Badge, EmptyState, Skeleton, humanize } from '@/components/ui/primitives';
import { Section } from './Section';

const RECENT = 20;
const dateTime = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export type SecurityEventKind = 'signin' | 'failed' | 'signout' | 'change' | 'blocked' | 'other';

const ICONS: Record<SecurityEventKind, typeof LogIn> = {
  signin: LogIn,
  failed: ShieldAlert,
  signout: LogOut,
  change: KeyRound,
  blocked: Ban,
  other: ShieldCheck,
};

/**
 * Plain words for a security event. Matched on the parts of the type, so `SIGN_IN_FAILED`, `LOGIN_FAILED`
 * and `sign_in.failed` all read the same.
 */
export function describeSecurityEvent(event: SecurityEvent): { label: string; kind: SecurityEventKind; newDevice: boolean } {
  const type = event.type.toUpperCase().replace(/[.\-\s]/g, '_');
  const newDevice = type.includes('NEW_DEVICE') || event.details?.newDevice === true;
  const failed = type.includes('FAIL');
  if (type.includes('MFA') && failed) return { label: 'Incorrect authenticator code', kind: 'failed', newDevice };
  if (failed) return { label: 'Sign-in attempt failed', kind: 'failed', newDevice };
  if (type.includes('NEW_DEVICE')) return { label: 'Signed in on a new device', kind: 'signin', newDevice };
  if (type.includes('REVOK')) return { label: 'Signed out remotely', kind: 'signout', newDevice };
  if (type.includes('PASSWORD')) return { label: 'Password changed', kind: 'change', newDevice };
  if (type.includes('BAN') || type.includes('BLOCK')) return { label: 'Sign-ins blocked from a network', kind: 'blocked', newDevice };
  if (type.includes('SIGN_IN') || type.includes('LOGIN') || type.includes('SIGNED_IN')) return { label: 'Signed in', kind: 'signin', newDevice };
  return { label: humanize(type), kind: 'other', newDevice };
}

function when(iso: string): string {
  const at = new Date(iso);
  return Date.now() - at.getTime() < 24 * 3600_000 ? formatDistanceToNowStrict(at, { addSuffix: true }) : dateTime.format(at);
}

/** The latest sign-ins and security changes on this account, newest first */
export function SignInActivity() {
  const api = useApi();
  const events = useQuery({ queryKey: qk.securityEvents, queryFn: () => api.security.events(RECENT) });
  const items = events.data ?? [];
  return (
    <Section title="Recent sign-in activity" description="Sign-ins and security changes on your account. Anything you don’t recognise? Change your password and sign out everywhere else.">
      {events.isError ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} className="py-8" />
      ) : events.isPending ? (
        <div className="space-y-4 py-1" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No recent activity" description="Sign-ins to your account will show up here." className="py-8" />
      ) : (
        <ul aria-label="Recent security events" className="-mx-5 divide-y divide-border/70 border-t border-border/70 sm:-mx-6">
          {items.map((event) => {
            const { label, kind, newDevice } = describeSecurityEvent(event);
            const Icon = ICONS[kind];
            const where = [event.deviceLabel, event.ipMasked].filter(Boolean).join(' · ');
            return (
              <li key={event.id} className="flex items-start gap-3.5 px-5 py-3 sm:px-6">
                <span className="flex size-10 shrink-0 items-center justify-center">
                  <Icon className={cn('size-5', kind === 'failed' || kind === 'blocked' ? 'text-warning' : 'text-muted-foreground')} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1 py-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium tracking-[-0.01em]">
                    {label}
                    {newDevice ? (
                      <Badge tone="warning" dot>
                        New device
                      </Badge>
                    ) : null}
                  </p>
                  {where ? <p className="break-words text-[13px] leading-[18px] text-muted-foreground">{where}</p> : null}
                </div>
                <time dateTime={event.at} className="shrink-0 py-0.5 text-[13px] text-muted-foreground tnum">
                  {when(event.at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
