import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, ServerCrash } from 'lucide-react';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/api/errors';
import { Button } from './button';
import { EmptyState, Skeleton } from './primitives';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Hidden below the md breakpoint to keep small screens readable */
  hideOnMobile?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  getRowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty: { title: string; description?: ReactNode; icon?: React.ComponentType<{ className?: string }>; action?: ReactNode };
  onRowClick?: (row: T) => void;
  /** Accessible name of the row action, e.g. "Open alert" */
  rowActionLabel?: (row: T) => string;
  caption: string;
  skeletonRows?: number;
  className?: string;
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { title, description, reference } = describeError(error);
  return (
    <div role="alert" className={cn('flex flex-col items-center px-6 py-12 text-center', className)}>
      <ServerCrash className="mb-3 size-9 text-muted-foreground/60" strokeWidth={1.4} aria-hidden="true" />
      <p className="text-headline">{title}</p>
      <p className="mt-1 max-w-sm text-pretty text-[14px] leading-5 text-muted-foreground">{description}</p>
      {reference ? <p className="mt-2 font-mono text-[11.5px] text-muted-foreground">Reference: {reference}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          <RotateCw aria-hidden="true" /> Try again
        </Button>
      ) : null}
    </div>
  );
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  loading,
  error,
  onRetry,
  empty,
  onRowClick,
  rowActionLabel,
  caption,
  skeletonRows = 5,
  className,
}: DataTableProps<T>) {
  if (error && !rows?.length) return <ErrorState error={error} onRetry={onRetry} />;
  if (!loading && rows && rows.length === 0) {
    return <EmptyState icon={empty.icon} title={empty.title} description={empty.description} action={empty.action} />;
  }
  const mobileHidden = (c: Column<T>) => (c.hideOnMobile ? 'hidden md:table-cell' : '');
  return (
    <div className={cn('relative w-full overflow-x-auto', className)}>
      <table className="w-full caption-bottom text-[14px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'h-11 whitespace-nowrap px-4 text-left text-[12.5px] font-medium text-muted-foreground first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6',
                  c.align === 'right' && 'text-right',
                  mobileHidden(c),
                  c.className
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && !rows
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={`s${i}`} className="border-b border-border/70 last:border-0">
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-4 first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6', mobileHidden(c), c.className)}>
                      <Skeleton className="h-4 w-full max-w-[10rem]" />
                    </td>
                  ))}
                </tr>
              ))
            : rows?.map((row) => (
                <tr
                  key={getRowKey(row)}
                  className={cn(
                    'border-b border-border/70 transition-colors duration-150 last:border-0',
                    onRowClick && 'cursor-pointer hover:bg-accent/70 focus-within:bg-accent/70'
                  )}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c, index) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-4 py-3.5 align-middle first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6',
                        c.align === 'right' && 'text-right',
                        mobileHidden(c),
                        c.className
                      )}
                    >
                      {index === 0 && onRowClick ? (
                        <button
                          type="button"
                          className="text-left font-medium tracking-[-0.01em] focus-visible:underline cursor-pointer"
                          aria-label={rowActionLabel?.(row)}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRowClick(row);
                          }}
                        >
                          {c.cell(row)}
                        </button>
                      ) : (
                        c.cell(row)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

/** Offset pagination for APIs that don't return a total: "next" is offered while pages are full */
export function Pagination({
  offset,
  limit,
  count,
  onChange,
  className,
}: {
  offset: number;
  limit: number;
  count: number;
  onChange: (offset: number) => void;
  className?: string;
}) {
  const from = count === 0 ? 0 : offset + 1;
  const to = offset + count;
  return (
    <nav aria-label="Pagination" className={cn('flex items-center justify-between gap-3 border-t px-5 py-3 sm:px-6', className)}>
      <p className="text-[13px] text-muted-foreground tnum" aria-live="polite">
        {count === 0 ? 'No results' : `Showing ${from}–${to}`}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          <ChevronLeft aria-hidden="true" /> Previous
        </Button>
        <Button variant="secondary" size="sm" disabled={count < limit} onClick={() => onChange(offset + limit)}>
          Next <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
