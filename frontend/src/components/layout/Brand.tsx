import { useId } from 'react';
import { cn } from '@/lib/cn';

const FRONT_ARC = 'M3 16 A13 4.6 0 0 0 29 16';
const BACK_ARC = 'M3 16 A13 4.6 0 0 1 29 16';

/** BankSphere mark: a sphere inside an orbit. Drawn in currentColor, so it follows the theme. */
export function BrandMark({ className }: { className?: string }) {
  // Unique per instance: a mask referenced by id from a hidden copy doesn't paint
  const maskId = `bs-mark-${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 32 32" fill="none" className={cn('size-7', className)} aria-hidden="true">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect width="32" height="32" fill="white" />
          <path d={FRONT_ARC} transform="rotate(-22 16 16)" stroke="black" strokeWidth="5" strokeLinecap="round" />
        </mask>
      </defs>
      <path d={BACK_ARC} transform="rotate(-22 16 16)" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="16" cy="16" r="8.25" fill="currentColor" mask={`url(#${maskId})`} />
      <path d={FRONT_ARC} transform="rotate(-22 16 16)" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function BrandLogo({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', inverted ? 'text-white' : 'text-foreground', className)}>
      <BrandMark />
      <span className="text-[17px] font-semibold tracking-[-0.022em]">BankSphere</span>
    </span>
  );
}
