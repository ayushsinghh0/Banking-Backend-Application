import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { isApiError } from '@/lib/api/errors';
import { notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data';
import { ConfirmDialog } from '@/components/ui/overlays';
import { Card } from '@/components/ui/primitives';
import { LoadingAnnouncement } from '@/features/staff/components/LoadingAnnouncement';
import { formatDateTime, formatListTime } from '@/features/staff/components/format';
import { rowListClass } from '@/features/staff/components/layout';
import { opsKeys, useOpsApi, type IpBan } from '../api';
import { expiryLabel } from '../format';
import { notifyOpsError } from '../notify';

/** Refresh while bans are counting down, so a lifted one drops off on its own */
const REFRESH_MS = 60_000;

/**
 * Addresses banned automatically at the edge (credential stuffing). Addresses are shown exactly as the API
 * masks them; the ban key used to lift one is never displayed.
 */
export function BansPanel({ canWrite }: { canWrite: boolean }) {
  const ops = useOpsApi();
  const queryClient = useQueryClient();
  const [lifting, setLifting] = useState<IpBan | null>(null);
  const query = useQuery({ queryKey: opsKeys.bans, queryFn: () => ops.security.bans(), refetchInterval: REFRESH_MS });
  const now = Date.now();

  const lift = async (ban: IpBan) => {
    try {
      await ops.security.liftBan(ban.ipKey);
      notifySuccess('Ban lifted', `Sign-ins from ${ban.ipMasked} are allowed again.`);
    } catch (error) {
      if (!isApiError(error) || error.status !== 404) {
        notifyOpsError(error);
        throw error;
      }
      notifySuccess('Ban already lifted', 'It expired or someone else lifted it.');
    }
    await queryClient.invalidateQueries({ queryKey: opsKeys.bans });
  };

  return (
    <Card className="overflow-hidden">
      <p className="border-b border-border/70 p-4 text-pretty text-[14px] leading-5 text-muted-foreground sm:p-5">
        An address that tries passwords on many accounts is banned for 30 minutes automatically.
      </p>
      <LoadingAnnouncement active={query.isFetching} label="Loading bans…" />
      <DataTable<IpBan>
        className={rowListClass}
        caption="Automatic bans"
        rows={query.data}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        getRowKey={(b) => b.ipKey}
        empty={{ icon: ShieldCheck, title: 'No automatic bans', description: 'No address is banned right now.' }}
        columns={[
          {
            key: 'address',
            header: 'Address',
            cell: (b) => (
              <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
                <span className="break-all font-mono text-[14px] font-medium">{b.ipMasked}</span>
                <span className="flex flex-wrap gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground md:hidden">
                  {b.reason ? <span className="break-words">{b.reason}</span> : null}
                  <span className="whitespace-nowrap">
                    {b.reason ? <span aria-hidden="true">· </span> : null}
                    {b.expiresAt ? `Lifts ${expiryLabel(b.expiresAt, now)}` : 'Until lifted'}
                  </span>
                </span>
              </span>
            ),
          },
          {
            key: 'reason',
            header: 'Reason',
            hideOnMobile: true,
            cell: (b) => <span className="line-clamp-2 max-w-sm break-words text-[14px]">{b.reason ?? '—'}</span>,
          },
          {
            key: 'since',
            header: 'Banned',
            hideOnMobile: true,
            className: 'whitespace-nowrap',
            cell: (b) =>
              b.bannedAt ? (
                <time dateTime={b.bannedAt} title={formatDateTime(b.bannedAt)} className="text-[14px] text-muted-foreground tnum">
                  {formatListTime(b.bannedAt, now)}
                </time>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
          {
            key: 'lifts',
            header: 'Lifts',
            hideOnMobile: true,
            className: 'whitespace-nowrap',
            cell: (b) => <span className="text-[14px] text-muted-foreground tnum">{b.expiresAt ? expiryLabel(b.expiresAt, now) : 'Until lifted'}</span>,
          },
          ...(canWrite
            ? [
                {
                  key: 'lift',
                  header: <span className="sr-only">Lift ban</span>,
                  align: 'right' as const,
                  className: 'w-px whitespace-nowrap max-md:pl-0',
                  cell: (b: IpBan) => (
                    <Button variant="ghost" size="sm" className="text-primary max-md:h-11" aria-label={`Lift ban on ${b.ipMasked}`} onClick={() => setLifting(b)}>
                      Lift ban
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {lifting ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setLifting(null)}
          title={`Lift the ban on ${lifting.ipMasked}?`}
          description="Sign-ins from this address are allowed again straight away. If the attempts continue it is banned again automatically."
          confirmLabel="Lift ban"
          onConfirm={() => lift(lifting)}
        />
      ) : null}
    </Card>
  );
}
