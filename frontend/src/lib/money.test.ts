import { describe, expect, it } from 'vitest';
import {
  addPaise,
  compactRupees,
  formatPaise,
  isPositivePaise,
  paiseToInput,
  parseRupees,
  comparePaise,
} from './money';

describe('formatPaise', () => {
  it('formats with Indian digit grouping and two decimals', () => {
    expect(formatPaise('10000000')).toBe('₹1,00,000.00');
    expect(formatPaise('123456789')).toBe('₹12,34,567.89');
    expect(formatPaise('5')).toBe('₹0.05');
    expect(formatPaise('0')).toBe('₹0.00');
  });

  it('is exact for amounts beyond Number.MAX_SAFE_INTEGER', () => {
    expect(formatPaise('999999999999999999')).toBe('₹9,99,99,99,99,99,99,999.99');
  });

  it('accepts bigint input and negative values', () => {
    expect(formatPaise(-150n)).toBe('-₹1.50');
  });

  it('can force a sign for credits and debits', () => {
    expect(formatPaise('2500', { sign: 'always' })).toBe('+₹25.00');
    expect(formatPaise('-2500', { sign: 'always' })).toBe('-₹25.00');
    expect(formatPaise('0', { sign: 'always' })).toBe('₹0.00');
  });

  it('can omit the currency symbol', () => {
    expect(formatPaise('100050', { symbol: false })).toBe('1,000.50');
  });

  it('renders an em dash for missing or malformed values instead of throwing', () => {
    expect(formatPaise(undefined)).toBe('—');
    expect(formatPaise(null)).toBe('—');
    expect(formatPaise('12.5')).toBe('—');
  });
});

describe('parseRupees', () => {
  it.each([
    ['1', '100'],
    ['1.5', '150'],
    ['1.05', '105'],
    ['0.01', '1'],
    ['1,00,000', '10000000'],
    ['  2,500.75 ', '250075'],
    ['₹ 499', '49900'],
    ['007.10', '710'],
  ])('parses %s as %s paise', (input, expected) => {
    expect(parseRupees(input)).toBe(expected);
  });

  it.each(['', ' ', 'abc', '1.234', '-5', '1e5', '1..2', '.', '0', '0.00', '1,2,3.4.5', 'NaN'])(
    'rejects %j',
    (input) => {
      expect(parseRupees(input)).toBeNull();
    }
  );

  it('rejects amounts above the 18-digit backend limit', () => {
    expect(parseRupees('99999999999999999')).toBeNull(); // 19 digits of paise
    expect(parseRupees('9999999999999999.99')).toBe('999999999999999999');
  });

  it('can allow zero for blind cash counts', () => {
    expect(parseRupees('0', { allowZero: true })).toBe('0');
    expect(parseRupees('0.00', { allowZero: true })).toBe('0');
  });
});

describe('helpers', () => {
  it('converts paise back to an editable rupee string', () => {
    expect(paiseToInput('150')).toBe('1.50');
    expect(paiseToInput('100000')).toBe('1000.00');
    expect(paiseToInput('7')).toBe('0.07');
  });

  it('adds and compares exactly', () => {
    expect(addPaise(['999999999999999990', '9'])).toBe('999999999999999999');
    expect(comparePaise('100', '99')).toBe(1);
    expect(comparePaise('99', '100')).toBe(-1);
    expect(comparePaise('100', '100')).toBe(0);
  });

  it('knows a positive amount', () => {
    expect(isPositivePaise('1')).toBe(true);
    expect(isPositivePaise('0')).toBe(false);
    expect(isPositivePaise('-1')).toBe(false);
    expect(isPositivePaise('x')).toBe(false);
  });

  it('abbreviates large values for chart axes', () => {
    expect(compactRupees('0')).toBe('₹0');
    expect(compactRupees('99900')).toBe('₹999');
    expect(compactRupees('250000')).toBe('₹2.5K');
    expect(compactRupees('15000000')).toBe('₹1.5L');
    expect(compactRupees('2500000000')).toBe('₹2.5Cr');
    expect(compactRupees('-15000000')).toBe('-₹1.5L');
  });
});
