import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The actions along the foot of a form tile. With `sticky` (the default) it stays pinned just above the tab
 * bar on phones and tablets while the form scrolls, so the next step is always one thumb away; on desktop
 * it sits in place.
 */
export function TileFooter({ children, sticky = true, className }: { children: ReactNode; sticky?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'z-10 flex flex-col-reverse gap-2 rounded-b-2xl border-t bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-7 sm:py-5',
        sticky && 'sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] lg:static',
        className
      )}
    >
      {children}
    </div>
  );
}
