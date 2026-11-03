import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * The money field for flows where the amount is the point: large, quiet, filled, with the rupee sign set in
 * the same size so the figure reads as one. Same contract as MoneyInput (decimal keypad, no autofill).
 */
export const AmountField = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: 'lg' | 'md' }>(
  ({ className, size = 'lg', ...props }, ref) => (
    <div
      className={cn(
        'flex items-center rounded-2xl border border-transparent bg-muted transition-[background-color,border-color,box-shadow] duration-200',
        'hover:bg-secondary has-[:focus-visible]:border-ring has-[:focus-visible]:bg-background has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-ring/20',
        'has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:has-[:focus-visible]:ring-destructive/20',
        size === 'lg' ? 'h-[76px] px-5' : 'h-16 px-4'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'select-none font-semibold tracking-[-0.03em] text-muted-foreground',
          size === 'lg' ? 'text-[32px] sm:text-[36px]' : 'text-[26px]'
        )}
      >
        ₹
      </span>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        className={cn(
          'h-full w-full min-w-0 bg-transparent pl-1.5 font-semibold tracking-[-0.03em] text-foreground tnum outline-none placeholder:text-muted-foreground/40',
          'focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
          size === 'lg' ? 'text-[32px] sm:text-[36px]' : 'text-[26px]',
          className
        )}
        {...props}
      />
    </div>
  )
);
AmountField.displayName = 'AmountField';
