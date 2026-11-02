import type { ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { CheckCircle2, OctagonAlert, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Callout, Skeleton } from '@/components/ui/primitives';
import { Panel } from '@/features/admin/components/Panel';
import { timeAgo } from '@/features/admin/components/format';
import { opsKeys, useOpsApi, type AuditVerification } from './api';

type Outcome = { kind: 'verified'; checked: number } | { kind: 'broken'; checked: number; at: string | null } | { kind: 'unknown' };

const count = new Intl.NumberFormat('en-IN');

/** Only an explicit answer counts: anything else is reported as no result, never as verified */
function outcomeOf(data: AuditVerification | undefined): Outcome {
  const checked = typeof data?.checked === 'number' && Number.isFinite(data.checked) ? data.checked : 0;
  if (data?.ok === true) return { kind: 'verified', checked };
  if (data?.ok === false) return { kind: 'broken', checked, at: data.brokenAt === null || data.brokenAt === undefined ? null : String(data.brokenAt) };
  return { kind: 'unknown' };
}

const records = (n: number) => `${count.format(n)} record${n === 1 ? '' : 's'} checked`;

function ChainRow({ name, retryLabel, query }: { name: string; retryLabel: string; query: UseQueryResult<AuditVerification> }) {
  let status: ReactNode;
  let detail: ReactNode = null;
  if (query.isPending) {
    status = (
      <>
        <Skeleton className="h-[22px] w-20" />
        <span className="sr-only">Checking</span>
      </>
    );
  } else if (query.isError) {
    status = <span className="text-[14px] font-medium text-muted-foreground">Couldn’t check</span>;
    detail = (
      <Button variant="secondary" size="sm" className="mt-2" aria-label={retryLabel} onClick={() => void query.refetch()}>
        <RotateCw aria-hidden="true" /> Try again
      </Button>
    );
  } else {
    const outcome = outcomeOf(query.data);
    if (outcome.kind === 'verified') {
      status = (
        <span className="inline-flex items-center gap-1.5 text-[14px] font-medium">
          <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden="true" />
          Verified
        </span>
      );
      detail = <p className="text-[13px] leading-[18px] text-muted-foreground tnum">{records(outcome.checked)}</p>;
    } else if (outcome.kind === 'broken') {
      status = (
        <Badge tone="danger" className="bg-destructive text-destructive-foreground">
          <OctagonAlert className="size-3" strokeWidth={2.5} aria-hidden="true" />
          Broken
        </Badge>
      );
      detail = (
        <p className="text-[13px] leading-[18px] text-muted-foreground tnum">
          <span className="font-medium text-destructive">{outcome.at ? `First broken link at record ${outcome.at}` : 'A link doesn’t match'}</span>
          {' · '}
          {records(outcome.checked)}
        </p>
      );
    } else {
      status = <span className="text-[14px] font-medium text-muted-foreground">No result</span>;
      detail = <p className="text-[13px] leading-[18px] text-muted-foreground">The service didn’t say whether the chain is intact.</p>;
    }
  }
  return (
    <li className="py-3 first:pt-1 last:pb-1">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] font-medium leading-5 tracking-[-0.01em]">{name}</p>
        {status}
      </div>
      {detail ? <div className="mt-0.5">{detail}</div> : null}
    </li>
  );
}

/** Re-walking a chain reads every audit record: only on request, never on focus or a timer */
const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false } as const;

/** Both chain checks; shared through the query cache by every component that asks */
function useAuditChecks() {
  const ops = useOpsApi();
  const ledger = useQuery({ queryKey: opsKeys.audit('ledger'), queryFn: () => ops.audit.ledger(), ...ONCE });
  const auth = useQuery({ queryKey: opsKeys.audit('auth'), queryFn: () => ops.audit.auth(), ...ONCE });
  const broken = [ledger, auth].some((q) => q.isSuccess && outcomeOf(q.data).kind === 'broken');
  return { ledger, auth, broken };
}

/**
 * The same checks as the card (shared from the cache, no extra requests), as a banner for the top of a page:
 * nothing at all unless a chain is broken. The card itself only marks which chain and where.
 */
export function AuditBreachNotice() {
  const { broken } = useAuditChecks();
  return broken ? (
    <Callout tone="danger" title="An audit log has been altered">
      A record no longer matches its chain (see Audit integrity). Treat this as a security incident and leave the database as it is.
    </Callout>
  ) : null;
}

/**
 * Re-walks the tamper-evident audit chains (ledger, and sign-in and administration) and says whether every
 * record's hash still follows from the one before. A broken link is critical: someone changed history.
 */
export function AuditIntegrityCard({ className }: { className?: string }) {
  const { ledger, auth } = useAuditChecks();
  const fetching = ledger.isFetching || auth.isFetching;
  const checkedAt = Math.max(ledger.dataUpdatedAt, auth.dataUpdatedAt);

  return (
    <Panel
      title="Audit integrity"
      description={checkedAt && !fetching ? `Checked ${timeAgo(new Date(checkedAt).toISOString())}` : 'Each record’s hash must follow from the one before.'}
      action={
        <Button
          variant="secondary"
          size="sm"
          loading={fetching}
          onClick={() => {
            void ledger.refetch();
            void auth.refetch();
          }}
        >
          Check again
        </Button>
      }
      className={className}
    >
      <ul className="divide-y divide-border/70" aria-busy={fetching}>
        <ChainRow name="Ledger" retryLabel="Try again checking the ledger" query={ledger} />
        <ChainRow name="Sign-in and administration" retryLabel="Try again checking sign-in and administration" query={auth} />
      </ul>
    </Panel>
  );
}
