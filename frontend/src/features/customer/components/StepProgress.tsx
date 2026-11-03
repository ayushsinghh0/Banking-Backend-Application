import { cn } from '@/lib/cn';

/**
 * Progress through a short flow: one slim segment per step, filled up to the current one, with the step
 * names underneath. The current step is marked for assistive technology (aria-current="step").
 */
export function StepProgress({ steps, current, label }: { steps: readonly string[]; current: number; label: string }) {
  return (
    <ol aria-label={label} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((step, index) => {
        const done = index < current;
        const here = index === current;
        return (
          <li key={step} aria-current={here ? 'step' : undefined} className="min-w-0 space-y-2">
            <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-foreground/10">
              <span
                className={cn(
                  'block h-full origin-left rounded-full bg-foreground transition-transform duration-500 ease-out',
                  done || here ? 'scale-x-100' : 'scale-x-0'
                )}
              />
            </span>
            <span
              className={cn(
                'block truncate text-[13px] tracking-[-0.005em]',
                here ? 'font-semibold text-foreground' : done ? 'font-medium text-foreground/70' : 'font-medium text-muted-foreground'
              )}
            >
              {step}
              {done ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
