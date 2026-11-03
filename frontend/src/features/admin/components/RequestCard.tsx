import { useId, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import type { AdminRequest } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/primitives';
import { formatDateTime, relativeTime } from './format';
import { PersonName, RelativeTime, RequestSubject } from './People';
import { isExpired, requestTargetId, requestTitle, subjectText } from './requests';
import type { ResolvePerson } from './useUserLookup';

export interface RequestPermissions {
  mine: boolean;
  aboutMe: boolean;
  expired: boolean;
  canApprove: boolean;
  canReject: boolean;
  /** Why a decision button is disabled (or what the person may still do) */
  note: string | null;
}

/**
 * Mirrors the four-eyes rules enforced by the auth service, so nobody is offered a button that can only fail:
 * the requester may withdraw (reject) but never approve; the person a request is about may do neither.
 */
export function requestPermissions(request: AdminRequest, meId: string, now: number = Date.now()): RequestPermissions {
  const mine = request.requestedBy === meId;
  const aboutMe = requestTargetId(request) === meId;
  const expired = isExpired(request, now);
  const canApprove = request.status === 'PENDING' && !mine && !aboutMe && !expired;
  const canReject = request.status === 'PENDING' && !aboutMe;
  let note: string | null = null;
  if (aboutMe) note = 'This request is about your account, so another administrator must decide it.';
  else if (expired) {
    note = `This request expired ${relativeTime(request.expiresAt, now)} and can no longer be approved. ${
      mine ? 'Withdraw' : 'Reject'
    } it to clear it from the queue.`;
  } else if (mine) note = 'You made this request, so a different administrator must approve it. You can withdraw it.';
  return { mine, aboutMe, expired, canApprove, canReject, note };
}

/** One label/value line of the card's facts */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">{children}</dd>
    </>
  );
}

const Dot = () => (
  <span aria-hidden="true" className="text-muted-foreground">
    ·
  </span>
);

export function RequestCard({
  request,
  resolve,
  meId,
  now,
  onApprove,
  onReject,
}: {
  request: AdminRequest;
  resolve: ResolvePerson;
  meId: string;
  now: number;
  onApprove: (request: AdminRequest) => void;
  onReject: (request: AdminRequest) => void;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const subjectId = `${id}-subject`;
  const noteId = `${id}-note`;
  const pending = request.status === 'PENDING';
  const rules = requestPermissions(request, meId, now);
  const title = requestTitle(request);
  // Many cards share one page: each button names the request it acts on
  const context = `${title.toLowerCase()} for ${subjectText(request, resolve)}`;
  const rejectLabel = rules.mine ? 'Withdraw' : 'Reject';

  return (
    <article aria-labelledby={`${titleId} ${subjectId}`} className="flex h-full flex-col rounded-2xl bg-card p-5 shadow-card sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 id={titleId} className="text-headline">
            {title}
          </h3>
          <p id={subjectId} className="flex flex-wrap items-baseline gap-x-1.5 text-[15px] leading-[22px]">
            <RequestSubject request={request} resolve={resolve} />
          </p>
        </div>
        {/* In the pending queue every card is pending: only an expired one needs saying */}
        {rules.expired ? (
          <Badge tone="danger" dot className="mt-0.5 shrink-0">
            Expired
          </Badge>
        ) : pending ? null : (
          <StatusBadge status={request.status} className="mt-0.5 shrink-0" />
        )}
      </div>

      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[14px] leading-5">
        <Fact label="Requested by">
          <PersonName person={resolve(request.requestedBy)} />
          <Dot />
          <RelativeTime iso={request.createdAt} now={now} past className="text-muted-foreground" />
        </Fact>
        {pending ? (
          rules.expired ? null : (
            <Fact label="Expires">
              <RelativeTime iso={request.expiresAt} now={now} />
            </Fact>
          )
        ) : (
          <Fact label="Decided by">
            {request.decidedBy ? (
              <>
                <PersonName person={resolve(request.decidedBy)} />
                {request.decidedAt ? (
                  <>
                    <Dot />
                    <time dateTime={request.decidedAt} className="text-muted-foreground tnum">
                      {formatDateTime(request.decidedAt)}
                    </time>
                  </>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">Expired without a decision</span>
            )}
          </Fact>
        )}
      </dl>

      {pending ? (
        <div className="mt-auto pt-5">
          <div className="flex flex-col gap-4 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
            {rules.note ? (
              <p id={noteId} className="flex items-start gap-2 text-[13px] leading-[18px] text-muted-foreground">
                <Info className="mt-px size-4 shrink-0" aria-hidden="true" />
                <span>{rules.note}</span>
              </p>
            ) : (
              <span className="hidden sm:block" />
            )}
            <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
              <Button
                variant="secondary"
                className="max-sm:h-11"
                disabled={!rules.canReject}
                aria-label={`${rejectLabel} ${context}`}
                aria-describedby={rules.note ? noteId : undefined}
                onClick={() => onReject(request)}
              >
                {rejectLabel}
              </Button>
              <Button
                className="max-sm:h-11"
                disabled={!rules.canApprove}
                aria-label={`Approve ${context}`}
                aria-describedby={rules.note ? noteId : undefined}
                onClick={() => onApprove(request)}
              >
                Approve
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
