import { describe, expect, it } from 'vitest';
import {
  accountNumberSchema,
  emailSchema,
  formatAccountNumber,
  maskAccountNumber,
  passwordSchema,
  passwordScore,
  phoneSchema,
  rupeesSchema,
  totpSchema,
  UUID_PATTERN,
} from './validation';

describe('passwordSchema mirrors the backend policy', () => {
  it.each(['Short1A', 'alllowercase1', 'ALLUPPERCASE1', 'NoDigitsHere', 'x'.repeat(129) + 'A1'])('rejects %j', (pw) => {
    expect(passwordSchema.safeParse(pw).success).toBe(false);
  });
  it('accepts a compliant password', () => {
    expect(passwordSchema.safeParse('Correct-Horse-9').success).toBe(true);
  });
});

describe('passwordScore', () => {
  it('scores from 0 to 4', () => {
    expect(passwordScore('')).toBe(0);
    expect(passwordScore('abc')).toBe(0);
    expect(passwordScore('abcdefghiJ')).toBe(1);
    expect(passwordScore('Abcdefghi1')).toBe(3);
    expect(passwordScore('Abcdefghijk1!z')).toBe(4);
  });
});

describe('field schemas', () => {
  it('normalises emails', () => {
    expect(emailSchema.parse('  A@B.in ')).toBe('a@b.in');
    expect(emailSchema.safeParse('nope').success).toBe(false);
  });

  it('accepts only 6-digit codes', () => {
    expect(totpSchema.safeParse('123456').success).toBe(true);
    expect(totpSchema.safeParse('12345').success).toBe(false);
    expect(totpSchema.safeParse('12345a').success).toBe(false);
  });

  it('accepts spaced account numbers and strips the spaces', () => {
    expect(accountNumberSchema.parse('1001 2345 6789')).toBe('100123456789');
    expect(accountNumberSchema.safeParse('12345').success).toBe(false);
  });

  it('accepts Indian phone formats', () => {
    expect(phoneSchema.parse('+91 98765-43210')).toBe('+919876543210');
    expect(phoneSchema.safeParse('0123').success).toBe(false);
  });

  it('turns rupees into paise and enforces limits', () => {
    expect(rupeesSchema().parse('1,000.50')).toBe('100050');
    expect(rupeesSchema().safeParse('0').success).toBe(false);
    expect(rupeesSchema({ allowZero: true }).parse('0')).toBe('0');
    expect(rupeesSchema({ maxPaise: '10000' }).safeParse('100.01').success).toBe(false);
    expect(rupeesSchema({ maxPaise: '10000' }).parse('100')).toBe('10000');
    expect(rupeesSchema().safeParse('').success).toBe(false);
  });
});

describe('display helpers', () => {
  it('groups and masks account numbers', () => {
    expect(formatAccountNumber('100123456789')).toBe('1001 2345 6789');
    expect(maskAccountNumber('100123456789')).toBe('••••6789');
  });

  it('recognises UUIDs', () => {
    expect(UUID_PATTERN.test('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(UUID_PATTERN.test('not-a-uuid')).toBe(false);
  });
});
