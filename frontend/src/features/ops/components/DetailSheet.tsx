import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { DESKTOP_QUERY, useMediaQuery } from '@/lib/useMediaQuery';
import { Dialog, SheetContent } from '@/components/ui/overlays';

/**
 * A record opened over its list: a side sheet on desktop, a full-height sheet rising from the bottom on
 * phones. The body scrolls; an optional footer holds the record's one action within thumb reach.
 */
export function DetailSheet({
  open,
  onOpenChange,
  title,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the sheet */
  title: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={desktop ? 'right' : 'bottom'}
        title={title}
        className={cn('focus:outline-none', desktop ? 'w-[min(100vw,30rem)]' : 'h-[94dvh] max-h-[94dvh] pb-0')}
        // The sheet is a view, not a form: focus the panel itself so a screen reader starts at the top
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        tabIndex={-1}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-6 sm:px-6">{children}</div>
        {footer ? (
          <div className="border-t px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 lg:pb-4">{footer}</div>
        ) : null}
      </SheetContent>
    </Dialog>
  );
}
