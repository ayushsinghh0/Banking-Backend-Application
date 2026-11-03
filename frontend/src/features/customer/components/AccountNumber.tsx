import { CopyButton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { formatAccountNumber } from '@/lib/validation';

/**
 * A full account number grouped for reading (1001 2345 6789), with a copy button that copies the digits.
 * `inverse` sets it in white for the account card. The copy target is 32px but takes taps across 44px.
 */
export function AccountNumber({
  value,
  className,
  inverse,
  size = 'md',
}: {
  value: string;
  className?: string;
  inverse?: boolean;
  size?: 'md' | 'lg';
}) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <span
        className={cn(
          'tracking-[0.06em] tnum',
          size === 'lg' ? 'text-[19px] tracking-[0.08em]' : 'text-[15px]',
          inverse ? 'font-medium text-white' : 'text-muted-foreground'
        )}
      >
        {formatAccountNumber(value)}
      </span>
      <CopyButton
        value={value}
        label="Copy account number"
        className={cn(
          'relative after:absolute after:-inset-1.5',
          inverse && 'text-white/90 hover:bg-white/15 hover:text-white focus-visible:ring-white focus-visible:ring-offset-0 [&_svg]:!text-current'
        )}
      />
    </span>
  );
}
