import { describe, expect, it } from 'vitest';
import { dayHeading, groupByDay } from './lib';

/** A local-time Date, so the tests follow the customer's own calendar day like the app does */
const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour);
const NOW = at(2026, 10, 27, 15);

describe('dayHeading', () => {
  it('says Today and Yesterday for the two most recent days', () => {
    expect(dayHeading(at(2026, 10, 27, 0), NOW)).toBe('Today');
    expect(dayHeading(at(2026, 10, 26, 23), NOW)).toBe('Yesterday');
  });

  it('names older days in this year by weekday and date', () => {
    expect(dayHeading(at(2026, 10, 20), NOW)).toBe('Tuesday, 20 October');
  });

  it('adds the year to days in another year', () => {
    expect(dayHeading(at(2025, 10, 26), NOW)).toBe('Sunday, 26 October 2025');
  });

  it('accepts ISO strings', () => {
    expect(dayHeading(at(2026, 10, 27, 9).toISOString(), NOW)).toBe('Today');
  });
});

describe('groupByDay', () => {
  const entry = (id: string, date: Date) => ({ id, createdAt: date.toISOString() });

  it('groups consecutive items by local day, keeping their order', () => {
    const items = [
      entry('a', at(2026, 10, 27, 14)),
      entry('b', at(2026, 10, 27, 9)),
      entry('c', at(2026, 10, 26, 18)),
      entry('d', at(2026, 10, 20, 8)),
    ];
    const groups = groupByDay(items, (i) => i.createdAt, NOW);
    expect(groups.map((g) => [g.heading, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Tuesday, 20 October', ['d']],
    ]);
    expect(groups.map((g) => g.key)).toEqual(['2026-10-27', '2026-10-26', '2026-10-20']);
  });

  it('returns no groups for no items', () => {
    expect(groupByDay([], () => '', NOW)).toEqual([]);
  });
});
