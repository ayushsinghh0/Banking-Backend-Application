export interface ApiErrorInit {
  status: number;
  code: string;
  message: string;
  correlationId?: string;
  details?: Array<{ field: string; message: string }>;
  retryAfterSeconds?: number;
}

const RETRYABLE_CODES = new Set(['SERVICE_BUSY', 'SERVICE_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT']);

/** An error response from the BankSphere API (or a transport failure, with status 0) */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string;
  readonly details: Array<{ field: string; message: string }>;
  readonly retryAfterSeconds?: number;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.correlationId = init.correlationId;
    this.details = init.details ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** First message per field, for showing next to form inputs */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details) out[d.field] ??= d.message;
    return out;
  }

  /** Nothing was committed: the same request (with the same Idempotency-Key) is safe to send again */
  get isRetryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  get requiresStepUp(): boolean {
    return this.code === 'STEP_UP_REQUIRED';
  }
}

export const isApiError = (value: unknown): value is ApiError => value instanceof ApiError;

export interface ErrorDescription {
  title: string;
  description: string;
  /** Correlation id to quote to support, shown for unexpected failures */
  reference?: string;
}

const CATALOG: Record<string, { title: string; description?: string }> = {
  VALIDATION_ERROR: { title: 'Check the highlighted fields', description: 'Some of the details entered are not valid.' },
  MALFORMED_JSON: { title: 'Request could not be read', description: 'Please refresh the page and try again.' },
  UNAUTHORIZED: { title: 'Signed out', description: 'Your session has ended. Please sign in again.' },
  FORBIDDEN: { title: 'Not allowed', description: 'This action isn’t permitted for you on this item.' },
  NOT_FOUND: { title: 'Not found', description: 'It may have been removed, or you may not have access to it.' },
  NETWORK_ERROR: { title: 'You appear to be offline', description: 'Check your connection and try again. Nothing was submitted twice.' },
  TIMEOUT: { title: 'The request took too long', description: 'It is safe to try again; repeated money transfers are never processed twice.' },
  SERVICE_BUSY: { title: 'Busy right now', description: 'Nothing was processed. Please try again in a moment.' },
  SERVICE_UNAVAILABLE: { title: 'Temporarily unavailable', description: 'Nothing was processed. Please try again shortly.' },
  BAD_GATEWAY: { title: 'Service unavailable', description: 'A banking service did not respond. Please try again shortly.' },
  GATEWAY_TIMEOUT: { title: 'Service did not respond in time', description: 'Please check your activity before retrying.' },
  INTERNAL_SERVER_ERROR: { title: 'Something went wrong on our side', description: 'Please try again. If it keeps happening, contact support with the reference below.' },
  RATE_LIMIT_EXCEEDED: { title: 'Too many attempts', description: 'Please wait a little before trying again.' },
  NETWORK_NOT_ALLOWED: { title: 'Staff network required', description: 'This action is only available from the bank’s staff network or VPN.' },
  // Authentication
  EMAIL_NOT_VERIFIED: { title: 'Verify your email first', description: 'Open the verification link we emailed you, or request a new one.' },
  LOGIN_STEP_UP_REQUIRED: { title: 'Account protected', description: 'There were too many failed sign-in attempts. Reset your password by email to continue.' },
  INVALID_OR_EXPIRED_TOKEN: { title: 'Link expired or already used', description: 'Request a new link and use the most recent email.' },
  INVALID_MFA_CODE: { title: 'Incorrect code', description: 'Enter the current 6-digit code from your authenticator app.' },
  INVALID_PASSWORD: { title: 'Incorrect password', description: 'Check your password and try again.' },
  MFA_TEMPORARILY_LOCKED: { title: 'Verification paused', description: 'Too many incorrect codes. Please try again later.' },
  MFA_REQUIRED: { title: 'Two-factor authentication required', description: 'Sign in with your authenticator to continue.' },
  MFA_SETUP_REQUIRED: { title: 'Start setup first', description: 'Generate a new authenticator key, then enter its code.' },
  ENROLMENT_TOKEN_REQUIRED: { title: 'Enrolment link required', description: 'Staff must enrol their authenticator from the one-time link sent to them.' },
  STEP_UP_REQUIRED: { title: 'Confirm it’s you', description: 'This action needs a fresh code from your authenticator.' },
  REFRESH_IN_PROGRESS: { title: 'Session refreshing', description: 'Please try again.' },
  PASSWORD_REUSED: { title: 'Choose a new password', description: 'The new password must be different from the current one.' },
  STAFF_EMAIL_DOMAIN: { title: 'Corporate email required', description: 'Staff accounts must use the bank’s email domain.' },
  INVALID_ROLE: { title: 'Invalid role' },
  APPROVAL_REQUIRED: { title: 'Second approval required', description: 'Another administrator must approve this change.' },
  // Money movement
  INSUFFICIENT_FUNDS: { title: 'Not enough balance', description: 'The amount is more than the available balance on this account.' },
  DAILY_LIMIT_EXCEEDED: { title: 'Daily limit reached', description: 'This would exceed today’s outflow limit. Lower the amount or try tomorrow.' },
  INVALID_AMOUNT: { title: 'Invalid amount', description: 'Enter an amount greater than zero.' },
  SAME_ACCOUNT_TRANSFER: { title: 'Same account', description: 'Choose a different destination account.' },
  ACCOUNT_INACTIVE: { title: 'Account unavailable', description: 'One of the accounts is frozen or closed.' },
  CURRENCY_MISMATCH: { title: 'Currency mismatch', description: 'Both accounts must use the same currency.' },
  BENEFICIARY_REQUIRED: { title: 'Add this payee first', description: 'Transfers to other people’s accounts need a registered payee.' },
  BENEFICIARY_COOLING_OFF: { title: 'Payee not active yet', description: 'New payees become active after a short cooling-off period, for your security.' },
  NEW_BENEFICIARY_LIMIT: { title: 'New payee limit', description: 'Transfers to a newly added payee are capped for the first day.' },
  INVALID_DESTINATION: { title: 'Account can’t receive payments', description: 'Check the account number with the recipient.' },
  OWN_ACCOUNT: { title: 'That’s your own account', description: 'You can transfer to your own accounts without adding them as payees.' },
  IDEMPOTENCY_CONFLICT: { title: 'Already processing', description: 'This request is already being processed. Check your activity in a moment.' },
  IDEMPOTENCY_KEY_REUSED: { title: 'Request changed', description: 'Start a new transfer to send different details.' },
  BALANCE_LIMIT: { title: 'Balance limit', description: 'The account balance would exceed the permitted maximum.' },
  AMOUNT_TOO_LARGE: { title: 'Amount too large', description: 'The amount exceeds what is allowed for this operation.' },
  CONSTRAINT_VIOLATION: { title: 'Not permitted', description: 'The request would break a banking rule and was not processed.' },
  // Branch cash
  NO_TELLER_SESSION: { title: 'No open cash session', description: 'Accept your opening float before handling cash.' },
  STALE_TELLER_SESSION: { title: 'Session from a previous day', description: 'Close yesterday’s session before handling cash today.' },
  FLOAT_MISMATCH: { title: 'Count doesn’t match', description: 'Your count does not match the float issued. Recount, or ask your supervisor to reissue it.' },
  COUNT_MISMATCH: { title: 'Counts don’t agree', description: 'The supervisor count must match the teller’s declared count.' },
  WITHDRAWAL_NOT_AUTHORISED: { title: 'Withdrawal code not valid', description: 'The customer’s code must match this account and the exact amount, and be unexpired.' },
  DRAWER_NOT_EMPTY: { title: 'Drawer not empty', description: 'The drawer must be settled before this action.' },
  // Accounts & KYC
  KYC_NOT_VERIFIED: { title: 'Identity verification pending', description: 'You can open an account once your KYC has been verified.' },
  PROFILE_CHANGED: { title: 'Profile changed', description: 'The customer updated their details. Review the latest version before deciding.' },
  BALANCE_NOT_ZERO: { title: 'Balance must be zero', description: 'Move the remaining balance before closing the account.' },
  USER_DISABLED: { title: 'Account disabled', description: 'Contact the bank for help.' },
};

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Turns anything thrown by an API call into a title and description fit for the UI */
export function describeError(error: unknown): ErrorDescription {
  if (!isApiError(error)) {
    return { title: 'Something went wrong', description: 'Please try again.' };
  }
  const entry = CATALOG[error.code];
  let description = entry?.description ?? (error.message || 'Please try again.');
  if (error.status === 429 && error.retryAfterSeconds) {
    description = `${description} Try again in ${formatWait(error.retryAfterSeconds)}.`;
  }
  return {
    title: entry?.title ?? 'Request not completed',
    description,
    reference: error.status >= 500 || error.status === 0 ? error.correlationId : undefined,
  };
}
