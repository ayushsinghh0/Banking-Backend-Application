import type { HTMLAttributes } from 'react';
import type { AccountType, BankAccount } from '@/lib/api/types';
import { cn } from '@/lib/cn';

/*
 * The account card, as in Wallet: graphite for savings, deep blue for current. These two faces (and the tiny
 * swatch that echoes them in lists) are the only gradients in the customer app. Both keep white text above
 * 4.5:1 across the whole face.
 */
const FACES: Record<AccountType, string> = {
  SAVINGS: 'bg-[linear-gradient(135deg,#3a3a3c_0%,#1f1f21_48%,#0b0b0c_100%)]',
  CURRENT: 'bg-[linear-gradient(135deg,#1f62d6_0%,#1350bd_52%,#0b3f9e_100%)]',
};

const SWATCHES: Record<AccountType, string> = {
  SAVINGS: 'bg-gradient-to-br from-[#2c2c2e] to-[#0b0b0c]',
  CURRENT: 'bg-gradient-to-br from-[#2f7bf5] to-[#0a4fc4]',
};

/** A small card swatch, so savings and current read apart at a glance in lists */
export function AccountSwatch({ type, className }: { type: AccountType; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative h-7 w-10 shrink-0 overflow-hidden rounded-[6px] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.12)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16)]',
        SWATCHES[type],
        className
      )}
    >
      <span className="absolute bottom-1 left-1 h-[3px] w-3 rounded-full bg-white/70" />
    </span>
  );
}

/**
 * The face of an account card: a credit-card shaped surface with white type. Content is laid out by the
 * caller; a frozen account's card is shown in greyscale so it reads as unavailable before any text does.
 */
export function AccountCardFace({
  account,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { account: Pick<BankAccount, 'accountType' | 'status'> }) {
  return (
    <div
      className={cn(
        'relative isolate overflow-hidden rounded-[20px] text-white shadow-raised',
        // A faint sheen from the top right gives the surface some depth without becoming decoration
        'before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(120%_90%_at_100%_0%,rgb(255_255_255/0.13),transparent_55%)]',
        'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.12)] dark:after:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]',
        FACES[account.accountType],
        account.status === 'FROZEN' && 'saturate-0',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
