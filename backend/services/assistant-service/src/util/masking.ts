/**
 * Data minimisation for everything a tool hands to the model or a card: identifiers are reduced to their last
 * four digits and free text is cleaned and bounded, so neither the model provider nor a prompt-injected answer
 * ever sees a full account, phone or card number.
 */

/** Last four digits of an identifier ("200000001234" -> "1234") */
export function last4(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.slice(-4);
}

// Eight or more digits, optionally grouped by spaces or dashes: account, phone, card and UPI reference numbers.
// Amounts as people write them (₹15,000, 2500) stay readable.
const LONG_NUMBER = /\d(?:[ -]?\d){7,}/g;

export function maskDigits(text: string): string {
  return text.replace(LONG_NUMBER, (match) => `••${last4(match)}`);
}

// Control characters (except whitespace) and bidirectional overrides, which can hide or reorder text
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

/** Single-line, bounded, without control characters */
export function cleanText(value: string | null | undefined, max: number): string {
  const text = String(value ?? '')
    .replace(UNSAFE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Free text from another service, safe to show and to give to the model */
export function safeDescription(value: string | null | undefined, max = 80): string {
  // Clean before masking (a control character between digits must not hide a number), truncate after
  return cleanText(maskDigits(cleanText(value, 4_000)), max);
}
