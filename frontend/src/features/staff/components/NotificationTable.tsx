import { Fragment, useId, useState } from 'react';
import { ChevronDown, Inbox } from 'lucide-react';
import type { NotificationLog } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { ErrorState } from '@/components/ui/data';
import { EmptyState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { formatDateTime, formatListTime } from './format';

const cellBase = 'px-4 py-3.5 align-middle first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6';
const headBase = 'h-11 whitespace-nowrap px-4 text-left text-[12.5px] font-medium text-muted-foreground first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6';
const desktopOnly = 'hidden md:table-cell';

function Details({ log, id, label }: { log: NotificationLog; id: string; label: string }) {
  return (
    <section id={id} aria-label={label} className="space-y-5 px-5 pb-6 pt-1 sm:px-6">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[14px] sm:grid-cols-4">
        <div>
          <dt className="text-[13px] text-muted-foreground">Logged</dt>
          <dd className="tnum">
            <time dateTime={log.createdAt}>{formatDateTime(log.createdAt)}</time>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[13px] text-muted-foreground">Recipient</dt>
          <dd className="break-all">{log.recipient}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Channel</dt>
          <dd>{log.channel === 'EMAIL' ? 'Email' : log.channel}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Retries</dt>
          <dd className="tnum">{log.retryCount}</dd>
        </div>
      </dl>
      <div className="space-y-2">
        <h3 className="text-[13px] font-semibold text-muted-foreground">Message</h3>
        {/* Rendered as text: a message body is never interpreted as markup */}
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/70 px-4 py-3.5 font-sans text-[14px] leading-relaxed text-foreground/90">
          {log.body}
        </pre>
      </div>
      {log.lastError ? (
        <div className="space-y-2">
          <h3 className="text-[13px] font-semibold text-destructive">Last error</h3>
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-xl bg-destructive-soft px-4 py-3.5 font-mono text-[12.5px] leading-relaxed">
            {log.lastError}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

/** Delivered mail is the norm, so it reads as plain text; anything else stands out as a badge */
function DeliveryStatus({ status }: { status: string }) {
  if (status === 'SENT') return <span className="text-[14px] text-muted-foreground">Sent</span>;
  return <StatusBadge status={status} />;
}

/**
 * The delivery log with expandable rows: the subject is the title, the recipient sits under it on phones,
 * and the message body and last error open below the row they belong to.
 */
export function NotificationTable({
  rows,
  loading,
  error,
  onRetry,
  empty,
}: {
  rows: NotificationLog[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  empty: { title: string; description?: string };
}) {
  const baseId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (error && !rows?.length) return <ErrorState error={error} onRetry={onRetry} />;
  if (!loading && rows && rows.length === 0) return <EmptyState icon={Inbox} title={empty.title} description={empty.description} />;

  const now = Date.now();
  const columnCount = 6;
  return (
    <div className="relative w-full overflow-x-auto">
      <table className="w-full caption-bottom text-[14px]">
        <caption className="sr-only">Notifications, newest first</caption>
        <thead className="max-md:sr-only">
          <tr className="border-b">
            <th scope="col" className={headBase}>
              Subject
            </th>
            <th scope="col" className={cn(headBase, desktopOnly)}>
              Recipient
            </th>
            <th scope="col" className={cn(headBase, desktopOnly)}>
              Sent
            </th>
            <th scope="col" className={cn(headBase, 'max-md:text-right')}>
              Status
            </th>
            <th scope="col" className={cn(headBase, desktopOnly, 'text-right')}>
              Retries
            </th>
            <th scope="col" className={cn(headBase, 'w-px pl-0 sm:pl-0')}>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && !rows
            ? Array.from({ length: 5 }, (_, i) => (
                <tr key={`s${i}`} className="border-b border-border/70 last:border-0">
                  {Array.from({ length: columnCount }, (__, c) => (
                    <td key={c} className={cn(cellBase, c === 1 || c === 2 || c === 4 ? desktopOnly : '')}>
                      {c === columnCount - 1 ? null : <Skeleton className="h-4 w-full max-w-[10rem]" />}
                    </td>
                  ))}
                </tr>
              ))
            : rows?.map((log) => {
                const expanded = open.has(log.id);
                const detailsId = `${baseId}-${log.id}`;
                return (
                  <Fragment key={log.id}>
                    <tr
                      className={cn(
                        'cursor-pointer border-b border-border/70 transition-colors duration-150 last:border-0 hover:bg-accent/70',
                        expanded && 'border-b-0 bg-accent/50 hover:bg-accent/50'
                      )}
                      onClick={() => toggle(log.id)}
                    >
                      <td className={cn(cellBase, 'max-w-[26rem]')}>
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={expanded ? detailsId : undefined}
                          aria-label={`Show details: ${log.subject}`}
                          className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md py-0.5 text-left focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(log.id);
                          }}
                        >
                          <span className="line-clamp-2 break-words text-[15px] font-medium leading-5 tracking-[-0.01em]">{log.subject}</span>
                          <span className="block max-w-full truncate text-[13px] leading-[18px] text-muted-foreground md:hidden">{log.recipient}</span>
                        </button>
                      </td>
                      <td className={cn(cellBase, desktopOnly, 'max-w-[16rem] truncate text-muted-foreground')} title={log.recipient}>
                        {log.recipient}
                      </td>
                      <td className={cn(cellBase, desktopOnly, 'whitespace-nowrap text-muted-foreground tnum')}>
                        <time dateTime={log.createdAt} title={formatDateTime(log.createdAt)}>
                          {formatListTime(log.createdAt, now)}
                        </time>
                      </td>
                      <td className={cn(cellBase, 'max-md:text-right')}>
                        <span className="flex flex-col items-end gap-1 md:items-start">
                          {/* Phones: the time sits above the status, as in Mail */}
                          <time dateTime={log.createdAt} className="whitespace-nowrap text-[13px] text-muted-foreground tnum md:hidden">
                            {formatListTime(log.createdAt, now)}
                          </time>
                          <DeliveryStatus status={log.status} />
                        </span>
                      </td>
                      <td className={cn(cellBase, desktopOnly, 'text-right tnum', log.retryCount > 0 ? 'font-medium text-warning' : 'text-muted-foreground')}>
                        {log.retryCount}
                      </td>
                      <td className={cn(cellBase, 'w-px pl-0 sm:pl-0')}>
                        <ChevronDown
                          className={cn('size-4 text-muted-foreground/60 transition-transform duration-200', expanded && 'rotate-180')}
                          aria-hidden="true"
                        />
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="border-b border-border/70 bg-accent/50 last:border-0">
                        <td colSpan={columnCount} className="p-0">
                          <Details log={log} id={detailsId} label={`Details: ${log.subject}`} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}
