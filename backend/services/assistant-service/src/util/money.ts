/**
 * Money is always integer paise (BigInt or a digit string), never a float. Amounts shown to customers use the
 * Indian numbering system: ₹1,23,456.78.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Largest amount the assistant will read from a message (₹1,000 crore): anything above is a typo */
const MAX_PARSED_PAISE = 100_000_000_000n;

function toBigInt(paise: bigint | string | number): bigint | null {
  if (typeof paise === 'bigint') return paise;
  if (typeof paise === 'number') return Number.isSafeInteger(paise) ? BigInt(paise) : null;
  return /^-?\d{1,19}$/.test(paise) ? BigInt(paise) : null;
}

/** Groups the integer part the Indian way: last three digits, then pairs (12,34,567) */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

export function formatInr(paise: bigint | string | number): string {
  const value = toBigInt(paise);
  if (value === null) return 'an unknown amount';
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = groupIndian((abs / 100n).toString());
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}₹${rupees}.${fraction}`;
}

const MULTIPLIERS: Record<string, bigint> = {
  k: 1_000n,
  thousand: 1_000n,
  hazaar: 1_000n,
  hazar: 1_000n,
  l: 100_000n,
  lakh: 100_000n,
  lakhs: 100_000n,
  lac: 100_000n,
  lacs: 100_000n,
  cr: 10_000_000n,
  crore: 10_000_000n,
  crores: 10_000_000n,
};

/**
 * Reads an amount in rupees as people type it ("500", "₹1,500", "Rs. 2,50,000.50", "5k", "2 lakh") and returns
 * paise, or null when it isn't a positive amount with at most two decimals.
 */
export function parseAmountToPaise(input: string | number): bigint | null {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null;
    text = String(input);
    if (/e/i.test(text)) return null;
  } else {
    text = input;
  }
  const normalized = text
    .toLowerCase()
    .replace(/₹|\brs\.?|\binr\b|rupees?|rupaye|rupay|\/-/g, ' ')
    .replace(/,/g, '')
    .trim();
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?\s*([a-z]+)?$/.exec(normalized);
  if (!match) return null;
  const [, whole, fraction = '', unit] = match;
  const multiplier = unit ? MULTIPLIERS[unit] : 1n;
  if (multiplier === undefined) return null;
  const hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const paise = hundredths * multiplier;
  if (paise <= 0n || paise > MAX_PARSED_PAISE) return null;
  return paise;
}

/** Calendar day in India Standard Time (where daily limits reset), as YYYY-MM-DD */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
