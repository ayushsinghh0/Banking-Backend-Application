import type { BankAccount, LedgerEntry } from '@/lib/api/types';
import { addPaise, type Paise } from '@/lib/money';
import { dayKey, formatShortDate } from './lib';

export interface AccountEntry {
  account: BankAccount;
  entry: LedgerEntry;
}

export interface DayFlow {
  key: string;
  label: string;
  inPaise: Paise;
  outPaise: Paise;
  /** Chart geometry only (never used for money maths or display) */
  in: number;
  /** Negative, so money out is drawn below the axis */
  out: number;
}

export interface CashFlow {
  days: DayFlow[];
  totalIn: Paise;
  totalOut: Paise;
  hasActivity: boolean;
  /** The day with the most money out, if any */
  busiestDay: DayFlow | null;
}

/**
 * Transactions that debited one of the customer's accounts and credited another of them: moving money
 * between your own accounts is neither income nor spending.
 */
export function internalTransactionIds(entries: AccountEntry[]): Set<string> {
  const debits = new Set<string>();
  const credits = new Set<string>();
  for (const { entry } of entries) (entry.entryType === 'DEBIT' ? debits : credits).add(entry.transactionId);
  return new Set([...debits].filter((id) => credits.has(id)));
}

export interface BalancePoint {
  key: string;
  label: string;
  balancePaise: Paise;
  /** Chart geometry only, in rupees (never used for money maths or display) */
  value: number;
}

export interface AccountHistory {
  entries: LedgerEntry[];
  /** The balance the API reports now, used for accounts with no statement entries */
  currentPaise: Paise | undefined;
  /** True when the statement page was full, so older entries exist that we did not fetch */
  truncated: boolean;
  /** When the account was opened: there is nothing to draw before the first account existed */
  openedAt?: string;
}

/**
 * Total end-of-day balance across the given accounts for the last `days` days (today included), rebuilt from
 * statement entries: each one carries the balance after it. When an account's history was cut off by the page
 * size, the series starts at the oldest entry we hold, so it never shows a balance we can't vouch for.
 * Returns null when fewer than two days remain.
 */
export function buildBalanceSeries(accounts: AccountHistory[], now = new Date(), days = 30): BalancePoint[] | null {
  const sortedHistories = accounts.map((a) => ({ ...a, sorted: [...a.entries].sort((x, y) => x.createdAt.localeCompare(y.createdAt)) }));
  // The first day every account's balance is known for, and the day the first account was opened
  const truncatedFrom = sortedHistories
    .filter((a) => a.truncated && a.sorted[0])
    .map((a) => midnight(new Date(a.sorted[0]!.createdAt)))
    .reduce<Date | null>((latest, d) => (!latest || d > latest ? d : latest), null);
  const openedFrom = accounts.every((a) => a.openedAt)
    ? accounts.map((a) => midnight(new Date(a.openedAt!))).reduce<Date | null>((first, d) => (!first || d < first ? d : first), null)
    : null;
  const knownFrom = truncatedFrom && openedFrom ? (truncatedFrom > openedFrom ? truncatedFrom : openedFrom) : (truncatedFrom ?? openedFrom);

  const timelines = sortedHistories.map(({ sorted, currentPaise }) => {
    const first = sorted[0];
    if (!first) return () => currentPaise ?? '0';
    const signed = BigInt(first.amountInPaise) * (first.entryType === 'CREDIT' ? 1n : -1n);
    const opening = (BigInt(first.balanceAfterInPaise) - signed).toString();
    return (end: Date): Paise => {
      let balance = opening;
      for (const entry of sorted) {
        if (new Date(entry.createdAt) >= end) break;
        balance = entry.balanceAfterInPaise;
      }
      return balance;
    };
  });

  const points: BalancePoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
    if (knownFrom && date < knownFrom) continue;
    const balancePaise = addPaise(timelines.map((at) => at(end)));
    points.push({ key: dayKey(date), label: formatShortDate(date), balancePaise, value: Number(balancePaise) / 100 });
  }
  return points.length >= 2 ? points : null;
}

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Money in and out per local day for the last `days` days (today included), from statement entries */
export function buildCashFlow(entries: AccountEntry[], now = new Date(), days = 30): CashFlow {
  const internal = internalTransactionIds(entries);
  const buckets = new Map<string, { date: Date; in: Paise[]; out: Paise[] }>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    buckets.set(dayKey(date), { date, in: [], out: [] });
  }
  for (const { entry } of entries) {
    if (internal.has(entry.transactionId)) continue;
    const bucket = buckets.get(dayKey(entry.createdAt));
    if (!bucket) continue;
    (entry.entryType === 'CREDIT' ? bucket.in : bucket.out).push(entry.amountInPaise);
  }

  const series: DayFlow[] = [...buckets.entries()].map(([key, bucket]) => {
    const inPaise = addPaise(bucket.in);
    const outPaise = addPaise(bucket.out);
    return { key, label: formatShortDate(bucket.date), inPaise, outPaise, in: Number(inPaise), out: -Number(outPaise) };
  });
  const totalIn = addPaise(series.map((d) => d.inPaise));
  const totalOut = addPaise(series.map((d) => d.outPaise));
  let busiestDay: DayFlow | null = null;
  for (const day of series) {
    if (BigInt(day.outPaise) > 0n && (!busiestDay || BigInt(day.outPaise) > BigInt(busiestDay.outPaise))) busiestDay = day;
  }
  return { days: series, totalIn, totalOut, hasActivity: totalIn !== '0' || totalOut !== '0', busiestDay };
}
