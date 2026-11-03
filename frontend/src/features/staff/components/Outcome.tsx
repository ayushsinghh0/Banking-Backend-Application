import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { describeError } from '@/lib/api/errors';
import { Callout } from '@/components/ui/primitives';

/** The result of an action that the person needs to read: a refusal, a queued request, a stale view */
export interface Outcome {
  tone: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  body?: ReactNode;
}

export const outcomeFromError = (error: unknown): Outcome => {
  const { title, description } = describeError(error);
  return { tone: 'danger', title, body: description };
};

export function OutcomeCallout({ outcome, onDismiss, className }: { outcome: Outcome | null; onDismiss: () => void; className?: string }) {
  if (!outcome) return null;
  return (
    <Callout
      tone={outcome.tone}
      title={outcome.title}
      className={className}
      action={
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      }
    >
      {outcome.body}
    </Callout>
  );
}
