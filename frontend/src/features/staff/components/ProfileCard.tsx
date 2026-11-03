import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';
import type { CustomerProfile } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { ErrorState } from '@/components/ui/data';
import { Avatar, Card, CopyButton, Skeleton } from '@/components/ui/primitives';
import { KycBadge } from './badges';
import { formatCalendarDate, formatDate, formatDateTime, formatListTime, shortId } from './format';

const notProvided = <span className="text-muted-foreground">Not provided</span>;

function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-[15px] leading-[22px]">{children}</dd>
    </div>
  );
}

export type ProfileState =
  | { kind: 'ready'; profile: CustomerProfile }
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; error: unknown; onRetry: () => void };

/**
 * The customer 360's header tile, like a contact card: who they are, whether their identity is verified,
 * and the identity details a KYC decision is made on. It carries the page title in every state.
 */
export function ProfileHeader({ userId, title, state, className }: { userId: string; title: ReactNode; state: ProfileState; className?: string }) {
  const profile = state.kind === 'ready' ? state.profile : null;
  return (
    <Card role="region" aria-label="Profile" className={cn('px-5 py-6 sm:px-8 sm:py-7', className)}>
      <div className="flex items-start gap-4">
        {profile ? <Avatar name={profile.fullName} className="size-12 text-[17px] sm:size-14 sm:text-[19px]" /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="large-title min-w-0 break-words">{title}</h1>
            {profile ? <KycBadge status={profile.kycStatus} /> : null}
          </div>
          <p className="mt-1 flex flex-col text-[14px] leading-5 text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5">
            {profile ? <span>Customer since {formatDate(profile.createdAt)}</span> : null}
            {profile ? (
              <span className="hidden sm:inline" aria-hidden="true">
                ·
              </span>
            ) : null}
            <span className="inline-flex items-center">
              ID <span className="ml-1 tnum">{shortId(userId)}</span>
              <CopyButton value={userId} label="Copy user ID" className="-my-1.5 ml-0.5 max-sm:size-10" />
            </span>
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-border/70 pt-5">
        {state.kind === 'ready' ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
            <Fact label="Phone">
              <span className="tnum">{state.profile.phoneNumber}</span>
            </Fact>
            <Fact label="Date of birth">{state.profile.dateOfBirth ? formatCalendarDate(state.profile.dateOfBirth) : notProvided}</Fact>
            <Fact label="Address" className="max-lg:col-span-2">
              {state.profile.address ? <span className="whitespace-pre-line">{state.profile.address}</span> : notProvided}
            </Fact>
            <Fact label="Profile">
              <span className="tnum">Version {state.profile.version}</span>
              <span className="block text-[13px] leading-[18px] text-muted-foreground">
                Updated{' '}
                <time dateTime={state.profile.updatedAt} title={formatDateTime(state.profile.updatedAt)}>
                  {formatListTime(state.profile.updatedAt)}
                </time>
              </span>
            </Fact>
          </dl>
        ) : state.kind === 'loading' ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
          </div>
        ) : state.kind === 'missing' ? (
          <div className="space-y-0.5">
            <p className="text-[15px] font-medium tracking-[-0.01em]">No profile yet</p>
            <p className="text-pretty text-[14px] leading-5 text-muted-foreground">
              This customer has registered but hasn’t completed their profile, so there are no identity details to review.
            </p>
          </div>
        ) : (
          <ErrorState error={state.error} onRetry={state.onRetry} className="py-6" />
        )}
        <p className="mt-5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Eye className="size-3.5 shrink-0" aria-hidden="true" />
          Your access to this record is logged.
        </p>
      </div>
    </Card>
  );
}
