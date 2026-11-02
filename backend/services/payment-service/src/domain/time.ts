const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the India Standard Time calendar day containing `now`, as a UTC instant (daily caps reset here) */
export function startOfIstDay(now: Date): Date {
  const istMs = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(istMs / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/** IST calendar date, YYYY-MM-DD */
export function istDate(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant at which the IST calendar day `yyyyMmDd` starts; null if it isn't a real date */
export function istDayStart(yyyyMmDd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return null;
  const utcMidnight = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  if (Number.isNaN(utcMidnight.getTime()) || utcMidnight.toISOString().slice(0, 10) !== yyyyMmDd) return null;
  return new Date(utcMidnight.getTime() - IST_OFFSET_MS);
}

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);
export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
