/* eslint-disable jsx-a11y/no-redundant-roles, jsx-a11y/no-interactive-element-to-noninteractive-role --
 * The explicit table roles are deliberate: phones restyle rows and cells with display: flex, and some
 * browsers (Safari) drop a table's semantics once its display changes unless the roles are stated.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ErrorState } from '@/components/ui/data';
import { EmptyState, Skeleton } from '@/components/ui/primitives';

/**
 * Where a cell goes on phones, where each row becomes a list item:
 *
 *   title ······················· end end
 *   detail · detail · detail
 *   block (full width)
 *   [ action (full width) ]
 */
export type PhonePlacement = 'title' | 'end' | 'detail' | 'block' | 'action' | 'hidden';

export interface RowColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Applied to the column's header and cells (e.g. `hidden xl:table-cell`) */
  className?: string;
  phone: PhonePlacement;
}

const PHONE: Record<PhonePlacement, string> = {
  title: 'max-md:order-1 max-md:min-w-0 max-md:flex-1 max-md:text-[15px]',
  end: 'max-md:order-2 max-md:shrink-0 max-md:pl-2 max-md:text-right max-md:text-[15px]',
  detail: 'max-md:order-4 max-md:text-[13px] max-md:leading-[18px] max-md:text-muted-foreground',
  block: 'max-md:order-5 max-md:mt-2 max-md:basis-full max-md:text-[13px] max-md:leading-[18px] max-md:empty:hidden',
  action: 'max-md:order-6 max-md:mt-3 max-md:basis-full max-md:empty:hidden',
  hidden: 'max-md:hidden',
};

// The second and later details on a phone row are joined with a middle dot
const JOINED = "max-md:ml-1.5 max-md:before:mr-1.5 max-md:before:content-['·']";

/**
 * A table on tablets and desktops; on phones every row stacks into a list item, so nothing scrolls sideways
 * and nothing is rendered twice. Explicit ARIA roles keep the table semantics when phones restyle the
 * rows (some browsers drop them once a table's display changes).
 */
export function RowTable<T>({
  columns,
  rows,
  getRowKey,
  loading,
  error,
  onRetry,
  empty,
  caption,
  skeletonRows = 4,
  className,
}: {
  columns: RowColumn<T>[];
  rows: T[] | undefined;
  getRowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty: { title: string; description?: ReactNode; icon?: React.ComponentType<{ className?: string }>; action?: ReactNode };
  caption: string;
  skeletonRows?: number;
  className?: string;
}) {
  if (error && !rows?.length) return <ErrorState error={error} onRetry={onRetry} />;
  if (!loading && rows && rows.length === 0) {
    return <EmptyState icon={empty.icon} title={empty.title} description={empty.description} action={empty.action} />;
  }
  let details = 0;
  const joined = columns.map((c) => c.phone === 'detail' && details++ > 0);
  const cellClass = (c: RowColumn<T>, index: number) =>
    cn(
      'align-middle md:px-4 md:py-3.5 md:first:pl-6 md:last:pr-6',
      c.align === 'right' && 'md:text-right',
      PHONE[c.phone],
      joined[index] && JOINED,
      c.className
    );
  return (
    <div className={cn('relative w-full md:overflow-x-auto', className)}>
      <table role="table" className="w-full text-[14px] max-md:block">
        <caption className="sr-only">{caption}</caption>
        <thead role="rowgroup" className="max-md:hidden">
          <tr role="row" className="border-b border-border/70">
            {columns.map((c) => (
              <th
                key={c.key}
                role="columnheader"
                scope="col"
                className={cn(
                  'h-11 whitespace-nowrap px-4 text-left text-[12.5px] font-medium text-muted-foreground first:pl-6 last:pr-6',
                  c.align === 'right' && 'text-right',
                  c.className
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className="max-md:block">
          {loading && !rows
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={`s${i}`} role="row" className="border-b border-border/70 last:border-0 max-md:flex max-md:flex-col max-md:gap-2 max-md:px-5 max-md:py-4">
                  {columns.map((c, index) =>
                    index < 2 ? (
                      <td key={c.key} role="cell" className="md:px-4 md:py-4 md:first:pl-6 md:last:pr-6">
                        <Skeleton className={cn('h-4', index === 0 ? 'w-44' : 'w-24')} />
                      </td>
                    ) : (
                      <td key={c.key} role="cell" className={cn('max-md:hidden md:px-4 md:py-4 md:last:pr-6', c.className)}>
                        <Skeleton className="h-4 w-full max-w-[8rem]" />
                      </td>
                    )
                  )}
                </tr>
              ))
            : rows?.map((row) => (
                <tr
                  key={getRowKey(row)}
                  role="row"
                  className={cn(
                    'border-b border-border/70 last:border-0',
                    // Phones: a wrapping flex row; the empty ::after forces the line break after title and end
                    "max-md:flex max-md:flex-wrap max-md:items-baseline max-md:px-5 max-md:py-3.5 max-md:after:order-3 max-md:after:basis-full max-md:after:content-['']"
                  )}
                >
                  {columns.map((c, index) => (
                    <td key={c.key} role="cell" className={cellClass(c, index)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
