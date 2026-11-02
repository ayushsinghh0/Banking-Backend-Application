import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/**
 * Cursor paging for a filtered list: the cursors of the pages already seen, so "Previous" goes back without
 * the API needing to page backwards. Changing the filters (a new key) starts again from the first page.
 */
export function useCursorPages(filterKey: string) {
  const [state, setState] = useState<{ key: string; stack: string[] }>({ key: filterKey, stack: [] });
  // Forget the old filters' pages for good, so returning to them later starts at the first page too
  if (state.key !== filterKey) setState({ key: filterKey, stack: [] });
  const stack = state.key === filterKey ? state.stack : [];
  return {
    cursor: stack[stack.length - 1],
    /** 1 for the first page */
    page: stack.length + 1,
    next: (cursor: string) => setState({ key: filterKey, stack: [...stack, cursor] }),
    previous: () => setState({ key: filterKey, stack: stack.slice(0, -1) }),
  };
}

export function CursorPagination({
  page,
  limit,
  count,
  hasNext,
  onNext,
  onPrevious,
  className,
}: {
  page: number;
  limit: number;
  count: number;
  hasNext: boolean;
  onNext: () => void;
  onPrevious: () => void;
  className?: string;
}) {
  const from = (page - 1) * limit + 1;
  return (
    <nav aria-label="Pagination" className={cn('flex items-center justify-between gap-3 border-t px-5 py-3 sm:px-6', className)}>
      <p className="text-[13px] text-muted-foreground tnum" aria-live="polite">
        {count === 0 ? 'No results' : `Showing ${from}–${from + count - 1}`}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" className="max-sm:h-10" disabled={page <= 1} onClick={onPrevious}>
          <ChevronLeft aria-hidden="true" /> Previous
        </Button>
        <Button variant="secondary" size="sm" className="max-sm:h-10" disabled={!hasNext} onClick={onNext}>
          Next <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
