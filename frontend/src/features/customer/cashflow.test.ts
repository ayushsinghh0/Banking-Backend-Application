import { describe, expect, it } from 'vitest';
import { anEntry } from '@/test/fixtures';
import { buildBalanceSeries } from './cashflow';

const NOW = new Date(2026, 9, 27, 15, 0, 0);
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour, 0, 0).toISOString();

describe('buildBalanceSeries', () => {
  it('rebuilds the end-of-day balance from the balance after each entry', () => {
    const entries = [
      anEntry({ entryId: 'a', entryType: 'CREDIT', amountInPaise: '100000', balanceAfterInPaise: '100000', createdAt: at(20) }),
      anEntry({ entryId: 'b', entryType: 'DEBIT', amountInPaise: '25000', balanceAfterInPaise: '75000', createdAt: at(24) }),
      anEntry({ entryId: 'c', entryType: 'CREDIT', amountInPaise: '5000', balanceAfterInPaise: '80000', createdAt: at(24, 18) }),
    ];
    const series = buildBalanceSeries([{ entries, currentPaise: '80000', truncated: false }], NOW, 10)!;
    expect(series).toHaveLength(10);
    const byLabel = Object.fromEntries(series.map((p) => [p.key, p.balancePaise]));
    // Before the first entry the balance was the first balance minus that credit
    expect(byLabel['2026-10-18']).toBe('0');
    expect(byLabel['2026-10-20']).toBe('100000');
    expect(byLabel['2026-10-23']).toBe('100000');
    // The last entry of the day wins
    expect(byLabel['2026-10-24']).toBe('80000');
    expect(byLabel['2026-10-27']).toBe('80000');
    expect(series.at(-1)!.value).toBe(800);
  });

  it('adds accounts together, and an account without entries holds its current balance', () => {
    const series = buildBalanceSeries(
      [
        { entries: [anEntry({ entryType: 'CREDIT', amountInPaise: '500', balanceAfterInPaise: '1500', createdAt: at(26) })], currentPaise: '1500', truncated: false },
        { entries: [], currentPaise: '999999999999999999', truncated: false },
      ],
      NOW,
      3
    )!;
    expect(series.map((p) => p.balancePaise)).toEqual(['1000000000000000999', '1000000000000001499', '1000000000000001499']);
  });

  it('starts at the oldest fetched entry when the history was cut off by the page size', () => {
    const entries = [anEntry({ entryType: 'DEBIT', amountInPaise: '100', balanceAfterInPaise: '900', createdAt: at(25) })];
    const series = buildBalanceSeries([{ entries, currentPaise: '900', truncated: true }], NOW, 30)!;
    expect(series.map((p) => p.key)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(series[0]!.balancePaise).toBe('900');
  });

  it('starts on the day the first account was opened', () => {
    const series = buildBalanceSeries(
      [
        { entries: [], currentPaise: '100', truncated: false, openedAt: at(24, 9) },
        { entries: [], currentPaise: '200', truncated: false, openedAt: at(26, 9) },
      ],
      NOW,
      30
    )!;
    expect(series.map((p) => p.key)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  });

  it('returns null when there are not two days to draw', () => {
    const entries = [anEntry({ createdAt: at(27, 9) })];
    expect(buildBalanceSeries([{ entries, currentPaise: '1', truncated: true }], NOW, 30)).toBeNull();
    expect(buildBalanceSeries([], NOW, 1)).toBeNull();
  });
});
