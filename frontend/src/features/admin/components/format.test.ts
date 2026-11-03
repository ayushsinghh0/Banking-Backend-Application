import { describe, expect, it } from 'vitest';
import { countLabel, durationSince, greeting, localDay, nameFromEmail, relativeTime, timeAgo, waitedLongerThan } from './format';

describe('nameFromEmail', () => {
  it.each([
    ['priya.nair@banksphere.local', 'Priya'],
    ['RAHUL_admin@banksphere.local', 'Rahul'],
    ['ops2+alerts@banksphere.local', 'Ops'],
    ['1234@banksphere.local', ''],
  ])('%s -> %s', (email, name) => {
    expect(nameFromEmail(email)).toBe(name);
  });
});

describe('greeting', () => {
  it('follows the time of day', () => {
    expect(greeting(new Date(2026, 9, 27, 8))).toBe('Good morning');
    expect(greeting(new Date(2026, 9, 27, 13))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 9, 27, 19))).toBe('Good evening');
  });
});

describe('countLabel', () => {
  it('shows a full page as "at least"', () => {
    expect(countLabel(0, 100)).toBe('0');
    expect(countLabel(99, 100)).toBe('99');
    expect(countLabel(100, 100)).toBe('100+');
  });
});

describe('waitedLongerThan', () => {
  it('flags a wait only once it passes the queue’s threshold', () => {
    const now = Date.UTC(2026, 9, 27, 12);
    const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    expect(waitedLongerThan(ago(14), 15, now)).toBe(false);
    expect(waitedLongerThan(ago(15), 15, now)).toBe(true);
    expect(waitedLongerThan(ago(300), 240, now)).toBe(true);
    expect(waitedLongerThan(undefined, 15, now)).toBe(false);
  });
});

describe('dates', () => {
  it('uses the local calendar day, not the UTC one', () => {
    expect(localDay(new Date(2026, 9, 27, 0, 30))).toBe('2026-10-27');
  });

  it('describes waits and deadlines in words', () => {
    const now = Date.UTC(2026, 9, 27, 12);
    expect(relativeTime(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe('2 hours ago');
    expect(relativeTime(new Date(now + 22 * 3_600_000).toISOString(), now)).toBe('in 22 hours');
    expect(durationSince(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('3 days');
  });

  it('never says a past event happens "in" the future when this device’s clock runs behind the server’s', () => {
    const now = Date.UTC(2026, 9, 27, 12);
    expect(timeAgo(new Date(now + 4_000).toISOString(), now)).toBe('just now');
    expect(timeAgo(new Date(now - 30_000).toISOString(), now)).toBe('just now');
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 minutes ago');
    expect(timeAgo(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe('2 hours ago');
  });
});
