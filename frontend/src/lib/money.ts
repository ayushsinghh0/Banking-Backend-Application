/**
 * Money is integer paise carried as decimal strings, exactly as the API sends and expects it.
 * All arithmetic uses BigInt; floating point is only used to abbreviate chart axis labels.
 */

const PAISE_PATTERN = /^-?\d+$/;
/** The backend accepts at most 18 digits of paise (well inside a Postgres BIGINT) */
const MAX_PAISE_DIGITS = 18;
const integerFormatter = new Intl.NumberFormat('en-IN');

export type Paise = string;

export interface FormatOptions {
  /** 'always' prefixes credits with "+"; 'auto' (default) only shows "-" for negatives */
  sign?: 'auto' | 'always';
  /** Include the rupee symbol (default true) */
  symbol?: boolean;
}

function toBigInt(value: string | bigint | null | undefined): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !PAISE_PATTERN.test(value)) return null;
  return BigInt(value);
}

/** "123456789" -> "₹12,34,567.89" */
export function formatPaise(value: string | bigint | null | undefined, options: FormatOptions = {}): string {
  const amount = toBigInt(value);
  if (amount === null) return '—';
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const rupees = integerFormatter.format(abs / 100n);
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const sign = negative ? '-' : options.sign === 'always' && abs > 0n ? '+' : '';
  return `${sign}${options.symbol === false ? '' : '₹'}${rupees}.${fraction}`;
}

export interface ParseOptions {
  /** Blind cash counts may legitimately be zero */
  allowZero?: boolean;
}

/**
 * Parses what a person types ("1,00,000.5", "₹ 499") into paise. Returns null for anything that is not a
 * plain non-negative amount with at most two decimals, so the caller can show a validation message.
 */
export function parseRupees(input: string, options: ParseOptions = {}): Paise | null {
  const cleaned = input.trim().replace(/^₹\s*/, '');
  if (!/^(\d{1,3}(,\d{2,3})*|\d+)(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.replace(/,/g, '').split('.');
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (paise === 0n && !options.allowZero) return null;
  const text = paise.toString();
  if (text.length > MAX_PAISE_DIGITS) return null;
  return text;
}

/** "150" -> "1.50" (for pre-filling an amount field) */
export function paiseToInput(value: Paise): string {
  const amount = toBigInt(value) ?? 0n;
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export function addPaise(values: Paise[]): Paise {
  return values.reduce((sum, v) => sum + (toBigInt(v) ?? 0n), 0n).toString();
}

export function comparePaise(a: Paise, b: Paise): -1 | 0 | 1 {
  const x = toBigInt(a) ?? 0n;
  const y = toBigInt(b) ?? 0n;
  return x === y ? 0 : x > y ? 1 : -1;
}

export function isPositivePaise(value: string): boolean {
  const amount = toBigInt(value);
  return amount !== null && amount > 0n;
}

/** Axis labels only: "15000000" -> "₹1.5L" (Indian lakh/crore) */
export function compactRupees(value: Paise): string {
  const amount = toBigInt(value) ?? 0n;
  const negative = amount < 0n;
  const rupees = Number(negative ? -amount : amount) / 100;
  const units: Array<[number, string]> = [
    [1e7, 'Cr'],
    [1e5, 'L'],
    [1e3, 'K'],
  ];
  let text = `₹${Math.round(rupees)}`;
  for (const [size, suffix] of units) {
    if (rupees >= size) {
      text = `₹${Number((rupees / size).toFixed(1))}${suffix}`;
      break;
    }
  }
  return negative ? `-${text}` : text;
}
