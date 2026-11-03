import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { formatPaise } from '@/lib/money';
import { cn } from '@/lib/cn';
import type { AccountType, CashOperationType, TellerSession } from '@/lib/api/types';
import type { Role } from '@/lib/auth/session';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';

/**
 * Shared by the teller desk and the supervisor cash pages. Branch business dates are IST calendar days, so
 * times are shown in IST whatever the device's time zone (every branch works on India time).
 */
export const IST = 'Asia/Kolkata';
export const PAGE_SIZE = 20;

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: IST,
});

const businessDateFormatter = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const isoDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });

function parts(formatter: Intl.DateTimeFormat, date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value;
  return out;
}

/** "27 Oct 2026, 3:15 pm IST" (built from parts so every browser renders the same separators) */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const p = parts(dateTimeFormatter, date);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toLowerCase()} IST`;
}

const timeFormatter = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST });
const dayMonthFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: IST });

/**
 * A time within a business day, as short as it can be: "2:44 pm" on that day, "28 Oct, 9:05 am" on another
 * (all IST). For dense lists; formatDateTime is the full form.
 */
export function formatTimeOnDay(iso: string | null | undefined, businessDate: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const t = parts(timeFormatter, date);
  const time = `${t.hour}:${t.minute} ${(t.dayPeriod ?? '').toLowerCase()}`;
  if (istToday(date) === businessDate) return time;
  const d = parts(dayMonthFormatter, date);
  return `${d.day} ${d.month}, ${time}`;
}

/** "2026-10-27" -> "Tue, 27 Oct 2026" (a calendar date, never shifted by time zones) */
export function formatBusinessDate(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return value ?? '—';
  const p = parts(businessDateFormatter, new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}`;
}

/** Today's IST business date as YYYY-MM-DD, the same calendar the ledger uses */
export function istToday(now: Date = new Date()): string {
  return isoDayFormatter.format(now);
}

export const shortId = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/**
 * placeholderData for the paged lists (keys shaped [area, list, status, offset]): keeps the current page on
 * screen while the next page of the SAME filter loads, but never shows one tab's rows under another tab.
 */
export function keepPageWithinFilter<T>(status: string | undefined) {
  return (previous: T | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined): T | undefined =>
    previousQuery && previousQuery.queryKey[2] === (status ?? 'all') ? previous : undefined;
}

/**
 * A session as supervisors see it. A first supervisor's count that disagreed with the teller is recorded
 * (who and when; the figure itself only after reconciliation) so a second administrator can confirm it.
 */
export type SupervisorSession = TellerSession & {
  disputedBy?: string | null;
  disputedAt?: string | null;
  disputedCount?: string | null;
};

/** True when two administrators' matching counts, not the teller's declaration, settled the session */
export function settledByDispute(s: SupervisorSession): boolean {
  if (s.status !== 'RECONCILED' || !s.disputedBy) return false;
  const integer = /^-?\d+$/;
  if (!integer.test(s.disputedCount ?? '') || !integer.test(s.expectedClosing ?? '') || !integer.test(s.discrepancy ?? '')) return false;
  const counted = (BigInt(s.expectedClosing as string) + BigInt(s.discrepancy as string)).toString();
  return counted === s.disputedCount && counted !== s.declaredClosing;
}

export const CASH_TYPE_LABEL: Record<CashOperationType, string> = { DEPOSIT: 'Deposit', WITHDRAWAL: 'Withdrawal' };
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = { SAVINGS: 'Savings', CURRENT: 'Current' };

/** How a signed discrepancy (counted − expected) reads: words, sign and colour together */
export function describeDiscrepancy(paise: string | null | undefined): { label: string; tone: 'success' | 'danger' | 'warning' } | null {
  if (paise === null || paise === undefined || !/^-?\d+$/.test(paise)) return null;
  const value = BigInt(paise);
  if (value === 0n) return { label: 'Balanced', tone: 'success' };
  if (value < 0n) return { label: `Short by ${formatPaise(-value)}`, tone: 'danger' };
  return { label: `Over by ${formatPaise(value)}`, tone: 'warning' };
}

/** The close-out result in words first (colour only reinforces it): balanced, short (red) or over (amber) */
export function Discrepancy({ paise, className }: { paise: string | null | undefined; className?: string }) {
  const described = describeDiscrepancy(paise);
  if (!described) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-baseline gap-x-1.5 font-medium',
        described.tone === 'danger' && 'text-destructive',
        described.tone === 'warning' && 'text-warning',
        className
      )}
    >
      <span className="tnum">{described.label}</span>
    </span>
  );
}

/**
 * Staff emails by id for one role (bounded to the first 100). Purely cosmetic: when the directory can't be
 * read the pages fall back to a short id instead of failing.
 */
export function useStaffDirectory(role: Extract<Role, 'TELLER' | 'BANK_ADMIN'>) {
  const api = useApi();
  const params = { role, limit: 100 } as const;
  const query = useQuery({
    queryKey: qk.directory(params),
    queryFn: () => api.admin.users(params),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const byId = new Map((query.data ?? []).map((u) => [u.id, u]));
  return {
    query,
    users: query.data ?? [],
    label: (id: string | null | undefined) => (id ? (byId.get(id)?.email ?? shortId(id)) : '—'),
  };
}

export interface StatusTab<T extends string> {
  value: T;
  label: string;
}

/** Status filter tabs (the segmented control) above a single panel: the list for the selected status */
export function StatusTabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
  children,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: ReadonlyArray<StatusTab<T>>;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)} className={className}>
      <TabsList aria-label={label}>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={value} className="mt-4 lg:mt-5">
        {children}
      </TabsContent>
    </Tabs>
  );
}

/**
 * The amount field for cash counts and the teller's transactions: the figure is the point of the form, so it
 * is set large, with the rupee sign to match.
 */
export const LargeMoneyInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <div className="relative">
    <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-[22px] font-medium text-muted-foreground" aria-hidden="true">
      ₹
    </span>
    <Input
      ref={ref}
      inputMode="decimal"
      autoComplete="off"
      placeholder="0.00"
      className={cn('h-14 pl-10 text-[24px] font-semibold tracking-[-0.02em] tnum placeholder:font-normal placeholder:text-muted-foreground/50 sm:text-[24px]', className)}
      {...props}
    />
  </div>
));
LargeMoneyInput.displayName = 'LargeMoneyInput';
