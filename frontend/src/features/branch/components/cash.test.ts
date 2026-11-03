import { describe, expect, it } from 'vitest';
import { describeDiscrepancy, formatTimeOnDay } from './cash';

describe('formatTimeOnDay', () => {
  it('shows only the IST time on the business day itself', () => {
    // 09:14 UTC is 2:44 pm in India
    expect(formatTimeOnDay('2026-10-27T09:14:00.000Z', '2026-10-27')).toBe('2:44 pm');
  });

  it('adds the date when the time falls on another day', () => {
    // 21:00 UTC on the 27th is already 2:30 am on the 28th in India
    expect(formatTimeOnDay('2026-10-27T21:00:00.000Z', '2026-10-27')).toBe('28 Oct, 2:30 am');
  });

  it('copes with missing or broken timestamps', () => {
    expect(formatTimeOnDay(null, '2026-10-27')).toBe('—');
    expect(formatTimeOnDay('not a date', '2026-10-27')).toBe('—');
  });
});

describe('describeDiscrepancy', () => {
  it('says balanced, short or over in words', () => {
    expect(describeDiscrepancy('0')).toEqual({ label: 'Balanced', tone: 'success' });
    expect(describeDiscrepancy('-20000')).toEqual({ label: 'Short by ₹200.00', tone: 'danger' });
    expect(describeDiscrepancy('15000')).toEqual({ label: 'Over by ₹150.00', tone: 'warning' });
    expect(describeDiscrepancy(null)).toBeNull();
  });
});
