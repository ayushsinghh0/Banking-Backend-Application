import crypto from 'crypto';
import { PrismaClient, Prisma } from '../../generated/client';
import { AuthenticatedUser, ConflictError, ForbiddenError, HttpError, logger } from '@banksphere/common';
import { CashOperationDTO, CashOperationResult, TransactionResult, TransactionStatus, TransactionType } from '../types';
import { AccountInactiveError, InsufficientFundsError, InvalidAmountError, NotFoundError } from '../errors';
import {
  LedgerPolicy,
  LockedAccount,
  TxClient,
  advisoryLock,
  assertWithinDailyLimits,
  audit,
  defaultLedgerPolicy,
  generateReferenceId,
  istBusinessDate,
  lockAccounts,
  postDoubleEntry,
  stageTransactionEvent,
  startOfIstDay,
  toResult,
} from './ledger-core';

const CODE_ATTEMPTS_BEFORE_LOCK = 5;
const hashCode = (authorizationId: string, code: string) =>
  crypto.createHash('sha256').update(`${authorizationId}:${code}`).digest('hex');

/**
 * Branch cash handling:
 * - every cash deposit/withdrawal is double-entry against the teller's cash drawer (TELLER_CASH account),
 *   so cash entering the ledger must physically be in a drawer;
 * - a teller works inside a business-day session: opening float -> operations -> closing count; the
 *   expected closing cash is computed from the ledger and any discrepancy is flagged for a supervisor,
 *   whose sign-off (a different BANK_ADMIN) reconciles the session;
 * - withdrawals need a single-use code the customer generated in their own session;
 * - large operations, or a teller exceeding their daily single-approval budget, need a second
 *   administrator (maker-checker), and staff never operate on accounts they own.
 */
export class TellerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: LedgerPolicy = defaultLedgerPolicy()
  ) {}

  private inTransaction<T>(tx: TxClient | undefined, work: (tx: TxClient) => Promise<T>): Promise<T> {
    if (tx) return work(tx);
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 15_000,
    });
  }

  // ---------------------------------------------------------------------------
  // Teller sessions
  // ---------------------------------------------------------------------------

  private async drawerFor(tx: TxClient, tellerId: string) {
    const existing = await tx.ledgerAccount.findFirst({ where: { customerId: tellerId, kind: 'TELLER_CASH' } });
    if (existing) return existing;
    return tx.ledgerAccount.create({
      data: {
        kind: 'TELLER_CASH',
        customerId: tellerId,
        accountNumber: `DRAWER-${tellerId}`,
        currency: 'INR',
        dailyLimit: 900_000_000_000_000_000n,
        isActive: true,
      },
    });
  }

  public async openSession(teller: AuthenticatedUser, openingFloat: bigint) {
    if (openingFloat < 0n) throw new InvalidAmountError('Opening float cannot be negative');
    return this.prisma.$transaction(async (tx) => {
      const businessDate = istBusinessDate();
      const existing = await tx.tellerSession.findUnique({ where: { tellerId_businessDate: { tellerId: teller.id, businessDate } } });
      if (existing) throw new ConflictError(`A session for ${businessDate} already exists (${existing.status})`);
      const unreconciled = await tx.tellerSession.findFirst({ where: { tellerId: teller.id, status: 'OPEN' } });
      if (unreconciled) throw new ConflictError('Close your previous session before opening a new one');
      const drawer = await this.drawerFor(tx, teller.id);
      const session = await tx.tellerSession.create({
        data: { tellerId: teller.id, businessDate, drawerAccountId: drawer.id, openingFloat },
      });
      await audit(tx, teller.id, 'TELLER_SESSION_OPENED', session.id, { openingFloat: openingFloat.toString() });
      return this.sessionView(session);
    });
  }

  /** Expected closing cash = opening float + net drawer movement during the session */
  private async expectedClosing(tx: TxClient | PrismaClient, session: { drawerAccountId: string; openingFloat: bigint; openedAt: Date }) {
    const [{ net }] = await tx.$queryRaw<Array<{ net: bigint | null }>>`
      SELECT SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END)::bigint AS net
      FROM ledger_entries WHERE account_id = ${session.drawerAccountId} AND created_at >= ${session.openedAt}
    `;
    return session.openingFloat + (net ?? 0n);
  }

  public async closeSession(teller: AuthenticatedUser, countedCash: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.tellerSession.findFirst({ where: { tellerId: teller.id, status: 'OPEN' } });
      if (!session) throw new ConflictError('You have no open teller session');
      await advisoryLock(tx, `teller:${teller.id}`);
      const pending = await tx.cashOperation.count({ where: { requestedBy: teller.id, status: 'PENDING_APPROVAL' } });
      if (pending) throw new ConflictError(`${pending} cash operation(s) still await approval; resolve them before closing`);
      const expected = await this.expectedClosing(tx, session);
      const discrepancy = countedCash - expected;
      const closed = await tx.tellerSession.update({
        where: { id: session.id },
        data: { status: 'CLOSED', declaredClosing: countedCash, expectedClosing: expected, discrepancy, closedAt: new Date() },
      });
      await audit(tx, teller.id, 'TELLER_SESSION_CLOSED', session.id, {
        expected: expected.toString(),
        counted: countedCash.toString(),
        discrepancy: discrepancy.toString(),
      });
      if (discrepancy !== 0n) {
        logger.error({ sessionId: session.id, tellerId: teller.id, discrepancy: discrepancy.toString(), alert: 'TELLER_CASH_DISCREPANCY' }, 'Teller cash count does not match the ledger');
      }
      return this.sessionView(closed);
    });
  }

  /** A different BANK_ADMIN reviews the count and signs the session off */
  public async signOffSession(supervisor: AuthenticatedUser, sessionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.tellerSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundError('Teller session not found');
      if (session.tellerId === supervisor.id) throw new ForbiddenError('A session must be signed off by a different administrator');
      const result = await tx.tellerSession.updateMany({
        where: { id: sessionId, status: 'CLOSED' },
        data: { status: 'RECONCILED', signedOffBy: supervisor.id, signedOffAt: new Date() },
      });
      if (result.count !== 1) throw new ConflictError('Only a CLOSED session can be signed off');
      await audit(tx, supervisor.id, 'TELLER_SESSION_SIGNED_OFF', sessionId, { discrepancy: session.discrepancy?.toString() });
      return this.sessionView(await tx.tellerSession.findUniqueOrThrow({ where: { id: sessionId } }));
    });
  }

  public async listSessions(status: 'OPEN' | 'CLOSED' | 'RECONCILED' | undefined, limit: number, offset: number) {
    const rows = await this.prisma.tellerSession.findMany({
      where: status ? { status } : undefined,
      orderBy: { openedAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return rows.map((r) => this.sessionView(r));
  }

  private sessionView(s: {
    openingFloat: bigint;
    declaredClosing: bigint | null;
    expectedClosing: bigint | null;
    discrepancy: bigint | null;
    [key: string]: unknown;
  }) {
    return {
      ...s,
      openingFloat: s.openingFloat.toString(),
      declaredClosing: s.declaredClosing?.toString() ?? null,
      expectedClosing: s.expectedClosing?.toString() ?? null,
      discrepancy: s.discrepancy?.toString() ?? null,
    };
  }

  private async requireOpenSession(tx: TxClient, tellerId: string) {
    const session = await tx.tellerSession.findFirst({ where: { tellerId, status: 'OPEN' } });
    if (!session) throw new HttpError(409, 'NO_TELLER_SESSION', 'The teller has no open session; open one with the opening cash float first');
    if (session.businessDate !== istBusinessDate()) {
      throw new HttpError(409, 'STALE_TELLER_SESSION', 'The open teller session is from a previous business day; close it first');
    }
    return session;
  }

  // ---------------------------------------------------------------------------
  // Customer withdrawal authorisations
  // ---------------------------------------------------------------------------

  /** The account owner authorises a specific cash withdrawal; the 8-digit code is shown once */
  public async createWithdrawalCode(customer: AuthenticatedUser, accountId: string, amount: bigint) {
    if (amount <= 0n) throw new InvalidAmountError();
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account || account.customerId !== customer.id || account.kind !== 'CUSTOMER') throw new NotFoundError('Account not found');
    const code = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + this.policy.withdrawalCodeTtlMinutes * 60_000);
    await this.prisma.$transaction([
      // Only the newest code for an account is valid
      this.prisma.withdrawalAuthorization.updateMany({ where: { accountId, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.withdrawalAuthorization.create({
        data: { id, accountId, customerId: customer.id, amount, codeHash: hashCode(id, code), expiresAt },
      }),
    ]);
    return { authorizationCode: code, accountId, amountInPaise: amount.toString(), expiresAt };
  }

  /** Validates and consumes the customer's code inside the teller's transaction */
  private async consumeWithdrawalCode(tx: TxClient, accountId: string, amount: bigint, code: string | undefined, cashOperationId: string) {
    const invalid = () => new HttpError(403, 'WITHDRAWAL_NOT_AUTHORISED', 'A valid customer withdrawal code for this account and amount is required');
    if (!code || !/^\d{8}$/.test(code)) throw invalid();
    const auth = await tx.withdrawalAuthorization.findFirst({
      where: { accountId, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!auth) throw invalid();
    const presented = Buffer.from(hashCode(auth.id, code));
    if (auth.amount !== amount || !crypto.timingSafeEqual(presented, Buffer.from(auth.codeHash))) {
      // Count failures per account (append-only audit) and burn the code after too many wrong guesses
      await audit(this.prisma, 'system', 'WITHDRAWAL_CODE_FAILED', accountId);
      const failures = await this.prisma.auditLog.count({
        where: { action: 'WITHDRAWAL_CODE_FAILED', targetId: accountId, createdAt: { gte: auth.createdAt } },
      });
      if (failures >= CODE_ATTEMPTS_BEFORE_LOCK) {
        await this.prisma.withdrawalAuthorization.updateMany({ where: { accountId, usedAt: null }, data: { usedAt: new Date() } });
        logger.warn({ accountId, alert: 'WITHDRAWAL_CODE_BRUTE_FORCE' }, 'Withdrawal codes invalidated after repeated wrong attempts');
      }
      throw invalid();
    }
    const claimed = await tx.withdrawalAuthorization.updateMany({
      where: { id: auth.id, usedAt: null },
      data: { usedAt: new Date(), cashOperationId },
    });
    if (claimed.count !== 1) throw invalid();
  }

  // ---------------------------------------------------------------------------
  // Cash operations (maker-checker)
  // ---------------------------------------------------------------------------

  public async requestCashOperation(dto: CashOperationDTO, teller: AuthenticatedUser, txClient?: TxClient): Promise<CashOperationResult> {
    if (dto.amountInPaise <= 0n) throw new InvalidAmountError();

    return this.inTransaction(txClient, async (tx) => {
      const account = await tx.ledgerAccount.findUnique({ where: { id: dto.accountId } });
      if (!account || account.kind !== 'CUSTOMER') throw new NotFoundError('Account not found');
      if (account.customerId === teller.id) {
        throw new ForbiddenError('Staff cannot perform cash operations on their own accounts');
      }
      if (!account.isActive || account.closedAt) throw new AccountInactiveError();

      await advisoryLock(tx, `teller:${teller.id}`);
      await this.requireOpenSession(tx, teller.id);

      const operationId = crypto.randomUUID();
      if (dto.type === 'WITHDRAWAL') {
        await this.consumeWithdrawalCode(tx, dto.accountId, dto.amountInPaise, dto.authorizationCode, operationId);
      }

      const executedToday = await tx.cashOperation.aggregate({
        _sum: { amount: true },
        where: { requestedBy: teller.id, status: 'EXECUTED', approvedBy: null, createdAt: { gte: startOfIstDay() } },
      });
      const needsApproval =
        dto.amountInPaise > this.policy.singleApprovalLimit ||
        (executedToday._sum.amount ?? 0n) + dto.amountInPaise > this.policy.tellerDailyLimit;

      const operation = await tx.cashOperation.create({
        data: {
          id: operationId,
          type: dto.type,
          status: needsApproval ? 'PENDING_APPROVAL' : 'EXECUTED',
          accountId: dto.accountId,
          amount: dto.amountInPaise,
          description: dto.description,
          requestedBy: teller.id,
          decidedAt: needsApproval ? null : new Date(),
        },
      });

      if (needsApproval) {
        await audit(tx, teller.id, `CASH_${dto.type}_REQUESTED`, operation.id, { accountId: dto.accountId, amountInPaise: dto.amountInPaise.toString() });
        return { status: 'PENDING_APPROVAL', cashOperationId: operation.id };
      }

      const transaction = await this.postCash(tx, operation.id, dto, teller.id);
      await tx.cashOperation.update({ where: { id: operation.id }, data: { transactionId: transaction.transactionId } });
      await audit(tx, teller.id, `CASH_${dto.type}_EXECUTED`, operation.id, {
        accountId: dto.accountId,
        amountInPaise: dto.amountInPaise.toString(),
        transactionId: transaction.transactionId,
      });
      return { status: 'EXECUTED', cashOperationId: operation.id, transaction };
    });
  }

  public async approveCashOperation(cashOperationId: string, approver: AuthenticatedUser, txClient?: TxClient): Promise<CashOperationResult> {
    return this.inTransaction(txClient, async (tx) => {
      const [op] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM cash_operations WHERE id = ${cashOperationId} FOR UPDATE`;
      if (!op) throw new NotFoundError('Cash operation not found');
      const operation = await tx.cashOperation.findUniqueOrThrow({ where: { id: cashOperationId } });

      if (operation.status !== 'PENDING_APPROVAL') throw new ConflictError(`Cash operation is already ${operation.status}`);
      if (operation.requestedBy === approver.id) {
        throw new ForbiddenError('A cash operation must be approved by a different administrator');
      }
      const account = await tx.ledgerAccount.findUnique({ where: { id: operation.accountId } });
      if (account?.customerId === approver.id) {
        throw new ForbiddenError('Staff cannot approve cash operations on their own accounts');
      }
      if (operation.createdAt.getTime() < Date.now() - this.policy.approvalTtlHours * 3600_000) {
        throw new ConflictError('This approval request has expired; reject it and ask the teller to submit a new one');
      }
      // The cash is physically handled by the requesting teller, inside their open session
      await this.requireOpenSession(tx, operation.requestedBy);

      const transaction = await this.postCash(
        tx,
        operation.id,
        { type: operation.type, accountId: operation.accountId, amountInPaise: operation.amount, description: operation.description ?? undefined },
        operation.requestedBy
      );
      await tx.cashOperation.update({
        where: { id: operation.id },
        data: { status: 'EXECUTED', approvedBy: approver.id, decidedAt: new Date(), transactionId: transaction.transactionId },
      });
      await audit(tx, approver.id, `CASH_${operation.type}_APPROVED`, operation.id, {
        requestedBy: operation.requestedBy,
        transactionId: transaction.transactionId,
      });
      return { status: 'EXECUTED', cashOperationId: operation.id, transaction };
    });
  }

  public async rejectCashOperation(cashOperationId: string, actor: AuthenticatedUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.cashOperation.updateMany({
        where: { id: cashOperationId, status: 'PENDING_APPROVAL' },
        data: { status: 'REJECTED', approvedBy: actor.id, decidedAt: new Date() },
      });
      if (result.count !== 1) throw new ConflictError('Cash operation is not pending');
      await audit(tx, actor.id, 'CASH_OPERATION_REJECTED', cashOperationId);
    });
  }

  /** Housekeeping: pending approvals past their TTL are rejected (so they don't linger forever) */
  public async expireStaleApprovals(): Promise<number> {
    const cutoff = new Date(Date.now() - this.policy.approvalTtlHours * 3600_000);
    const result = await this.prisma.cashOperation.updateMany({
      where: { status: 'PENDING_APPROVAL', createdAt: { lt: cutoff } },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });
    if (result.count) logger.info({ expired: result.count }, 'Expired stale cash approvals');
    return result.count;
  }

  public async listCashOperations(status: 'PENDING_APPROVAL' | 'EXECUTED' | 'REJECTED' | undefined, limit: number, offset: number) {
    const rows = await this.prisma.cashOperation.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return rows.map(({ amount, ...rest }) => ({ ...rest, amountInPaise: amount.toString() }));
  }

  /** Posts the double entry: customer account <-> teller drawer */
  private async postCash(tx: TxClient, cashOperationId: string, dto: CashOperationDTO, tellerId: string): Promise<TransactionResult> {
    const isDeposit = dto.type === 'DEPOSIT';
    const owner = await tx.ledgerAccount.findUnique({ where: { id: dto.accountId }, select: { customerId: true } });
    if (!owner) throw new NotFoundError('Account not found');
    if (!isDeposit) await advisoryLock(tx, `customer-outflow:${owner.customerId}`);

    const drawer = await this.drawerFor(tx, tellerId);
    const locked = await lockAccounts(tx, [dto.accountId, drawer.id]);
    const account = locked.find((a) => a.id === dto.accountId) as LockedAccount;
    const drawerRow = locked.find((a) => a.id === drawer.id) as LockedAccount;

    if (!account.is_active || account.closed_at) throw new AccountInactiveError();
    if (!isDeposit) {
      if (account.balance < dto.amountInPaise) throw new InsufficientFundsError();
      await assertWithinDailyLimits(tx, account, dto.amountInPaise, this.policy);
    }

    const transaction = await tx.transaction.create({
      data: {
        referenceId: generateReferenceId(isDeposit ? 'TXN-DEP' : 'TXN-WTH'),
        type: isDeposit ? TransactionType.DEPOSIT : TransactionType.WITHDRAWAL,
        status: TransactionStatus.COMPLETED,
        amount: dto.amountInPaise,
        currency: account.currency,
        ...(isDeposit ? { destinationAccountId: account.id } : { sourceAccountId: account.id }),
        initiatedBy: tellerId,
        description: dto.description || (isDeposit ? 'Cash deposit at branch' : 'Cash withdrawal at branch'),
      },
    });

    // Deposit: cash into the drawer (DEBIT drawer), owed to the customer (CREDIT customer). Withdrawal: reverse.
    await postDoubleEntry(tx, {
      transactionId: transaction.id,
      debit: isDeposit ? drawerRow : account,
      credit: isDeposit ? account : drawerRow,
      amount: dto.amountInPaise,
    });

    await stageTransactionEvent(tx, transaction.id, {
      referenceId: transaction.referenceId,
      type: transaction.type,
      amountInPaise: dto.amountInPaise.toString(),
      currency: transaction.currency,
      ...(isDeposit
        ? { destinationAccountId: account.id, destinationCustomerId: account.customer_id }
        : { sourceAccountId: account.id, sourceCustomerId: account.customer_id }),
      initiatedBy: tellerId,
      cashOperationId,
    });

    return toResult(transaction);
  }
}
