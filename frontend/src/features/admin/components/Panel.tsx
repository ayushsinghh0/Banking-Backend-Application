import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui/primitives';

/**
 * A titled tile that is also a named landmark (the same pattern as the customer dashboard): a headline
 * title, an optional link on the right, the content, and an optional footnote.
 */
export function Panel({
  title,
  description,
  action,
  footnote,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  footnote?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id} className={cn('flex flex-col overflow-hidden', className)}>
      <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
        <div className="min-w-0 space-y-0.5">
          <h2 id={id} className="text-headline">
            {title}
          </h2>
          {description ? <p className="text-[13px] leading-[18px] text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
      </div>
      <div className="flex-1 px-5 pb-4 pt-3 sm:px-6 sm:pb-5">{children}</div>
      {footnote ? <p className="px-5 pb-5 text-[12.5px] leading-[18px] text-muted-foreground sm:px-6 sm:pb-6">{footnote}</p> : null}
    </Card>
  );
}

/**
 * Rows that are links: the highlight runs to the tile's edges while the separators stay inset, as in iOS
 * lists. Pair with a stretched link (`after:absolute after:inset-0`) inside the row.
 */
export const linkRowClass = cn(
  'group relative -mx-5 px-5 py-3.5 transition-colors duration-150 hover:bg-accent/70 has-[:focus-visible]:bg-accent/70 sm:-mx-6 sm:px-6',
  'before:absolute before:inset-x-5 before:top-0 before:h-px before:bg-border/70 first:before:hidden sm:before:inset-x-6'
);
