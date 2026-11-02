import { formatInr, istDate, parseAmountToPaise } from '../src/util/money';
import { cleanText, last4, maskDigits } from '../src/util/masking';

describe('formatInr', () => {
  it.each([
    ['0', '₹0.00'],
    ['5', '₹0.05'],
    ['100', '₹1.00'],
    ['123456', '₹1,234.56'],
    ['12345678', '₹1,23,456.78'],
    ['1234567890', '₹1,23,45,678.90'],
    ['-50000', '-₹500.00'],
    [123456789012345678n, '₹1,23,45,67,89,01,23,456.78'],
  ])('formats %s paise as %s in Indian grouping', (paise, expected) => {
    expect(formatInr(paise)).toBe(expected);
  });

  it('refuses values that are not whole paise', () => {
    expect(formatInr('12.5')).toBe('an unknown amount');
    expect(formatInr('abc')).toBe('an unknown amount');
  });
});

describe('parseAmountToPaise', () => {
  it.each([
    ['500', 50_000n],
    ['₹500', 50_000n],
    ['Rs. 1,500', 150_000n],
    ['1,23,456.78', 12_345_678n],
    ['250.5', 25_050n],
    ['5k', 500_000n],
    ['1.5k', 150_000n],
    ['2 lakh', 20_000_000n],
    ['1 lac', 10_000_000n],
    [750, 75_000n],
    [12.34, 1_234n],
  ])('reads %s as %s paise', (input, expected) => {
    expect(parseAmountToPaise(input)).toBe(expected);
  });

  it.each(['0', '-5', '1.234', 'lots', '', '1e9', '99999999999999'])('rejects %s', (input) => {
    expect(parseAmountToPaise(input)).toBeNull();
  });
});

describe('istDate', () => {
  it('uses the India Standard Time calendar day', () => {
    expect(istDate(new Date('2026-10-27T18:29:59Z'))).toBe('2026-10-27');
    expect(istDate(new Date('2026-10-27T18:30:00Z'))).toBe('2026-10-28');
  });
});

describe('masking', () => {
  it('keeps only the last four digits of account numbers', () => {
    expect(last4('200000001234')).toBe('1234');
    expect(last4('12')).toBe('12');
    expect(last4(undefined)).toBe('');
  });

  it('masks long digit runs in free text (account numbers, phone numbers, cards)', () => {
    expect(maskDigits('Transfer to account 200000004321')).toBe('Transfer to account ••4321');
    expect(maskDigits('Call 98765 43210 or 4111-1111-1111-1111')).toBe('Call ••3210 or ••1111');
    expect(maskDigits('Rent for flat 12, ₹15000')).toBe('Rent for flat 12, ₹15000');
  });

  it('cleans control characters and bounds length', () => {
    expect(cleanText('a\u0000b\n\nc\t d', 50)).toBe('ab c d');
    expect(cleanText('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
    expect(cleanText(undefined, 10)).toBe('');
  });
});
