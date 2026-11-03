import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { formatDateTime } from './format';

export interface TimelineItem {
  id: string;
  title: ReactNode;
  /** Who did it, already formatted ("You", "Customer", "Analyst 1a2b3c4d") */
  actor: ReactNode;
  at: string;
  children?: ReactNode;
}

/**
 * An audit trail drawn as a timeline: a hairline joining small markers, each entry saying what, who and
 * when. Entries are plain text on the tile, never boxes. Newest or oldest first as given.
 */
export function Timeline({ items, label, className }: { items: TimelineItem[]; label: string; className?: string }) {
  return (
    <ol aria-label={label} className={cn('relative', className)}>
      {items.map((item, index) => (
        <li key={item.id} className="relative pb-5 pl-6 last:pb-0">
          {index < items.length - 1 ? <span className="absolute bottom-0 left-[4.5px] top-3 w-px bg-border" aria-hidden="true" /> : null}
          <span className="absolute left-0 top-[7px] size-2.5 rounded-full border-2 border-card bg-foreground/35 ring-1 ring-border" aria-hidden="true" />
          <p className="text-[15px] font-medium leading-5 tracking-[-0.01em]">{item.title}</p>
          <p className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground">
            By {item.actor} · <time dateTime={item.at}>{formatDateTime(item.at)}</time>
          </p>
          {item.children ? <div className="mt-2 text-[14px] leading-5">{item.children}</div> : null}
        </li>
      ))}
    </ol>
  );
}
