import { Link } from 'react-router';
import { ChevronRight, RotateCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Card, Skeleton } from '@/components/ui/primitives';

export type KpiState =
  | { status: 'loading' }
  | { status: 'error'; retry: () => void }
  | {
      status: 'ready';
      value: string;
      count: number;
      hint: string;
      /** Something has waited long enough for it to matter: the hint turns amber */
      urgent: boolean;
    };

export interface KeyFigure {
  id: string;
  label: string;
  href: string;
  state: KpiState;
}

/*
 * Hairlines between figures, inset from the tile's edges. Phones: a 2×2 grid whose two lines cross in the
 * middle. From lg: four in a row with short vertical lines between them.
 */
const V = 'before:absolute before:left-0 before:w-px before:bg-border/80';
const H = 'after:absolute after:top-0 after:h-px after:bg-border/80 lg:after:hidden';
const DIVIDERS = [
  '',
  `${V} before:top-5 before:bottom-0 lg:before:bottom-5`,
  `${H} after:left-5 after:right-0 sm:after:left-6 lg:before:absolute lg:before:inset-y-5 lg:before:left-0 lg:before:w-px lg:before:bg-border/80`,
  `${V} before:top-0 before:bottom-5 lg:before:top-5 ${H} after:left-0 after:right-5 sm:after:right-6`,
];

/** The queues at a glance: one tile, one figure per queue, each opening its queue */
export function KeyFigures({ figures }: { figures: KeyFigure[] }) {
  return (
    <Card className="overflow-hidden">
      <ul className="grid grid-cols-2 lg:grid-cols-4">
        {figures.map((figure, index) => (
          <li
            key={figure.id}
            className={cn('relative before:pointer-events-none before:z-[1] after:pointer-events-none after:z-[1]', DIVIDERS[index % 4])}
          >
            <Figure {...figure} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Figure({ label, href, state }: KeyFigure) {
  return (
    <div className="group relative flex h-full flex-col px-5 py-5 transition-colors duration-150 hover:bg-accent/70 has-[a:focus-visible]:bg-accent/70 sm:px-6">
      {/* Two lines on phones, so figures in the same row line up whatever their label's length */}
      <h3 className="flex min-h-9 items-start justify-between gap-2 text-[13px] font-medium leading-[18px] text-muted-foreground lg:min-h-0">
        {/* Stretched link: the whole figure is one large target, but its name stays short and specific */}
        <Link to={href} className="after:absolute after:inset-0 focus-visible:outline-none">
          {label}
          {state.status === 'ready' ? <span className="sr-only">: {state.value}</span> : null}
        </Link>
        <ChevronRight
          className="mt-px size-4 shrink-0 text-muted-foreground/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-muted-foreground"
          aria-hidden="true"
        />
      </h3>

      {state.status === 'loading' ? (
        <div className="mt-2.5 space-y-2.5">
          <Skeleton className="h-7 w-14" />
          <Skeleton className="h-3.5 w-28" />
          <span className="sr-only">Loading</span>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="mt-2 space-y-2">
          <p className="text-[14px] font-medium text-destructive">Couldn’t load</p>
          {/* Above the stretched link so it stays clickable */}
          <Button variant="secondary" size="sm" className="relative z-10" aria-label={`Try again loading ${label.toLowerCase()}`} onClick={state.retry}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <>
          {/* The link already carries the count for screen readers */}
          <p className="mt-1.5 text-[28px] font-semibold leading-8 tracking-[-0.028em] tnum" aria-hidden="true">
            {state.value}
          </p>
          <p className={cn('mt-1 text-[13px] leading-[18px]', state.urgent ? 'font-medium text-warning' : 'text-muted-foreground')}>{state.hint}</p>
        </>
      ) : null}
    </div>
  );
}
