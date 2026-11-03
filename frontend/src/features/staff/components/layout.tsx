import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Card, CopyButton } from '@/components/ui/primitives';

/** The way back to the list a record was opened from, as on iOS: a blue chevron and the list's name */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="-my-1.5 -ml-1.5 inline-flex h-11 items-center gap-0.5 rounded-lg pr-2 text-[15px] font-medium tracking-[-0.01em] text-primary transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronLeft className="size-5" strokeWidth={2.25} aria-hidden="true" />
      {label}
    </Link>
  );
}

/** A titled tile that is also a named landmark */
export function Panel({
  title,
  description,
  action,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id} className={cn('flex flex-col', className)}>
      <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
        <div className="min-w-0 space-y-0.5">
          <h2 id={id} className="text-headline">
            {title}
          </h2>
          {description ? <p className="text-pretty text-[13px] leading-[18px] text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className={cn('flex-1 px-5 pb-5 pt-3 sm:px-6 sm:pb-6', bodyClassName)}>{children}</div>
    </Card>
  );
}

/**
 * Label/value rows separated by hairlines. "split" puts the value on the right (narrow side tiles, as in
 * Settings); "aligned" lines the values up in a column (wide tiles, long values).
 */
export function Facts({
  items,
  layout = 'split',
  className,
}: {
  items: Array<{ label: string; value: ReactNode; hint?: ReactNode } | null | false>;
  layout?: 'split' | 'aligned';
  className?: string;
}) {
  return (
    <dl className={cn('divide-y divide-border/70', className)}>
      {items.filter(Boolean).map((item) => {
        const { label, value, hint } = item as { label: string; value: ReactNode; hint?: ReactNode };
        return (
          <div
            key={label}
            className={cn(
              'py-3 first:pt-0 last:pb-0',
              layout === 'split'
                ? 'flex items-baseline justify-between gap-4'
                : 'grid grid-cols-1 gap-0.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-baseline sm:gap-6'
            )}
          >
            <dt className="shrink-0 text-[14px] text-muted-foreground">{label}</dt>
            <dd className={cn('min-w-0 break-words text-[15px]', layout === 'split' && 'text-right')}>
              {value}
              {hint ? <span className="mt-0.5 block text-[13px] leading-[18px] text-muted-foreground">{hint}</span> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** The neutral transaction-type glyph used for activity across the app: which way the money moved */
export function DirectionGlyph({ direction, className }: { direction: 'Incoming' | 'Outgoing' | null; className?: string }) {
  const Icon = direction === 'Incoming' ? ArrowDownLeft : direction === 'Outgoing' ? ArrowUpRight : ShieldAlert;
  return (
    <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/80', className)} aria-hidden="true">
      <Icon className="size-[18px]" strokeWidth={1.8} />
    </span>
  );
}

/** A formatted rupee figure ("₹2,50,000.00") with the paise quieter, as on a statement header */
export function RupeeFigure({ text, className }: { text: string; className?: string }) {
  const dot = text.lastIndexOf('.');
  return (
    <span className={cn('tnum whitespace-nowrap', className)}>
      {dot === -1 ? (
        text
      ) : (
        <>
          {text.slice(0, dot)}
          <span className="text-muted-foreground/70">{text.slice(dot)}</span>
        </>
      )}
    </span>
  );
}

/**
 * An identifier with no human name (a transaction or operation id): quiet monospace, copyable, and no taller
 * than the text around it.
 */
export function CopyableId({ value, label = 'Copy identifier' }: { value: string; label?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-0.5">
      <span className="min-w-0 break-all font-mono text-[13px] text-muted-foreground" title={value}>
        {value}
      </span>
      <CopyButton value={value} label={label} className="-my-2 size-7 shrink-0 max-sm:size-10" />
    </span>
  );
}

/** The trailing chevron of a row that opens something */
export function RowChevron({ className }: { className?: string }) {
  return <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground/50', className)} aria-hidden="true" />;
}

/** Column definition for the trailing chevron of a navigating table row */
export const chevronColumn = {
  key: 'open',
  header: <span className="sr-only">Open</span>,
  className: 'w-px pl-0 sm:pl-0',
  cell: () => <RowChevron />,
};

/**
 * Lists inside a tile: the table's column headers make sense on wide screens, on phones the rows read as a
 * list (title, meta line, trailing value) so the headers are only kept for assistive tech.
 */
export const rowListClass = 'max-md:[&_thead]:sr-only';
