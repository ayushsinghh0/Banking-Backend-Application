import type { AccountType, BankAccount, LedgerEntry, TransactionType } from '@/lib/api/types';
import { isApiError } from '@/lib/api/errors';
import { formatPaise } from '@/lib/money';
import { maskAccountNumber } from '@/lib/validation';

/**
 * The bank's default policy values (each is configurable on the server). The UI uses them only to explain
 * the rules up front; the API enforces them and its error is what decides.
 */
export const POLICY = {
  /** Transfers at or above this need a fresh authenticator code */
  transferStepUpPaise: '10000000',
  /** Withdrawal codes at or above this need a fresh authenticator code */
  withdrawalCodeStepUpPaise: '2500000',
  /** A withdrawal code is valid for this long */
  withdrawalCodeTtlMinutes: 15,
  /** A new payee becomes usable after this many minutes, unless approved with the authenticator */
  payeeCoolingMinutes: 60,
  /** Total a new payee can receive in its first 24 hours */
  newPayeeLimitPaise: '5000000',
  /** The highest daily limit customers can set themselves */
  customerDailyLimitCapPaise: '10000000',
} as const;

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = { SAVINGS: 'Savings', CURRENT: 'Current' };

/** "Savings account" */
export const accountTitle = (account: Pick<BankAccount, 'accountType'>) => `${ACCOUNT_TYPE_LABEL[account.accountType]} account`;

/** "Savings ••••6789" */
export const accountShortName = (account: Pick<BankAccount, 'accountType' | 'accountNumber'>) =>
  `${ACCOUNT_TYPE_LABEL[account.accountType]} ${maskAccountNumber(account.accountNumber)}`;

const TYPE_LABEL: Record<TransactionType, string> = {
  DEPOSIT: 'Cash deposit',
  WITHDRAWAL: 'Cash withdrawal',
  TRANSFER: 'Transfer',
  CASH_TRANSFER: 'Cash transfer',
  ONLINE_TOP_UP: 'Money added',
  TOP_UP_REFUND: 'Top-up refunded',
};

/** What a statement line says: the description if there is one, otherwise the kind of transaction */
export const entryLabel = (entry: Pick<LedgerEntry, 'description' | 'type'>) => entry.description?.trim() || TYPE_LABEL[entry.type];

export const isNotFound = (error: unknown) => isApiError(error) && error.status === 404;

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** "27 Oct 2026" */
export const formatDate = (iso: string | Date) => dateFormat.format(new Date(iso));
/** "27 Oct" */
export const formatShortDate = (iso: string | Date) => shortDateFormat.format(new Date(iso));
/** "3:00 pm" */
export const formatTime = (iso: string | Date) => timeFormat.format(new Date(iso));
/** "27 Oct 2026, 3:00 pm" */
export const formatDateTime = (iso: string | Date) => dateTimeFormat.format(new Date(iso));

/** A wait in words, for cooling-off periods: "42 min", "1 h 5 min", "less than a minute" */
export function formatWait(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A short countdown clock: "14:05" */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Local calendar day key "2026-10-27" (statements and charts follow the customer's own day) */
export function dayKey(value: string | Date): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const weekdayFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
const weekdayYearFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** The heading above a day's transactions: "Today", "Yesterday", "Tuesday, 20 October" (with the year if it isn't this one) */
export function dayHeading(value: string | Date, now = new Date()): string {
  const date = new Date(value);
  const key = dayKey(date);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return (date.getFullYear() === now.getFullYear() ? weekdayFormat : weekdayYearFormat).format(date);
}

export interface DayGroup<T> {
  /** Local calendar day, "2026-10-27" */
  key: string;
  heading: string;
  items: T[];
}

/** Splits an already-sorted list into runs of items from the same local day, keeping their order */
export function groupByDay<T>(items: T[], dateOf: (item: T) => string, now = new Date()): Array<DayGroup<T>> {
  const groups: Array<DayGroup<T>> = [];
  for (const item of items) {
    const key = dayKey(dateOf(item));
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, heading: dayHeading(dateOf(item), now), items: [item] });
  }
  return groups;
}

/** Pulls a paise amount out of a server message such as "Daily limits above 10000000 paise require…" */
export function paiseInMessage(message: string): string | null {
  const match = /(\d{1,18}) paise/.exec(message);
  return match?.[1] ? formatPaise(match[1]) : null;
}

/** Time-of-day greeting in the customer's local time */
export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] ?? fullName;
