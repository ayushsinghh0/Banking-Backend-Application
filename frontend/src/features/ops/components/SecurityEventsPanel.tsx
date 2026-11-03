import { useCallback, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { History, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Card } from '@/components/ui/primitives';
import { LoadingAnnouncement } from '@/features/staff/components/LoadingAnnouncement';
import { detailEntries, formatDateTime, formatListTime } from '@/features/staff/components/format';
import { useListParams } from '@/features/staff/components/hooks';
import { rowListClass } from '@/features/staff/components/layout';
import { PersonName } from '@/features/admin/components/People';
import { useUserLookup } from '@/features/admin/components/useUserLookup';
import { opsKeys, useOpsApi, type SecurityEvent, type SecurityEventFilters } from '../api';
import { SECURITY_EVENT_TYPES, eventLabel } from '../format';
import { CursorPagination, useCursorPages } from './CursorPagination';
import { useIdFilter } from './useIdFilter';

const LIMIT = 25;
const quiet = 'border-transparent bg-muted hover:border-transparent focus-visible:bg-background';

/** The user ID box (remount with a new key to clear what was typed) */
function UserIdField({ applied, onApply }: { applied: string; onApply: (userId: string | undefined) => void }) {
  const { text, setText, invalid } = useIdFilter(applied, onApply);
  return (
    <Field label="User ID" className="min-w-0" error={invalid ? 'Enter the full user ID' : undefined}>
      {(p) => (
        <Input
          {...p}
          className={quiet}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a user ID"
          autoComplete="off"
          spellCheck={false}
          maxLength={36}
        />
      )}
    </Field>
  );
}

/** "Reason: Wrong password · Attempts: 3" from an event's details */
const detailLine = (details: SecurityEvent['details']) =>
  detailEntries(details ?? null)
    .slice(0, 3)
    .map((d) => `${d.label}: ${d.value}`)
    .join(' · ');

/** Sign-in activity across every user, newest first, filtered by type and user */
export function SecurityEventsPanel() {
  const ops = useOpsApi();
  const { params, update } = useListParams();
  const [clears, setClears] = useState(0);
  const type = SECURITY_EVENT_TYPES.some((t) => t.value === params.get('type')) ? (params.get('type') as string) : undefined;
  const userId = params.get('userId') ?? undefined;
  const filters: SecurityEventFilters = useMemo(() => ({ type, userId }), [type, userId]);
  const filtered = Boolean(type || userId);
  const pages = useCursorPages(JSON.stringify(filters));

  const query = useQuery({
    queryKey: opsKeys.events(filters, pages.cursor),
    queryFn: () => ops.security.events({ ...filters, limit: LIMIT, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  const rows = query.data?.items;
  const resolve = useUserLookup(rows?.map((e) => e.userId) ?? []);
  const now = Date.now();

  const applyUser = useCallback((next: string | undefined) => update({ userId: next }), [update]);
  const clear = () => {
    update({ type: undefined, userId: undefined });
    setClears((n) => n + 1);
  };

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-1 gap-3 border-b border-border/70 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <Field label="Event type" className="min-w-0">
          {(p) => (
            <NativeSelect {...p} className={quiet} value={type ?? ''} onChange={(e) => update({ type: e.target.value || undefined })}>
              <option value="">All events</option>
              {SECURITY_EVENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <UserIdField key={clears} applied={userId ?? ''} onApply={applyUser} />
      </div>
      <LoadingAnnouncement active={query.isFetching} label="Loading security events…" />
      <div aria-busy={query.isFetching} className={cn('transition-opacity', query.isPlaceholderData && 'opacity-60')}>
        <DataTable<SecurityEvent>
          className={rowListClass}
          caption="Security events"
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          getRowKey={(e) => e.id}
          empty={
            filtered
              ? {
                  icon: Search,
                  title: 'No events match these filters',
                  description: 'Events are kept for 180 days.',
                  action: (
                    <Button variant="outline" size="sm" onClick={clear}>
                      Clear filters
                    </Button>
                  ),
                }
              : { icon: History, title: 'No security events', description: 'Sign-ins, failed attempts and new devices appear here.' }
          }
          columns={[
            {
              key: 'event',
              header: 'Event',
              cell: (e) => {
                const details = detailLine(e.details);
                return (
                  <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
                    <span className="text-[15px] font-medium leading-5 tracking-[-0.01em]">{eventLabel(e.type)}</span>
                    <span className="flex flex-wrap gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground md:hidden">
                      {[e.deviceLabel, e.ipMasked].filter(Boolean).map((part, i) => (
                        <span key={i} className="whitespace-nowrap">
                          {i ? <span aria-hidden="true">· </span> : null}
                          {part}
                        </span>
                      ))}
                      <span className="whitespace-nowrap">
                        {e.deviceLabel || e.ipMasked ? <span aria-hidden="true">· </span> : null}
                        <time dateTime={e.at}>{formatListTime(e.at, now)}</time>
                      </span>
                    </span>
                    {e.userId ? (
                      <span className="min-w-0 text-[13px] leading-[18px] text-muted-foreground md:hidden">
                        <PersonName person={resolve(e.userId)} />
                      </span>
                    ) : null}
                    {details ? <span className="line-clamp-2 break-words text-[13px] leading-[18px] text-muted-foreground">{details}</span> : null}
                  </span>
                );
              },
            },
            {
              key: 'user',
              header: 'User',
              hideOnMobile: true,
              cell: (e) => <span className="text-[14px]">{e.userId ? <PersonName person={resolve(e.userId)} /> : '—'}</span>,
            },
            { key: 'device', header: 'Device', hideOnMobile: true, cell: (e) => <span className="text-[14px]">{e.deviceLabel ?? '—'}</span> },
            {
              key: 'address',
              header: 'Address',
              hideOnMobile: true,
              cell: (e) => <span className="whitespace-nowrap font-mono text-[13px] text-muted-foreground">{e.ipMasked ?? '—'}</span>,
            },
            {
              key: 'at',
              header: 'When',
              hideOnMobile: true,
              className: 'whitespace-nowrap',
              cell: (e) => (
                <time dateTime={e.at} title={formatDateTime(e.at)} className="text-[14px] text-muted-foreground tnum">
                  {formatListTime(e.at, now)}
                </time>
              ),
            },
          ]}
        />
      </div>
      {rows && (rows.length > 0 || pages.page > 1) ? (
        <CursorPagination
          page={pages.page}
          limit={LIMIT}
          count={rows.length}
          hasNext={Boolean(query.data?.nextCursor) && !query.isPlaceholderData}
          onNext={() => query.data?.nextCursor && pages.next(query.data.nextCursor)}
          onPrevious={pages.previous}
        />
      ) : null}
    </Card>
  );
}
