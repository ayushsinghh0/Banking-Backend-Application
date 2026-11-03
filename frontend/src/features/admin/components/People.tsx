import type { AdminRequest } from '@/lib/api/types';
import type { Role } from '@/lib/auth/session';
import { Badge, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { formatDateTime, relativeTime, timeAgo } from './format';
import { requestTargetId } from './requests';
import { roleLabel } from './roles';
import type { PersonResolution, ResolvePerson } from './useUserLookup';

/** A role is a category, not a status: grey, whatever the role (blue is for links and selection) */
export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return <Badge className={className}>{roleLabel(role)}</Badge>;
}

/** "2 hours ago" / "in 22 hours", with the exact time on hover and in the markup. `past` marks an event that has happened. */
export function RelativeTime({ iso, now, past, className }: { iso: string; now?: number; past?: boolean; className?: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={cn('tnum', className)}>
      {past ? timeAgo(iso, now) : relativeTime(iso, now)}
    </time>
  );
}

/** A user id shown as a person: their email, "You", or a short id when they can't be found */
export function PersonName({ person, me = 'You' }: { person: PersonResolution | null; me?: string }) {
  if (!person) return <span className="text-muted-foreground">—</span>;
  switch (person.kind) {
    case 'me':
      return <span className="font-medium">{me}</span>;
    case 'loading':
      return (
        <>
          <Skeleton className="inline-block h-3.5 w-36 align-middle" />
          <span className="sr-only">Loading</span>
        </>
      );
    case 'user':
      return <span className="[overflow-wrap:anywhere]">{person.user.email}</span>;
    case 'unknown':
      return (
        <span className="font-mono text-[12.5px] text-muted-foreground" title={person.id}>
          User {person.id.slice(0, 8)}…
        </span>
      );
  }
}

/**
 * Who a request is about: the new colleague's email and role, or the existing user it changes. The role is
 * plain text after the address (`withRole={false}` leaves it out where space is short).
 */
export function RequestSubject({ request, resolve, withRole = true }: { request: AdminRequest; resolve: ResolvePerson; withRole?: boolean }) {
  if (request.type === 'CREATE_STAFF') {
    return (
      <>
        <span className="min-w-0 [overflow-wrap:anywhere]">{request.payload.email}</span>
        {withRole && request.payload.role ? <RoleText role={request.payload.role} /> : null}
      </>
    );
  }
  const person = resolve(requestTargetId(request));
  return (
    <>
      <span className="min-w-0">
        <PersonName person={person} me="Your account" />
      </span>
      {withRole && person?.kind === 'user' ? <RoleText role={person.user.role} /> : null}
    </>
  );
}

function RoleText({ role }: { role: Role }) {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <span className="text-muted-foreground">{roleLabel(role)}</span>
    </>
  );
}
