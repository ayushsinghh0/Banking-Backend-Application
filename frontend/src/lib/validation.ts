import { z } from 'zod';
import { parseRupees } from './money';

/** Mirrors the auth service's password policy so users see problems before submitting */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 10 characters', test: (v: string) => v.length >= 10 && v.length <= 128 },
  { id: 'upper', label: 'An uppercase letter', test: (v: string) => /[A-Z]/.test(v) },
  { id: 'lower', label: 'A lowercase letter', test: (v: string) => /[a-z]/.test(v) },
  { id: 'number', label: 'A number', test: (v: string) => /[0-9]/.test(v) },
] as const;

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters')
  .regex(/[A-Z]/, 'Add an uppercase letter')
  .regex(/[a-z]/, 'Add a lowercase letter')
  .regex(/[0-9]/, 'Add a number');

/** 0–4: all four required rules give 3; a long password with a symbol earns the 4th point */
export function passwordScore(value: string): number {
  if (!value) return 0;
  const passed = PASSWORD_RULES.filter((r) => r.test(value)).length;
  let score = passed === 4 ? 3 : passed >= 2 ? 1 : 0;
  if (passed === 4 && value.length >= 14 && /[^A-Za-z0-9]/.test(value)) score = 4;
  return score;
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address')
  .max(254)
  .email('Enter a valid email address');

export const totpSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const accountNumberSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{12}$/, 'Account numbers are 12 digits'));

export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+?[1-9]\d{7,14}$/, 'Enter a valid phone number, e.g. +91 98765 43210'));

/** A rupee amount typed by a person, as a paise string (validated with BigInt, never floats) */
export const rupeesSchema = (opts: { allowZero?: boolean; maxPaise?: string } = {}) =>
  z
    .string()
    .trim()
    .min(1, 'Enter an amount')
    .transform((value, ctx) => {
      const paise = parseRupees(value, { allowZero: opts.allowZero });
      if (paise === null) {
        ctx.addIssue({ code: 'custom', message: opts.allowZero ? 'Enter a valid amount' : 'Enter an amount greater than ₹0.00' });
        return z.NEVER;
      }
      if (opts.maxPaise && BigInt(paise) > BigInt(opts.maxPaise)) {
        ctx.addIssue({ code: 'custom', message: 'This amount is above the allowed limit' });
        return z.NEVER;
      }
      return paise;
    });

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Formats a 12-digit account number for reading aloud: 1001 2345 6789 */
export const formatAccountNumber = (value: string) => value.replace(/(\d{4})(?=\d)/g, '$1 ');

/** ••••6789 */
export const maskAccountNumber = (value: string) => `••••${value.slice(-4)}`;
