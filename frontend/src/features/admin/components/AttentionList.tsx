import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge, Callout, EmptyState, Skeleton, type BadgeTone } from '@/components/ui/primitives';
import { durationSince } from './format';
import { linkRowClass, Panel } from './Panel';

export interface AttentionItem {
  key: string;
  /** "Four-eyes request", "Cash approval", ... */
  kind: string;
  title: string;
  /** A small label after the title, e.g. which way the money moved */
  tag?: string;
  /** Lines under the meta line: who or what it is about */
  detail: ReactNode;
  /** When it started waiting */
  since: string;
  /** Severity and similar, shown as a soft badge at the end of the row */
  badge?: { label: string; tone: BadgeTone };
  href: string;
}

const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The oldest waiting work across every queue, so the next decision is obvious */
export function AttentionList({
  items,
  loading,
  failed,
  now,
  className,
}: {
  items: AttentionItem[];
  loading: boolean;
  /** Names of queues that failed to load */
  failed: string[];
  now: number;
  className?: string;
}) {
  let body: ReactNode;
  if (items.length > 0) {
    body = (
      <ol>
        {items.map((item) => (
          <li key={item.key} className={cn(linkRowClass, 'flex items-start gap-3')}>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link
                  to={item.href}
                  className="text-[15px] font-medium leading-5 tracking-[-0.01em] after:absolute after:inset-0 focus-visible:outline-none"
                >
                  {item.title}
                </Link>
                {item.tag ? (
                  <span className="inline-flex h-[18px] items-center rounded-[5px] bg-muted px-1.5 text-[11px] font-medium leading-none text-muted-foreground">
                    {item.tag}
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground">
                <span>{item.kind}</span>
                <span aria-hidden="true">·</span>
                <span className="tnum">Waiting {durationSince(item.since, now)}</span>
              </p>
              {item.detail ? (
                <div className="mt-1.5 space-y-0.5 break-words text-[13px] leading-[18px] text-foreground/80">{item.detail}</div>
              ) : null}
            </div>
            {item.badge ? (
              <Badge tone={item.badge.tone} className="mt-px shrink-0">
                {item.badge.label}
              </Badge>
            ) : null}
            <ChevronRight
              className="mt-0.5 size-4 shrink-0 text-muted-foreground/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-muted-foreground"
              aria-hidden="true"
            />
          </li>
        ))}
      </ol>
    );
  } else if (loading) {
    body = (
      <div className="space-y-5 py-2">
        <span className="sr-only">Loading</span>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    );
  } else if (failed.length > 0) {
    body = <p className="py-2 text-[14px] text-muted-foreground">Nothing else is waiting.</p>;
  } else {
    body = (
      <EmptyState icon={CheckCircle2} title="You’re all caught up" description="Nothing is waiting for a decision right now." className="py-10" />
    );
  }

  return (
    <Panel
      title="Needs your attention"
      className={className}
      footnote={items.length > 0 ? 'Oldest first, across every queue. Requests only a colleague can decide are left out.' : undefined}
    >
      {failed.length > 0 ? (
        <Callout tone="warning" title={`${joinNames(failed)} couldn’t be loaded`} className="mb-3">
          The other queues are shown below. Use Try again above.
        </Callout>
      ) : null}
      {body}
    </Panel>
  );
}
