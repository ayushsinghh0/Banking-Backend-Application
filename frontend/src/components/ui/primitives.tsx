import { forwardRef, useEffect, useRef, useState, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Copy, Check, Info, Loader2, OctagonAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatPaise } from '@/lib/money';
import { Input } from './input';

// --- Card -------------------------------------------------------------------------------------

/** A tile: white on the canvas in light mode, raised graphite in dark mode. No borders, no drop shadows. */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('rounded-2xl bg-card text-card-foreground shadow-card', className)} {...props} />
));
Card.displayName = 'Card';

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 px-5 pb-3 pt-5 sm:px-6 sm:pt-6', className)} {...props} />;
}

export function CardTitle({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn('text-headline', className)} {...props}>
      {children}
    </h2>
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-[13px] leading-[18px] text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5 pt-1 sm:px-6 sm:pb-6', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 border-t px-5 py-3.5 sm:px-6', className)} {...props} />;
}

// --- Badge ------------------------------------------------------------------------------------

export const badgeVariants = cva(
  'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium leading-none tracking-[-0.003em]',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        primary: 'bg-primary-soft text-primary',
        success: 'bg-success-soft text-success',
        warning: 'bg-warning-soft text-warning',
        danger: 'bg-destructive-soft text-destructive',
        info: 'bg-info-soft text-info',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({ className, tone, dot, children, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  VERIFIED: 'success',
  EXECUTED: 'success',
  APPROVED: 'success',
  RESOLVED: 'success',
  RECONCILED: 'success',
  COMPLETED: 'success',
  SENT: 'success',
  CREDITED: 'success',
  // Blue is for links and focus, not status: open is the normal state; an issued float waits on the teller
  OPEN: 'neutral',
  ISSUED: 'warning',
  CREATED: 'warning',
  PENDING: 'warning',
  CAPTURED: 'warning',
  CREDIT_BLOCKED: 'warning',
  REFUND_PENDING: 'warning',
  PENDING_APPROVAL: 'warning',
  UNDER_REVIEW: 'warning',
  CLOSED: 'neutral',
  DISMISSED: 'neutral',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  REFUNDED: 'neutral',
  FROZEN: 'danger',
  REJECTED: 'danger',
  FAILED: 'danger',
  DEAD_LETTER: 'danger',
  DISABLED: 'danger',
  // Risk severity: red is kept for the one level that needs it
  LOW: 'neutral',
  MEDIUM: 'neutral',
  HIGH: 'warning',
  CRITICAL: 'danger',
};

export const humanize = (value: string) =>
  value
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');

/** Consistent colour + wording for every status enum the API returns */
export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} dot className={className}>
      {label ?? humanize(status)}
    </Badge>
  );
}

// --- Callout ----------------------------------------------------------------------------------

const calloutIcons = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: OctagonAlert };
const calloutTones = {
  info: 'bg-info-soft [&_svg]:text-info',
  success: 'bg-success-soft [&_svg]:text-success',
  warning: 'bg-warning-soft [&_svg]:text-warning',
  danger: 'bg-destructive-soft [&_svg]:text-destructive',
};

export function Callout({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof calloutTones;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = calloutIcons[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex flex-col gap-3 rounded-2xl p-4 text-[14px] text-foreground sm:flex-row sm:items-center', calloutTones[tone], className)}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <Icon className="mt-0.5 size-[18px] shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-0.5">
          {title ? <p className="font-semibold leading-5 tracking-[-0.01em]">{title}</p> : null}
          {children ? <div className="leading-5 text-foreground/75 [&_strong]:font-semibold [&_strong]:text-foreground">{children}</div> : null}
        </div>
      </div>
      {action ? <div className="shrink-0 pl-[30px] sm:pl-0">{action}</div> : null}
    </div>
  );
}

// --- Loading & empty states -------------------------------------------------------------------

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative overflow-hidden rounded-lg bg-muted before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-foreground/[0.035] before:to-transparent',
        className
      )}
      {...props}
    />
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-sm text-muted-foreground', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number | string }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {Icon ? <Icon className="mb-3 size-9 text-muted-foreground/60" strokeWidth={1.4} aria-hidden="true" /> : null}
      <p className="text-headline">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-pretty text-[14px] leading-5 text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

// --- Page structure ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? <div className="text-[13px] font-medium text-muted-foreground">{eyebrow}</div> : null}
        <h1 className="large-title">{title}</h1>
        {description ? <p className="max-w-2xl text-pretty text-[15px] leading-[22px] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A headline figure. Typography carries the hierarchy: no icon tiles, no colour unless it means something. */
export function StatCard({
  label,
  value,
  hint,
  loading,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** @deprecated figures no longer show icons */
  icon?: React.ComponentType<{ className?: string }>;
  /** @deprecated figures no longer use tones */
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
  loading?: boolean;
  className?: string;
}) {
  return (
    <Card className={cn('p-5 sm:p-6', className)}>
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 text-[28px] font-semibold leading-8 tracking-[-0.028em] tnum">{loading ? <Skeleton className="h-8 w-32" /> : value}</div>
      {hint ? <div className="mt-1.5 text-[13px] leading-[18px] text-muted-foreground">{hint}</div> : null}
    </Card>
  );
}

/**
 * Label/value rows, as in iOS Settings: the label on the left and the value on the right, wrapping under the
 * label when the pair doesn't fit (long addresses, narrow side panels).
 */
export function DescriptionList({ items, className }: { items: Array<{ label: string; value: ReactNode }>; className?: string }) {
  return (
    <dl className={cn('divide-y divide-border/70', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 py-3">
          <dt className="shrink-0 text-[14px] text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 max-w-full break-words text-right text-[15px] [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// --- Money ------------------------------------------------------------------------------------

/** An amount in paise; money in is green and signed, money out stays ink (red is for errors, not spending) */
export function Amount({
  paise,
  direction,
  className,
}: {
  paise: string | null | undefined;
  direction?: 'CREDIT' | 'DEBIT';
  className?: string;
}) {
  const signed = direction === 'DEBIT' && paise ? `-${paise}` : paise;
  return (
    <span
      className={cn(
        'tnum whitespace-nowrap font-medium tracking-[-0.01em]',
        direction === 'CREDIT' && 'text-success',
        direction === 'DEBIT' && 'text-foreground',
        className
      )}
    >
      {formatPaise(signed, { sign: direction ? 'always' : 'auto' })}
    </span>
  );
}

/** A large balance: rupees in full weight, paise quieter, as on a bank card or statement header */
export function BigAmount({ paise, className }: { paise: string | null | undefined; className?: string }) {
  const text = formatPaise(paise);
  const dot = text.lastIndexOf('.');
  if (dot === -1) return <span className={cn('tnum', className)}>{text}</span>;
  return (
    <span className={cn('tnum whitespace-nowrap', className)}>
      {text.slice(0, dot)}
      <span className="text-muted-foreground/70">{text.slice(dot)}</span>
    </span>
  );
}

export const MoneyInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <div className="relative">
    <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-[15px] text-muted-foreground" aria-hidden="true">
      ₹
    </span>
    <Input ref={ref} inputMode="decimal" autoComplete="off" placeholder="0.00" className={cn('pl-8 tnum', className)} {...props} />
  </div>
));
MoneyInput.displayName = 'MoneyInput';

// --- Misc -------------------------------------------------------------------------------------

/** A contact-style monogram */
export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials =
    name
      .split('@')[0]!
      .split(/[\s._-]+/)
      .filter((part) => /^\p{L}/u.test(part))
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join('') || '?';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-8 shrink-0 select-none items-center justify-center rounded-full bg-gradient-to-b from-[#a7a7ad] to-[#86868c] text-[12.5px] font-semibold tracking-[0.01em] text-white dark:from-[#6e6e73] dark:to-[#545458]',
        className
      )}
    >
      {initials}
    </span>
  );
}

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={cn(
        // 32px to look at, 44px to hit (the ::after extends the target on touch screens)
        'relative inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors after:absolute after:-inset-1.5 after:content-[""] hover:bg-accent hover:text-foreground cursor-pointer',
        className
      )}
      aria-label={copied ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="size-3.5 text-success" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md bg-muted px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted-foreground">{children}</kbd>;
}

/** Copyable identifier (UUIDs, references) shortened for tables */
export function Mono({ value, short = true, copy = false }: { value: string; short?: boolean; copy?: boolean }) {
  const text = short && value.length > 12 ? `${value.slice(0, 8)}…` : value;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12.5px] text-muted-foreground" title={value}>
      {text}
      {copy ? <CopyButton value={value} label="Copy identifier" /> : null}
    </span>
  );
}
