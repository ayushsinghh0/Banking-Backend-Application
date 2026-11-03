import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { NativeSelect } from '@/components/ui/input';

/**
 * NativeSelect with a drawn chevron, so a select never reads as a text field. (The shared component's
 * background-image chevron doesn't render; `bg-none` keeps a future fix from showing two.)
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <div className="relative">
    <NativeSelect ref={ref} className={cn('bg-none pr-10', className)} {...props}>
      {children}
    </NativeSelect>
    <ChevronDown
      className="pointer-events-none absolute right-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground"
      strokeWidth={2}
      aria-hidden="true"
    />
  </div>
));
Select.displayName = 'Select';
