import { z } from 'zod';
import { phoneSchema } from '@/lib/validation';

/**
 * Client-side copy of the customer service's profile rules (customer.controller.ts), so people see a problem
 * before submitting. The server stays the authority and its field errors are shown as well.
 */
export const MIN_CUSTOMER_AGE = 18;
export const MAX_CUSTOMER_AGE = 120;

/** The same normalisation the bank applies: NFKC, typographic apostrophes as ', single spaces, trimmed */
export const normaliseName = (value: string) => value.normalize('NFKC').replace(/’/g, "'").replace(/ {2,}/g, ' ').trim();

const fullNameSchema = z
  .string()
  .transform(normaliseName)
  .pipe(
    z
      .string()
      .min(2, 'Enter your full name, as it appears on your ID')
      .max(100, 'Use 100 characters or fewer')
      .regex(/^[\p{L}\p{M} .'-]*$/u, "Names may only contain letters, spaces and . ' -")
      .regex(/\p{L}/u, 'Names must contain letters')
  );

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in UTC (rejects 2001-02-30 rather than rolling it over) */
export function parseCalendarDate(value: string): Date | null {
  if (!DATE_ONLY.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? date : null;
}

/** Completed years between `dob` and `now`, the way the bank counts them (UTC) */
export function ageInYears(dob: Date, now = new Date()): number {
  const age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

const dateOfBirthSchema = (required: boolean) =>
  z.string().superRefine((value, ctx) => {
    if (!value) {
      if (required) ctx.addIssue({ code: 'custom', message: 'Enter your date of birth' });
      return;
    }
    const date = parseCalendarDate(value);
    const now = new Date();
    if (!date) {
      ctx.addIssue({ code: 'custom', message: 'Enter a real date, for example 12 April 1992' });
    } else if (date.getTime() > now.getTime()) {
      ctx.addIssue({ code: 'custom', message: 'The date of birth can’t be in the future' });
    } else if (ageInYears(date, now) < MIN_CUSTOMER_AGE) {
      ctx.addIssue({ code: 'custom', message: `You must be at least ${MIN_CUSTOMER_AGE} to bank with us` });
    } else if (ageInYears(date, now) > MAX_CUSTOMER_AGE) {
      ctx.addIssue({ code: 'custom', message: `Check the year: the date of birth must be within the last ${MAX_CUSTOMER_AGE} years` });
    }
  });

export interface ProfileRules {
  /** Date of birth is required (always for a new profile; for an existing one only if it already has one) */
  requireDateOfBirth: boolean;
  /** The bank treats a blank address as "not given", so an existing address can be changed but not removed */
  keepAddress: boolean;
}

export const profileSchema = ({ requireDateOfBirth, keepAddress }: ProfileRules) =>
  z.object({
    fullName: fullNameSchema,
    phoneNumber: z.string().trim().min(1, 'Enter your mobile number').pipe(phoneSchema),
    dateOfBirth: dateOfBirthSchema(requireDateOfBirth),
    address: z
      .string()
      .max(255, 'Use 255 characters or fewer')
      .refine((value) => !keepAddress || value.trim().length > 0, {
        message: 'You can change your address, but not remove it. Contact the bank if it needs to be removed.',
      }),
  });

export type ProfileFormInput = z.input<ReturnType<typeof profileSchema>>;
export type ProfileFormValues = z.output<ReturnType<typeof profileSchema>>;

/** What the date input expects: "1992-04-12" */
export const toDateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/** What the bank expects: "1992-04-12T00:00:00.000Z" */
export const toApiDate = (date: string) => `${date}T00:00:00.000Z`;
