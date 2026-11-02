import type { ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Card, Skeleton } from '@/components/ui/primitives';

export interface Figure {
  id: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** The hint needs someone's attention: it turns amber */
  attention?: boolean;
}

/*
 * Hairlines between figures, inset from the tile's edges: a 2×2 grid on phones whose lines cross in the
 * middle, four in a row from lg with short vertical rules between them (as on the admin overview).
 */
const V = 'before:absolute before:left-0 before:w-px before:bg-border/80';
const H = 'after:absolute after:top-0 after:h-px after:bg-border/80 lg:after:hidden';
const DIVIDERS = [
  '',
  `${V} before:top-5 before:bottom-0 lg:before:bottom-5`,
  `${H} after:left-5 after:right-0 sm:after:left-6 lg:before:absolute lg:before:inset-y-5 lg:before:left-0 lg:before:w-px lg:before:bg-border/80`,
  `${V} before:top-0 before:bottom-5 lg:before:top-5 ${H} after:left-0 after:right-5 sm:after:right-6`,
];

/**
 * Up to four figures in one quiet tile: label above in muted text, the value large, a hint below. Not links:
 * these are read at a glance. One error state for the whole tile, since the figures come from one request.
 */
export function KeyFigures({
  figures,
  loading,
  error,
  onRetry,
  retryLabel,
  className,
}: {
  figures: Figure[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  /** Accessible name of the retry button, e.g. "Try again loading today’s figures" */
  retryLabel?: string;
  className?: string;
}) {
  if (error) {
    return (
      <Card className={cn('flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6', className)}>
        <p className="text-[14px] text-muted-foreground">
          <span className="font-medium text-foreground">These figures couldn’t be loaded.</span> The list below is unaffected.
        </p>
        {onRetry ? (
          <Button variant="secondary" size="sm" className="self-start sm:self-auto" aria-label={retryLabel} onClick={onRetry}>
            <RotateCw aria-hidden="true" /> Try again
          </Button>
        ) : null}
      </Card>
    );
  }
  return (
    <Card className={cn('overflow-hidden', className)}>
      <dl className="grid grid-cols-2 lg:grid-cols-4">
        {figures.map((figure, index) => (
          <div key={figure.id} className={cn('relative flex flex-col px-5 py-5 sm:px-6', DIVIDERS[index % 4])}>
            {/* Two lines on phones, so values in the same row line up whatever their label's length */}
            <dt className="min-h-9 text-[13px] font-medium leading-[18px] text-muted-foreground lg:min-h-0">{figure.label}</dt>
            <dd className="mt-1.5">
              {loading ? (
                <>
                  <Skeleton className="h-7 w-20" />
                  <Skeleton className="mt-2.5 h-3.5 w-28" />
                </>
              ) : (
                <>
                  <span className="block text-[24px] font-semibold leading-8 tracking-[-0.028em] tnum sm:text-[28px]">{figure.value}</span>
                  {figure.hint ? (
                    <span className={cn('mt-1 block text-[13px] leading-[18px]', figure.attention ? 'font-medium text-warning' : 'text-muted-foreground')}>
                      {figure.hint}
                    </span>
                  ) : null}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {loading ? <span className="sr-only">Loading</span> : null}
    </Card>
  );
}
