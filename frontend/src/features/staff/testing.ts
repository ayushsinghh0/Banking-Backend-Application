import { toast } from 'sonner';
import type { Role } from '@/lib/auth/session';

/** Staff identities for page tests (the token's `sub` is who the API thinks is acting) */
export const STAFF = {
  kycOfficer: '66666666-6666-4666-8666-666666666666',
  kycOfficer2: '67676767-6767-4767-8767-676767676767',
  analyst: '77777777-7777-4777-8777-777777777777',
  analyst2: '78787878-7878-4878-8878-787878787878',
  support: '88888888-8888-4888-8888-888888888888',
  admin: '44444444-4444-4444-8444-444444444444',
  teller: '33333333-3333-4333-8333-333333333333',
} as const;

const SUB: Record<Exclude<Role, 'CUSTOMER'>, string> = {
  KYC_OFFICER: STAFF.kycOfficer,
  FRAUD_ANALYST: STAFF.analyst,
  SUPPORT: STAFF.support,
  BANK_ADMIN: STAFF.admin,
  TELLER: STAFF.teller,
};

/** renderWithApp options for a signed-in staff member */
export const asStaff = (role: Exclude<Role, 'CUSTOMER'>, sub: string = SUB[role]) => ({
  role,
  claims: { sub, email: `${role.toLowerCase()}@banksphere.local`, mfa: true },
});

/** The query string of an intercepted request, as a plain object */
export const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams.entries());

/**
 * Sonner keeps toasts in a module-level store and replays active ones to the next Toaster, so a toast from
 * one test would show up in the next. Call after each test.
 */
export const resetToasts = () => {
  toast.dismiss();
};
