import type { Role, StaffRole } from '@/lib/auth/session';

/** Every successful API response */
export interface Envelope<T> {
  success: true;
  data: T;
  pagination?: { limit: number; offset: number };
  message?: string;
}

export interface Page {
  limit?: number;
  offset?: number;
}

// --- auth -----------------------------------------------------------------------------------

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
}

/** In cookie transport the refresh token is never in the body */
export interface SessionTokens {
  accessToken: string;
  expiresInSeconds: number;
}

export interface LoginSuccess {
  user: PublicUser;
  tokens: SessionTokens;
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  expiresInSeconds: number;
}

export type LoginResult = LoginSuccess | MfaChallenge;

export const isMfaChallenge = (result: LoginResult): result is MfaChallenge =>
  (result as MfaChallenge).mfaRequired === true;

export interface Me {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
  isEmailVerified: boolean;
  mfaEnabled: boolean;
  passwordChangedAt: string | null;
  createdAt: string;
}

export interface MfaSetup {
  secret: string;
  otpauthUri: string;
}

export interface StaffActivation {
  tokens: SessionTokens;
  enrolmentToken: string;
}

export type AdminRequestType = 'CREATE_STAFF' | 'SET_USER_ACTIVE' | 'RESET_MFA';
export type AdminRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface AdminRequest {
  id: string;
  type: AdminRequestType;
  status: AdminRequestStatus;
  payload: { email?: string; role?: StaffRole; userId?: string; isActive?: boolean };
  targetUserId: string | null;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface DirectoryUser {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
  isEmailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
}

export interface QueuedRequest {
  requestId: string;
  status: AdminRequestStatus;
}

// --- customers ------------------------------------------------------------------------------

export type KycStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface CustomerProfile {
  id: string;
  userId: string;
  fullName: string;
  phoneNumber: string;
  address: string | null;
  dateOfBirth: string | null;
  kycStatus: KycStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInput {
  fullName: string;
  phoneNumber: string;
  address?: string;
  dateOfBirth?: string;
}

export interface KycEvent {
  id: string;
  userId: string;
  actorId: string;
  action: string;
  fromStatus: KycStatus | null;
  toStatus: KycStatus | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

// --- accounts -------------------------------------------------------------------------------

export type AccountType = 'SAVINGS' | 'CURRENT';
export type AccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';

export interface BankAccount {
  id: string;
  accountNumber: string;
  customerId: string;
  accountType: AccountType;
  status: AccountStatus;
  currency: 'INR';
  dailyLimitPaise: string;
  /** A limit set by the bank: the owner can lower the limit but not raise it above this */
  bankLimitCeilingPaise?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// --- ledger ---------------------------------------------------------------------------------

/** ONLINE_TOP_UP credits a Razorpay top-up; TOP_UP_REFUND takes it back when the bank refunds it */
export type TransactionType = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'CASH_TRANSFER' | 'ONLINE_TOP_UP' | 'TOP_UP_REFUND';

export interface Balance {
  accountId: string;
  balanceInPaise: string;
  currency: string;
}

export interface LedgerEntry {
  entryId: string;
  transactionId: string;
  referenceId: string;
  type: TransactionType;
  entryType: 'DEBIT' | 'CREDIT';
  amountInPaise: string;
  balanceAfterInPaise: string;
  description: string | null;
  createdAt: string;
}

export interface TransactionResult {
  transactionId: string;
  referenceId: string;
  type: TransactionType;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';
  amountInPaise: string;
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
  createdAt: string;
}

export interface TransferInput {
  sourceAccountId: string;
  destinationAccountId?: string;
  destinationAccountNumber?: string;
  amountInPaise: string;
  description?: string;
}

export interface Beneficiary {
  id: string;
  customerId: string;
  accountId: string;
  accountNumber: string;
  nickname: string;
  activatesAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface WithdrawalCode {
  authorizationCode: string;
  accountId: string;
  amountInPaise: string;
  expiresAt: string;
}

export type TellerSessionStatus = 'ISSUED' | 'OPEN' | 'CLOSED' | 'RECONCILED' | 'CANCELLED';

export interface TellerSession {
  id: string;
  tellerId: string;
  businessDate: string;
  /** Supervisor views only */
  drawerAccountId?: string;
  /** Hidden (null) from the teller while ISSUED: the float is counted blind */
  openingFloat: string | null;
  issuedBy: string | null;
  status: TellerSessionStatus;
  /** Supervisor views only, and only once RECONCILED: the counts are blind until sign-off */
  declaredClosing?: string | null;
  expectedClosing?: string | null;
  discrepancy?: string | null;
  /** A supervisor count that disagreed with the teller (supervisor views); a different admin can settle it */
  disputedBy?: string | null;
  disputedAt?: string | null;
  openedAt: string;
  acceptedAt: string | null;
  closedAt: string | null;
  signedOffBy: string | null;
  signedOffAt: string | null;
}

export type CashOperationType = 'DEPOSIT' | 'WITHDRAWAL';
export type CashOperationStatus = 'PENDING_APPROVAL' | 'EXECUTED' | 'REJECTED';

export interface CashOperation {
  id: string;
  type: CashOperationType;
  status: CashOperationStatus;
  accountId: string;
  amountInPaise: string;
  description: string | null;
  requestedBy: string;
  approvedBy: string | null;
  decidedAt: string | null;
  transactionId: string | null;
  createdAt: string;
}

export type CashOperationResult =
  | { status: 'EXECUTED'; cashOperationId: string; transaction: TransactionResult }
  | { status: 'PENDING_APPROVAL'; cashOperationId: string };

export interface CashInput {
  accountId: string;
  amountInPaise: string;
  description?: string;
}

export interface AccountLookup {
  id: string;
  accountNumber: string;
  customerId: string;
  accountType: AccountType;
  status: AccountStatus;
}

// --- fraud & notifications ------------------------------------------------------------------

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'DISMISSED';

export interface FraudAlert {
  id: string;
  transactionId: string;
  accountId: string;
  severity: RiskLevel;
  reason: string;
  status: AlertStatus;
  reviewedBy: string | null;
  initiatedBy: string | null;
  cashOperationId: string | null;
  closeRequestedBy: string | null;
  closeRequestedStatus: AlertStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface FraudAlertEvent {
  id: string;
  alertId: string;
  actorId: string;
  fromStatus: AlertStatus;
  toStatus: AlertStatus;
  note: string | null;
  createdAt: string;
}

export interface NotificationLog {
  id: string;
  recipient: string;
  channel: 'EMAIL' | 'SMS';
  subject: string;
  body: string;
  status: string;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
}

// --- payments: Razorpay top-ups -------------------------------------------------------------

/** `simulator` is development only: the bank's stand-in for Razorpay, paid from a test sheet in the app */
export type PaymentMode = 'live' | 'test' | 'simulator';

/** Paise strings; the daily figures follow the bank's (IST) day */
export interface TopUpLimits {
  minPaise: string;
  maxPaise: string;
  dailyLimitPaise: string;
  usedTodayPaise: string;
  remainingTodayPaise: string;
}

export interface PaymentConfig {
  provider: 'RAZORPAY';
  mode: PaymentMode;
  keyId: string;
  limits: TopUpLimits;
}

export type TopUpStatus =
  | 'CREATED'
  | 'PENDING'
  | 'CAPTURED'
  | 'CREDITED'
  | 'CREDIT_BLOCKED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED';

export interface TopUpHistoryEntry {
  from: TopUpStatus | null;
  to: TopUpStatus;
  source: string;
  at: string;
}

export interface TopUp {
  id: string;
  accountId: string;
  accountNumberLast4: string;
  amountPaise: string;
  currency: string;
  status: TopUpStatus;
  /** How the customer paid, as Razorpay reports it: upi, card, netbanking, wallet… */
  method: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  creditedAt: string | null;
  expiresAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  history?: TopUpHistoryEntry[];
}

/** What Razorpay Checkout needs to open the payment window for an order */
export interface CheckoutDetails {
  keyId: string;
  orderId: string;
  /** Paise */
  amount: string | number;
  currency: string;
  name: string;
  description: string;
  prefill: { email?: string };
}

export interface CreatedTopUp {
  topUp: TopUp;
  checkout: CheckoutDetails;
}

/** The signed result Checkout hands the browser after a payment; the server verifies it */
export interface PaymentProof {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}

export type SimulatedOutcome = 'success' | 'failure';
export type SimulatedMethod = 'upi' | 'card' | 'netbanking';

export interface TopUpPage {
  items: TopUp[];
  nextCursor: string | null;
}

// --- Sphere assistant -----------------------------------------------------------------------

export interface AssistantMeta {
  provider: 'llm' | 'builtin';
  model?: string;
  /** Prompts suited to the signed-in role */
  suggestions: string[];
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

/** Structured answer blocks. Data only: the app draws them; the assistant never sends markup. */
export type AssistantCard =
  | { type: 'accounts'; accounts: Array<{ id: string; label: string; last4: string; balancePaise: string }> }
  | {
      type: 'transactions';
      accountLabel: string;
      items: Array<{ id: string; at: string; description: string; direction: 'CREDIT' | 'DEBIT'; amountPaise: string }>;
    }
  | { type: 'spending'; days: number; inPaise: string; outPaise: string; byDay: Array<{ date: string; inPaise: string; outPaise: string }> }
  | { type: 'payees'; items: Array<{ nickname: string; last4: string; active: boolean }> }
  | { type: 'topups'; items: Array<{ id: string; amountPaise: string; status: TopUpStatus; at: string }> }
  | { type: 'transferDraft'; fromAccountId: string; toPayeeNickname?: string; amountPaise?: string; note?: string }
  | { type: 'help'; title: string; steps: string[] };

export type AssistantCardType = AssistantCard['type'];

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards: AssistantCard[];
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  messages: AssistantMessage[];
}

// --- account security -----------------------------------------------------------------------

/** One signed-in browser or device (a refresh-token family) */
export interface DeviceSession {
  id: string;
  /** The session making this request */
  current: boolean;
  /** "Chrome on Windows" */
  deviceLabel: string;
  /** Network part only: "203.0.113.x" */
  ipMasked: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** Signed in with the second factor */
  mfa: boolean;
}

export interface SecurityEvent {
  id: string;
  /** Sign-in succeeded or failed, MFA failed, new device, session revoked, password changed, IP auto-banned */
  type: string;
  deviceLabel: string | null;
  ipMasked: string | null;
  at: string;
  details: Record<string, unknown> | null;
}
