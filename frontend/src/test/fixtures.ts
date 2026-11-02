import type {
  AdminRequest,
  Balance,
  BankAccount,
  Beneficiary,
  CashOperation,
  CustomerProfile,
  DeviceSession,
  DirectoryUser,
  FraudAlert,
  FraudAlertEvent,
  KycEvent,
  LedgerEntry,
  Me,
  NotificationLog,
  PaymentConfig,
  SecurityEvent,
  TellerSession,
  TopUp,
} from '@/lib/api/types';

/** Stable ids so tests can refer to them */
export const IDS = {
  customer: '11111111-1111-4111-8111-111111111111',
  otherCustomer: '22222222-2222-4222-8222-222222222222',
  teller: '33333333-3333-4333-8333-333333333333',
  admin: '44444444-4444-4444-8444-444444444444',
  admin2: '55555555-5555-4555-8555-555555555555',
  savings: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  current: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  payeeAccount: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

const NOW = '2026-10-27T09:30:00.000Z';

export const aMe = (o: Partial<Me> = {}): Me => ({
  id: IDS.customer,
  email: 'asha@example.in',
  role: 'CUSTOMER',
  isActive: true,
  isEmailVerified: true,
  mfaEnabled: false,
  passwordChangedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  ...o,
});

export const aProfile = (o: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'prof-1',
  userId: IDS.customer,
  fullName: 'Asha Rao',
  phoneNumber: '+919876543210',
  address: '12 MG Road, Pune',
  dateOfBirth: '1992-04-12T00:00:00.000Z',
  kycStatus: 'VERIFIED',
  version: 2,
  createdAt: '2026-09-01T10:05:00.000Z',
  updatedAt: '2026-09-02T11:00:00.000Z',
  ...o,
});

export const anAccount = (o: Partial<BankAccount> = {}): BankAccount => ({
  id: IDS.savings,
  accountNumber: '100123456789',
  customerId: IDS.customer,
  accountType: 'SAVINGS',
  status: 'ACTIVE',
  currency: 'INR',
  dailyLimitPaise: '10000000',
  version: 1,
  createdAt: '2026-09-03T08:00:00.000Z',
  updatedAt: '2026-09-03T08:00:00.000Z',
  ...o,
});

export const aBalance = (accountId: string = IDS.savings, balanceInPaise = '12550075'): Balance => ({
  accountId,
  balanceInPaise,
  currency: 'INR',
});

export const anEntry = (o: Partial<LedgerEntry> = {}): LedgerEntry => ({
  entryId: 'entry-1',
  transactionId: 'txn-1',
  referenceId: 'REF-20261027-0001',
  type: 'TRANSFER',
  entryType: 'DEBIT',
  amountInPaise: '250000',
  balanceAfterInPaise: '12550075',
  description: 'Rent October',
  createdAt: NOW,
  ...o,
});

export const aBeneficiary = (o: Partial<Beneficiary> = {}): Beneficiary => ({
  id: 'ben-1',
  customerId: IDS.customer,
  accountId: IDS.payeeAccount,
  accountNumber: '100198765432',
  nickname: 'Ravi (landlord)',
  activatesAt: '2026-10-20T09:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-10-20T08:00:00.000Z',
  ...o,
});

export const aTellerSession = (o: Partial<TellerSession> = {}): TellerSession => ({
  id: 'sess-1',
  tellerId: IDS.teller,
  businessDate: '2026-10-27',
  drawerAccountId: 'drawer-1',
  openingFloat: '5000000',
  issuedBy: IDS.admin,
  status: 'OPEN',
  openedAt: '2026-10-27T03:30:00.000Z',
  acceptedAt: '2026-10-27T03:45:00.000Z',
  closedAt: null,
  signedOffBy: null,
  signedOffAt: null,
  ...o,
});

export const aCashOperation = (o: Partial<CashOperation> = {}): CashOperation => ({
  id: 'cash-1',
  type: 'DEPOSIT',
  status: 'PENDING_APPROVAL',
  accountId: IDS.savings,
  amountInPaise: '25000000',
  description: 'Branch deposit',
  requestedBy: IDS.teller,
  approvedBy: null,
  decidedAt: null,
  transactionId: null,
  createdAt: NOW,
  ...o,
});

export const anAlert = (o: Partial<FraudAlert> = {}): FraudAlert => ({
  id: 'alert-1',
  transactionId: 'txn-9',
  accountId: IDS.savings,
  severity: 'HIGH',
  reason: 'Amount ₹2,50,000.00 exceeds the high-value threshold',
  status: 'OPEN',
  reviewedBy: null,
  initiatedBy: IDS.customer,
  cashOperationId: null,
  closeRequestedBy: null,
  closeRequestedStatus: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...o,
});

export const anAlertEvent = (o: Partial<FraudAlertEvent> = {}): FraudAlertEvent => ({
  id: 'ev-1',
  alertId: 'alert-1',
  actorId: 'analyst-1',
  fromStatus: 'OPEN',
  toStatus: 'UNDER_REVIEW',
  note: 'Calling the customer',
  createdAt: NOW,
  ...o,
});

export const anAdminRequest = (o: Partial<AdminRequest> = {}): AdminRequest => ({
  id: 'req-1',
  type: 'CREATE_STAFF',
  status: 'PENDING',
  payload: { email: 'meera.teller@banksphere.local', role: 'TELLER' },
  targetUserId: null,
  requestedBy: IDS.admin2,
  decidedBy: null,
  decidedAt: null,
  expiresAt: '2026-10-28T09:30:00.000Z',
  createdAt: NOW,
  ...o,
});

export const aDirectoryUser = (o: Partial<DirectoryUser> = {}): DirectoryUser => ({
  id: IDS.teller,
  email: 'meera.teller@banksphere.local',
  role: 'TELLER',
  isActive: true,
  isEmailVerified: true,
  mfaEnabled: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  ...o,
});

export const aKycEvent = (o: Partial<KycEvent> = {}): KycEvent => ({
  id: 'kyc-ev-1',
  userId: IDS.customer,
  actorId: 'kyc-officer-1',
  action: 'KYC_DECISION',
  fromStatus: 'PENDING',
  toStatus: 'VERIFIED',
  details: null,
  createdAt: NOW,
  ...o,
});

export const aNotificationLog = (o: Partial<NotificationLog> = {}): NotificationLog => ({
  id: 'log-1',
  recipient: 'asha@example.in',
  channel: 'EMAIL',
  subject: 'Your account was debited',
  body: '₹2,500.00 was debited from ••••6789',
  status: 'SENT',
  retryCount: 0,
  lastError: null,
  createdAt: NOW,
  ...o,
});

export type PaymentConfigOverrides = Omit<Partial<PaymentConfig>, 'limits'> & { limits?: Partial<PaymentConfig['limits']> };

export const aPaymentConfig = (o: PaymentConfigOverrides = {}): PaymentConfig => ({
  provider: 'RAZORPAY',
  mode: 'simulator',
  keyId: 'rzp_test_banksphere',
  ...o,
  limits: {
    minPaise: '100',
    maxPaise: '10000000',
    dailyLimitPaise: '20000000',
    usedTodayPaise: '5000000',
    remainingTodayPaise: '15000000',
    ...o.limits,
  },
});

export const aTopUp = (o: Partial<TopUp> = {}): TopUp => ({
  id: 'top-1',
  accountId: IDS.savings,
  accountNumberLast4: '6789',
  amountPaise: '50000',
  currency: 'INR',
  status: 'CREATED',
  method: null,
  providerOrderId: 'order_SIM1',
  providerPaymentId: null,
  failureReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  creditedAt: null,
  expiresAt: '2026-10-27T10:00:00.000Z',
  refundedAt: null,
  refundReason: null,
  ...o,
});

export const aDeviceSession = (o: Partial<DeviceSession> = {}): DeviceSession => ({
  id: 'dev-1',
  current: true,
  deviceLabel: 'Chrome on Windows',
  ipMasked: '203.0.113.x',
  createdAt: '2026-10-20T08:00:00.000Z',
  lastSeenAt: NOW,
  mfa: false,
  ...o,
});

export const aSecurityEvent = (o: Partial<SecurityEvent> = {}): SecurityEvent => ({
  id: 'sec-1',
  type: 'SIGN_IN_SUCCEEDED',
  deviceLabel: 'Chrome on Windows',
  ipMasked: '203.0.113.x',
  at: NOW,
  details: null,
  ...o,
});
