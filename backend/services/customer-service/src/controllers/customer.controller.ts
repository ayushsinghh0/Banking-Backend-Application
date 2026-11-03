import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CustomerService } from '../services/customer.service';
import { getAuthenticatedUser, parsePagination } from '@banksphere/common';

export const MIN_CUSTOMER_AGE = 18;
export const MAX_CUSTOMER_AGE = 120;

/**
 * Legal names: NFKC-normalised (full-width letters, compatibility spaces), typographic apostrophes as ',
 * runs of spaces collapsed. Only letters, combining marks, spaces and . ' - remain allowed, so no digits,
 * symbols, control, zero-width or bidi-override characters can reach KYC review or statements.
 */
const fullNameSchema = z
  .string()
  .transform((value) => value.normalize('NFKC').replace(/’/g, "'").replace(/ {2,}/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(2)
      .max(100)
      .regex(/^[\p{L}\p{M} .'-]+$/u, { message: "Names may only contain letters, spaces and . ' -" })
      .regex(/\p{L}/u, { message: 'Names must contain letters' })
  );

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date (Date would silently roll 2001-02-30 over to March) */
function parseCalendarDate(value: string): Date | null {
  if (!DATE_ONLY.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? date : null;
}

/** Completed years between `dob` and `now` (UTC) */
function ageInYears(dob: Date, now: Date): number {
  const age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

/** YYYY-MM-DD or a full ISO 8601 date-time, for someone aged 18-120 today; stored as a Date, as before */
const dateOfBirthSchema = z.string().transform((value, ctx) => {
  const date = DATE_ONLY.test(value)
    ? parseCalendarDate(value)
    : z.string().datetime({ offset: true }).safeParse(value).success && parseCalendarDate(value.slice(0, 10))
      ? new Date(value)
      : null;
  if (!date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a date (YYYY-MM-DD) or an ISO 8601 date-time' });
    return z.NEVER;
  }
  const age = ageInYears(date, new Date());
  if (age < MIN_CUSTOMER_AGE || age > MAX_CUSTOMER_AGE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Customers must be between ${MIN_CUSTOMER_AGE} and ${MAX_CUSTOMER_AGE} years old`,
    });
    return z.NEVER;
  }
  return date;
});

/** Trimmed; a blank address means "not given" */
const addressSchema = z
  .string()
  .trim()
  .max(255)
  .transform((value) => value || undefined);

const createProfileSchema = z.object({
  fullName: fullNameSchema,
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/, { message: 'Invalid phone number format' }),
  address: addressSchema.optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
});

const updateProfileSchema = z.object({
  fullName: fullNameSchema.optional(),
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  address: addressSchema.optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
});

const userIdParamsSchema = z.object({ userId: z.string().uuid() });

const listQuerySchema = z.object({
  kycStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional(),
  q: z
    .string()
    .trim()
    .max(100)
    .transform((value) => value || undefined)
    .optional(),
});

const kycSchema = z
  .object({ kycStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED']), expectedVersion: z.number().int().positive() })
  .strict();

export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  /**
   * Identity comes only from the verified access token (see authenticate middleware)
   */
  private getAuthenticatedUserId(req: Request): string {
    return getAuthenticatedUser(req).id;
  }

  public getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = this.getAuthenticatedUserId(req);
      const { profile, fromCache } = await this.customerService.getProfileByUserId(userId);

      res.setHeader('X-Cache-Lookup', fromCache ? 'HIT' : 'MISS');
      res.status(200).json({
        success: true,
        data: profile,
      });
    } catch (error) {
      next(error);
    }
  };

  public createMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = this.getAuthenticatedUserId(req);
      const validated = createProfileSchema.parse(req.body);

      const profile = await this.customerService.createProfile({
        userId,
        fullName: validated.fullName,
        phoneNumber: validated.phoneNumber,
        address: validated.address,
        dateOfBirth: validated.dateOfBirth,
      });

      res.status(201).json({
        success: true,
        data: profile,
      });
    } catch (error) {
      next(error);
    }
  };

  public updateMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = this.getAuthenticatedUserId(req);
      const validated = updateProfileSchema.parse(req.body);

      const updated = await this.customerService.updateProfile(userId, validated);

      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };

  /** Staff search (see routes for roles); ?kycStatus=PENDING is the KYC review queue, oldest first */
  public list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { kycStatus, q } = listQuerySchema.parse(req.query);
      const pagination = parsePagination(req.query);
      const profiles = await this.customerService.listProfilesForStaff(getAuthenticatedUser(req), { kycStatus, q }, pagination);
      res.status(200).json({ success: true, data: profiles, pagination });
    } catch (error) {
      next(error);
    }
  };

  public getByUserId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = userIdParamsSchema.parse(req.params);
      const profile = await this.customerService.getProfileForStaff(getAuthenticatedUser(req), userId);
      res.status(200).json({ success: true, data: profile });
    } catch (error) {
      next(error);
    }
  };

  public updateKycStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = userIdParamsSchema.parse(req.params);
      const { kycStatus, expectedVersion } = kycSchema.parse(req.body);
      const profile = await this.customerService.updateKycStatus(getAuthenticatedUser(req), userId, kycStatus, expectedVersion);
      res.status(200).json({ success: true, data: profile });
    } catch (error) {
      next(error);
    }
  };

  public getKycHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = userIdParamsSchema.parse(req.params);
      const events = await this.customerService.getKycHistory(getAuthenticatedUser(req), userId);
      res.status(200).json({ success: true, data: events });
    } catch (error) {
      next(error);
    }
  };
}
