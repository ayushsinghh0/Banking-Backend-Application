import type { ApiClient } from './client';
import { normalizeCards } from './cards';
import type {
  AccountLookup,
  AccountStatus,
  AccountType,
  AdminRequest,
  AdminRequestStatus,
  AlertStatus,
  AssistantMessage,
  AssistantMeta,
  Balance,
  BankAccount,
  Beneficiary,
  CashInput,
  CashOperation,
  CashOperationResult,
  CashOperationStatus,
  Conversation,
  ConversationSummary,
  CreatedTopUp,
  CustomerProfile,
  DeviceSession,
  DirectoryUser,
  Envelope,
  FraudAlert,
  FraudAlertEvent,
  KycEvent,
  KycStatus,
  LedgerEntry,
  LoginResult,
  LoginSuccess,
  Me,
  MfaSetup,
  NotificationLog,
  Page,
  PaymentConfig,
  PaymentProof,
  ProfileInput,
  QueuedRequest,
  SecurityEvent,
  SessionTokens,
  SimulatedMethod,
  SimulatedOutcome,
  StaffActivation,
  TellerSession,
  TellerSessionStatus,
  TopUp,
  TopUpPage,
  TransactionResult,
  TransferInput,
  WithdrawalCode,
} from './types';
import type { Role, StaffRole } from '@/lib/auth/session';

const id = (value: string) => encodeURIComponent(value);

/** 200 with the changed user, or 202 with a four-eyes request for a second administrator */
export type MaybeQueued<T> = { queued: true; request: QueuedRequest } | { queued: false; result: T };

function queuedOr<T>(data: unknown): MaybeQueued<T> {
  const candidate = data as Partial<QueuedRequest> | undefined;
  if (candidate && typeof candidate.requestId === 'string') {
    return { queued: true, request: candidate as QueuedRequest };
  }
  return { queued: false, result: data as T };
}

/** Some routes answer `{ topUp }`, others the top-up itself: accept either */
function unwrapTopUp(data: unknown): TopUp {
  const candidate = data as { topUp?: TopUp } | undefined;
  return (candidate && typeof candidate === 'object' && 'topUp' in candidate ? candidate.topUp : data) as TopUp;
}

/** A cursor page as `{ items, nextCursor }`, or a plain list with the cursor in the envelope's pagination */
function toTopUpPage(envelope: (Envelope<unknown> & { pagination?: { nextCursor?: string | null } }) | undefined): TopUpPage {
  const data = envelope?.data as { items?: TopUp[]; nextCursor?: string | null } | TopUp[] | undefined;
  if (Array.isArray(data)) return { items: data, nextCursor: envelope?.pagination?.nextCursor ?? null };
  return { items: data?.items ?? [], nextCursor: data?.nextCursor ?? null };
}

/** The signed triple, whether it comes back camelCased or exactly as Checkout.js names it */
function toPaymentProof(data: unknown): PaymentProof | null {
  const raw = (data ?? {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string) => {
    const value = raw[camel] ?? raw[snake];
    return typeof value === 'string' && value ? value : null;
  };
  const razorpayPaymentId = pick('razorpayPaymentId', 'razorpay_payment_id');
  const razorpayOrderId = pick('razorpayOrderId', 'razorpay_order_id');
  const razorpaySignature = pick('razorpaySignature', 'razorpay_signature');
  return razorpayPaymentId && razorpayOrderId && razorpaySignature ? { razorpayPaymentId, razorpayOrderId, razorpaySignature } : null;
}

const withCards = (message: AssistantMessage): AssistantMessage => ({ ...message, content: message.content ?? '', cards: normalizeCards(message.cards) });

/** Lists may arrive bare or as `{ items }` */
const listOf = <T>(data: unknown): T[] => (Array.isArray(data) ? data : ((data as { items?: T[] } | undefined)?.items ?? [])) as T[];

export function createEndpoints(client: ApiClient) {
  const get = async <T>(path: string, query?: object) =>
    (await client.request<Envelope<T>>(path, { query: query as Record<string, string | number | undefined> })).data;
  const send = async <T>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    extra: { auth?: boolean; idempotencyKey?: string } = {}
  ) => {
    const envelope = await client.request<Envelope<T> | undefined>(path, { method, body, ...extra });
    return envelope?.data as T;
  };
  const publicPost = async <T = { message: string }>(path: string, body: unknown) => {
    const envelope = await client.request<Envelope<T> & { message?: string }>(path, { method: 'POST', body, auth: false });
    return (envelope.data ?? { message: envelope.message }) as T;
  };

  return {
    auth: {
      login: (email: string, password: string) => send<LoginResult>('POST', '/auth/login', { email, password }, { auth: false }),
      loginMfa: (challengeToken: string, code: string) =>
        send<LoginSuccess>('POST', '/auth/login/mfa', { challengeToken, code }, { auth: false }),
      register: (email: string, password: string) => publicPost('/auth/register', { email, password }),
      verifyEmail: (token: string) => publicPost('/auth/email/verify', { token }),
      resendVerification: (email: string) => publicPost('/auth/email/resend-verification', { email }),
      forgotPassword: (email: string) => publicPost('/auth/password/forgot', { email }),
      resetPassword: (token: string, newPassword: string) => publicPost('/auth/password/reset', { token, newPassword }),
      activateStaff: (token: string, password: string) =>
        send<StaffActivation>('POST', '/auth/staff/activate', { token, password }, { auth: false }),
      me: () => get<Me>('/auth/me'),
      changePassword: (currentPassword: string, newPassword: string) =>
        send<{ tokens: SessionTokens }>('POST', '/auth/password/change', { currentPassword, newPassword }),
      mfaSetup: (password: string, enrolmentToken?: string) =>
        send<MfaSetup>('POST', '/auth/mfa/setup', enrolmentToken ? { password, enrolmentToken } : { password }),
      mfaEnable: (code: string, enrolmentToken?: string) =>
        send<{ tokens: SessionTokens }>('POST', '/auth/mfa/enable', enrolmentToken ? { code, enrolmentToken } : { code }),
      mfaDisable: (password: string, code: string) => send<undefined>('POST', '/auth/mfa/disable', { password, code }),
      stepUp: (code: string) => send<SessionTokens>('POST', '/auth/mfa/step-up', { code }),
    },

    admin: {
      users: (params: { role?: Role; q?: string } & Page = {}) => get<DirectoryUser[]>('/auth/admin/users', params),
      requestStaff: (email: string, role: StaffRole) => send<QueuedRequest>('POST', '/auth/admin/users', { email, role }),
      setUserActive: async (userId: string, isActive: boolean) =>
        queuedOr<Pick<DirectoryUser, 'id' | 'email' | 'role' | 'isActive'>>(
          await send('PATCH', `/auth/admin/users/${id(userId)}/status`, { isActive })
        ),
      resetMfa: async (userId: string) => queuedOr<undefined>(await send('POST', `/auth/admin/users/${id(userId)}/mfa/reset`)),
      requests: (params: { status?: AdminRequestStatus } & Page = {}) => get<AdminRequest[]>('/auth/admin/requests', params),
      approveRequest: (requestId: string) =>
        send<{ request: AdminRequest; outcome: unknown }>('POST', `/auth/admin/requests/${id(requestId)}/approve`),
      rejectRequest: (requestId: string) =>
        send<{ id: string; status: AdminRequestStatus }>('POST', `/auth/admin/requests/${id(requestId)}/reject`),
    },

    customers: {
      me: () => get<CustomerProfile>('/customers/me'),
      createMe: (input: ProfileInput) => send<CustomerProfile>('POST', '/customers/me', input),
      updateMe: (input: Partial<ProfileInput>) => send<CustomerProfile>('PATCH', '/customers/me', input),
      list: (params: { kycStatus?: KycStatus; q?: string } & Page = {}) => get<CustomerProfile[]>('/customers', params),
      get: (userId: string) => get<CustomerProfile>(`/customers/${id(userId)}`),
      decideKyc: (userId: string, kycStatus: KycStatus, expectedVersion: number) =>
        send<CustomerProfile>('PATCH', `/customers/${id(userId)}/kyc`, { kycStatus, expectedVersion }),
      kycHistory: (userId: string) => get<KycEvent[]>(`/customers/${id(userId)}/kyc/history`),
    },

    accounts: {
      list: (customerId?: string) => get<BankAccount[]>('/accounts', { customerId }),
      get: (accountId: string) => get<BankAccount>(`/accounts/${id(accountId)}`),
      open: (accountType: AccountType) => send<BankAccount>('POST', '/accounts', { accountType }),
      setStatus: (accountId: string, status: AccountStatus) =>
        send<BankAccount>('PATCH', `/accounts/${id(accountId)}/status`, { status }),
      setDailyLimit: (accountId: string, dailyLimitPaise: string) =>
        send<BankAccount>('PATCH', `/accounts/${id(accountId)}/daily-limit`, { dailyLimitPaise }),
      lookup: (accountNumber: string) => get<AccountLookup>('/accounts/lookup', { accountNumber }),
    },

    ledger: {
      balance: (accountId: string) => get<Balance>(`/transactions/accounts/${id(accountId)}/balance`),
      history: (accountId: string, page: Page = {}) =>
        get<LedgerEntry[]>(`/transactions/accounts/${id(accountId)}/history`, { ...page }),
      transfer: (input: TransferInput, idempotencyKey: string) =>
        send<TransactionResult>('POST', '/transactions/transfer', input, { idempotencyKey }),
      beneficiaries: () => get<Beneficiary[]>('/transactions/beneficiaries'),
      addBeneficiary: (accountNumber: string, nickname: string) =>
        send<Beneficiary>('POST', '/transactions/beneficiaries', { accountNumber, nickname }),
      removeBeneficiary: (beneficiaryId: string) => send<undefined>('DELETE', `/transactions/beneficiaries/${id(beneficiaryId)}`),
      createWithdrawalCode: (accountId: string, amountInPaise: string) =>
        send<WithdrawalCode>('POST', '/transactions/withdrawal-codes', { accountId, amountInPaise }),
    },

    teller: {
      currentSession: () => get<TellerSession | null>('/transactions/teller/sessions/current'),
      acceptFloat: (countedFloatPaise: string) =>
        send<TellerSession>('POST', '/transactions/teller/sessions/accept', { countedFloatPaise }),
      closeSession: (countedCashPaise: string) =>
        send<TellerSession>('POST', '/transactions/teller/sessions/close', { countedCashPaise }),
      deposit: (input: CashInput, idempotencyKey: string) =>
        send<CashOperationResult>('POST', '/transactions/deposit', input, { idempotencyKey }),
      withdraw: (input: CashInput & { authorizationCode: string }, idempotencyKey: string) =>
        send<CashOperationResult>('POST', '/transactions/withdraw', input, { idempotencyKey }),
      cashOperations: (params: { status?: CashOperationStatus } & Page = {}) =>
        get<CashOperation[]>('/transactions/cash-operations', params),
    },

    supervisor: {
      sessions: (params: { status?: TellerSessionStatus } & Page = {}) => get<TellerSession[]>('/transactions/teller/sessions', params),
      issueFloat: (tellerId: string, openingFloatPaise: string) =>
        send<TellerSession>('POST', '/transactions/teller/sessions', { tellerId, openingFloatPaise }),
      cancelFloat: (sessionId: string) => send<{ id: string; status: 'CANCELLED' }>('POST', `/transactions/teller/sessions/${id(sessionId)}/cancel`),
      signOff: (sessionId: string, countedCashPaise: string) =>
        send<TellerSession>('POST', `/transactions/teller/sessions/${id(sessionId)}/sign-off`, { countedCashPaise }),
      approveCash: (cashOperationId: string, idempotencyKey: string) =>
        send<CashOperationResult>('POST', `/transactions/cash-operations/${id(cashOperationId)}/approve`, undefined, { idempotencyKey }),
      rejectCash: (cashOperationId: string) =>
        send<{ cashOperationId: string; status: 'REJECTED' }>('POST', `/transactions/cash-operations/${id(cashOperationId)}/reject`),
    },

    fraud: {
      alerts: (params: { status?: AlertStatus } & Page = {}) => get<FraudAlert[]>('/fraud/alerts', params),
      updateAlert: (alertId: string, status: AlertStatus, note?: string) =>
        send<FraudAlert>('PATCH', `/fraud/alerts/${id(alertId)}`, note ? { status, note } : { status }),
      history: (alertId: string) => get<FraudAlertEvent[]>(`/fraud/alerts/${id(alertId)}/history`),
    },

    payments: {
      config: () => get<PaymentConfig>('/payments/config'),
      /** One intent, one key: reuse the key when retrying the same top-up after an unclear failure */
      createTopUp: (input: { accountId: string; amountPaise: string }, idempotencyKey: string) =>
        send<CreatedTopUp>('POST', '/payments/top-ups', input, { idempotencyKey }),
      confirmTopUp: async (topUpId: string, proof: PaymentProof) =>
        unwrapTopUp(await send('POST', `/payments/top-ups/${id(topUpId)}/confirm`, proof)),
      cancelTopUp: async (topUpId: string) => {
        const data = await send('POST', `/payments/top-ups/${id(topUpId)}/cancel`);
        return data === undefined ? undefined : unwrapTopUp(data);
      },
      /** Simulator mode only: pays (or declines) the order and returns what Checkout would have */
      simulateTopUp: async (topUpId: string, outcome: SimulatedOutcome, method: SimulatedMethod) =>
        toPaymentProof(await send('POST', `/payments/top-ups/${id(topUpId)}/simulate`, { outcome, method })),
      topUps: async (params: { limit?: number; cursor?: string | null } = {}) =>
        toTopUpPage(
          await client.request<Envelope<unknown> & { pagination?: { nextCursor?: string | null } }>('/payments/top-ups', {
            query: { limit: params.limit, cursor: params.cursor ?? undefined },
          })
        ),
      topUp: async (topUpId: string) => unwrapTopUp(await get(`/payments/top-ups/${id(topUpId)}`)),
    },

    assistant: {
      meta: () => get<AssistantMeta>('/assistant/meta'),
      conversations: async () => listOf<ConversationSummary>(await get('/assistant/conversations')),
      createConversation: (title?: string) => send<ConversationSummary>('POST', '/assistant/conversations', title ? { title } : {}),
      conversation: async (conversationId: string) => {
        const conversation = await get<Conversation>(`/assistant/conversations/${id(conversationId)}`);
        return { ...conversation, messages: (conversation.messages ?? []).map(withCards) };
      },
      deleteConversation: (conversationId: string) => send<undefined>('DELETE', `/assistant/conversations/${id(conversationId)}`),
    },

    security: {
      sessions: async () => listOf<DeviceSession>(await get('/auth/sessions')),
      revokeSession: (sessionId: string) => send<undefined>('DELETE', `/auth/sessions/${id(sessionId)}`),
      revokeOtherSessions: () => send<{ revoked?: number } | undefined>('POST', '/auth/sessions/revoke-others'),
      events: async (limit = 20) => listOf<SecurityEvent>(await get('/auth/security-events', { limit })),
    },

    notifications: {
      logs: (params: { recipient?: string } & Page = {}) => get<NotificationLog[]>('/notifications/logs', params),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
