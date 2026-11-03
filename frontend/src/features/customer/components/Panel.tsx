import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui/primitives';

/**
 * A titled tile that is also a named landmark. `footer` sits flush along the bottom edge (pagination,
 * actions); `flush` drops the content padding for rows that run edge to edge.
 */
export function Panel({
  title,
  description,
  action,
  footer,
  flush,
  className,
  contentClassName,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
  contentClassName?: string;
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
          {description ? <p className="text-[13px] leading-[18px] text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={cn('flex-1', flush ? 'pt-3' : 'px-5 pb-4 pt-3 sm:px-6 sm:pb-5', contentClassName)}>{children}</div>
      {footer}
    </Card>
  );
}
