import { HttpError } from '@banksphere/common';

/** Machine-readable refusals of the payments API (the web app matches on these codes) */
export const PaymentErrors = {
  idempotencyKeyRequired: () =>
    new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 letters, digits, "_" or "-")'),
  idempotencyKeyReused: () =>
    new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different top-up request'),
  invalidAmount: () => new HttpError(400, 'INVALID_AMOUNT', 'amountPaise must be a positive whole number of paise, as a string'),
  amountTooSmall: (min: bigint) => new HttpError(422, 'AMOUNT_TOO_SMALL', `The minimum top-up is ${min} paise`),
  amountTooLarge: (max: bigint) => new HttpError(422, 'AMOUNT_TOO_LARGE', `The maximum top-up is ${max} paise`),
  dailyLimit: (remaining: bigint) =>
    new HttpError(422, 'TOPUP_DAILY_LIMIT_EXCEEDED', `This would exceed today's top-up limit (${remaining} paise left today)`),
  tooManyOpen: (max: number) =>
    new HttpError(409, 'TOO_MANY_OPEN_TOP_UPS', `You already have ${max} top-ups waiting for payment; finish or cancel one first`),
  kycNotVerified: () => new HttpError(403, 'KYC_NOT_VERIFIED', 'Your identity must be verified before you can add money'),
  accountNotFound: () => new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found'),
  accountInactive: () => new HttpError(403, 'ACCOUNT_INACTIVE', 'This account cannot receive money right now'),
  topUpNotFound: () => new HttpError(404, 'TOP_UP_NOT_FOUND', 'Top-up not found'),
  invalidSignature: () => new HttpError(400, 'INVALID_PAYMENT_SIGNATURE', 'The payment signature is not valid for this top-up'),
  orderMismatch: () => new HttpError(400, 'PAYMENT_ORDER_MISMATCH', 'This payment does not belong to this top-up'),
  notCaptured: (reason: string | null) =>
    new HttpError(422, 'PAYMENT_NOT_CAPTURED', reason ? `The payment was not completed (${reason})` : 'The payment was not completed'),
  cannotCancel: () => new HttpError(409, 'TOP_UP_NOT_CANCELLABLE', 'Only a top-up that is still waiting for payment can be cancelled'),
  simulatorOnly: () => new HttpError(404, 'NOT_FOUND', 'Requested resource not found'),
  stepUpRequired: () =>
    new HttpError(
      403,
      'STEP_UP_REQUIRED',
      'Confirm this action with your authenticator: POST /api/v1/auth/mfa/step-up, then retry with the new access token'
    ),
  notRefundable: () => new HttpError(409, 'TOP_UP_NOT_REFUNDABLE', 'Only a credited or blocked top-up can be refunded'),
  refundInsufficientFunds: () =>
    new HttpError(409, 'INSUFFICIENT_FUNDS', "The customer's balance no longer covers this top-up; nothing was refunded"),
  refundRejected: (detail: string) => new HttpError(409, 'REFUND_REJECTED', `Razorpay refused the refund (${detail}); the ledger was restored`),
  reconcileInProgress: () => new HttpError(409, 'RECONCILE_IN_PROGRESS', 'A reconciliation run is already in progress; try again shortly'),
  invalidCursor: () => new HttpError(400, 'INVALID_CURSOR', 'The cursor is not valid'),
};

/** Ledger / customer-service refusals that mean "this account can't take the money" */
export function isNotCreditable(err: unknown): boolean {
  return err instanceof HttpError && err.statusCode === 409;
}
