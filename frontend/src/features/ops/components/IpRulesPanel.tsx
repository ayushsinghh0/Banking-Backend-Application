import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck } from 'lucide-react';
import { isApiError } from '@/lib/api/errors';
import { notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data';
import { ConfirmDialog } from '@/components/ui/overlays';
import { Card } from '@/components/ui/primitives';
import { LoadingAnnouncement } from '@/features/staff/components/LoadingAnnouncement';
import { formatDate, formatDateTime } from '@/features/staff/components/format';
import { rowListClass } from '@/features/staff/components/layout';
import { PersonName } from '@/features/admin/components/People';
import { useUserLookup } from '@/features/admin/components/useUserLookup';
import { opsKeys, useOpsApi, type IpRule } from '../api';
import { expiryLabel } from '../format';
import { notifyOpsError } from '../notify';
import { AddIpRuleDialog } from './AddIpRuleDialog';

/** Gateway deny rules: what is blocked, why, until when and who added it; administrators add and remove them */
export function IpRulesPanel({ canWrite }: { canWrite: boolean }) {
  const ops = useOpsApi();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<IpRule | null>(null);
  const query = useQuery({ queryKey: opsKeys.ipRules, queryFn: () => ops.security.ipRules() });
  const rows = query.data;
  const resolve = useUserLookup(rows?.map((r) => r.createdBy) ?? []);
  const now = Date.now();

  const remove = async (rule: IpRule) => {
    try {
      await ops.security.removeIpRule(rule.id);
      notifySuccess('Rule removed', `Requests from ${rule.cidr} are allowed again within a few seconds.`);
    } catch (error) {
      if (!isApiError(error) || error.status !== 404) {
        notifyOpsError(error);
        throw error;
      }
      notifySuccess('Rule already removed', 'Someone else removed it, or it expired.');
    }
    await queryClient.invalidateQueries({ queryKey: opsKeys.ipRules });
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <p className="max-w-xl text-pretty text-[14px] leading-5 text-muted-foreground">
          Requests from these addresses are refused at the gateway before they reach any service.
        </p>
        {canWrite ? (
          <Button className="shrink-0 self-start sm:self-auto" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" /> Add rule
          </Button>
        ) : null}
      </div>
      <LoadingAnnouncement active={query.isFetching} label="Loading IP rules…" />
      <DataTable<IpRule>
        className={rowListClass}
        caption="IP rules"
        rows={rows}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        getRowKey={(r) => r.id}
        empty={{ icon: ShieldCheck, title: 'No IP rules', description: 'Nothing is blocked by hand. Automatic bans are on the next tab.' }}
        columns={[
          {
            key: 'range',
            header: 'Address or range',
            cell: (r) => (
              <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
                <span className="break-all font-mono text-[14px] font-medium">{r.cidr}</span>
                <span className="flex flex-wrap gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground md:hidden">
                  <span className="break-words">{r.reason}</span>
                  <span className="whitespace-nowrap">
                    <span aria-hidden="true">· </span>
                    {expiryLabel(r.expiresAt, now)}
                  </span>
                </span>
              </span>
            ),
          },
          {
            key: 'reason',
            header: 'Reason',
            hideOnMobile: true,
            cell: (r) => <span className="line-clamp-2 max-w-sm break-words text-[14px]">{r.reason}</span>,
          },
          {
            key: 'expires',
            header: 'Expires',
            hideOnMobile: true,
            className: 'whitespace-nowrap',
            cell: (r) => (
              <span className="text-[14px] text-muted-foreground tnum" title={r.expiresAt ? formatDateTime(r.expiresAt) : undefined}>
                {expiryLabel(r.expiresAt, now)}
              </span>
            ),
          },
          {
            key: 'added',
            header: 'Added',
            hideOnMobile: true,
            className: 'md:hidden xl:table-cell',
            cell: (r) => (
              <span className="flex flex-col text-[14px]">
                <PersonName person={resolve(r.createdBy)} />
                <time dateTime={r.createdAt} className="text-[13px] text-muted-foreground tnum">
                  {formatDate(r.createdAt)}
                </time>
              </span>
            ),
          },
          ...(canWrite
            ? [
                {
                  key: 'remove',
                  header: <span className="sr-only">Remove</span>,
                  align: 'right' as const,
                  className: 'w-px whitespace-nowrap max-md:pl-0',
                  cell: (r: IpRule) => (
                    <Button variant="ghost" size="sm" className="text-destructive max-md:h-11" aria-label={`Remove rule for ${r.cidr}`} onClick={() => setRemoving(r)}>
                      Remove
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {adding ? <AddIpRuleDialog onOpenChange={setAdding} /> : null}
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(null)}
          title={`Remove the rule for ${removing.cidr}?`}
          description="Requests from this range are allowed again within a few seconds. You can add the rule again at any time."
          confirmLabel="Remove rule"
          tone="destructive"
          onConfirm={() => remove(removing)}
        />
      ) : null}
    </Card>
  );
}
