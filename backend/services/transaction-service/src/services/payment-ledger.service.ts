import { Prisma, PrismaClient, Transaction } from '../../generated/client';
import { HttpError, NotFoundError, logger } from '@banksphere/common';
import { TransactionStatus, TransactionType } from '../types';
import { IdempotencyConflictError } from '../errors';
import { LockedAccount, TxClient, lockAccounts, postDoubleEntry, stageTransactionEvent } from './ledger-core';
import { LedgerCommits } from './ledger-commits';

/** The single PAYMENT_CLEARING system account (an asset: money receivable from the payment provider) */
export const PAYMENT_CLEARING_ACCOUNT_NUMBER = 'PAYMENT-CLEARING';
/** initiated_by of the postings payment-service makes on the bank's behalf (refunds and their reversals) */
export const PAYMENT_SERVICE_ACTOR = 'payment-service';

export const topUpReference = (topUpId: string) => `TOPUP-${topUpId}`;
export const refundReference = (refundId: string) => `TOPUP-REFUND-${refundId}`;
export const REFUND_REVERSAL_PREFIX = 'TOPUP-REFUND-REV-';
export const refundReversalReference = (refundId: string) => `${REFUND_REVERSAL_PREFIX}${refundId}`;

export interface TopUpCreditDTO {
  topUpId: string;
  accountId: string;
  customerId: string;
  amountPaise: bigint;
  providerPaymentId: string;
}

export interface TopUpRefundDTO {
  refundId: string;
  topUpId: string;
  accountId: string;
  customerId: string;
  amountPaise: bigint;
}

export interface PaymentPostingResult {
  transactionId: string;
  referenceId: string;
  /** true when this reference was already posted: nothing moved this time */
  replayed: boolean;
}

export interface PaymentAccountView {
  accountId: string;
  customerId: string;
  accountNumberLast4: string;
  isActive: boolean;
  closed: boolean;
}

const notCreditable = () => new HttpError(409, 'ACCOUNT_NOT_CREDITABLE', 'This account cannot receive the top-up (inactive, closed or not the customer’s)');
const accountMismatch = () => new HttpError(409, 'ACCOUNT_MISMATCH', 'The account does not belong to this customer');
const accountClosed = () => new HttpError(409, 'ACCOUNT_CLOSED', 'The account is closed');
const insufficientFunds = () => new HttpError(409, 'INSUFFICIENT_FUNDS', 'The account balance is lower than the refund');
const topUpNotCredited = () =>
  new HttpError(409, 'TOP_UP_NOT_CREDITED', 'This top-up was never credited to this account, so it has nothing to refund');
const refundExceedsTopUp = () => new HttpError(409, 'REFUND_EXCEEDS_TOP_UP', 'Refunds of this top-up would exceed the amount it credited');
const conflictingReplay = (referenceId: string) =>
  new IdempotencyConflictError(`${referenceId} was already posted with different details`);

type Client = TxClient | PrismaClient;

/** Does an existing posting with this reference describe exactly this request? (reads through `client`) */
type SameRequest = (existing: Transaction, client: Client) => boolean | Promise<boolean>;

/**
 * The ledger side of online top-ups (payment-service, design section 6). Postings are double entry against
 * the PAYMENT_CLEARING asset account:
 *
 * - credit:   debit PAYMENT_CLEARING, credit the customer      (ONLINE_TOP_UP, reference TOPUP-<topUpId>)
 * - refund:   debit the customer, credit PAYMENT_CLEARING      (TOP_UP_REFUND, reference TOPUP-REFUND-<refundId>)
 * - reversal: debit PAYMENT_CLEARING, credit the customer      (ONLINE_TOP_UP, reference TOPUP-REFUND-REV-<refundId>)
 *   (the compensation when the provider refuses a refund the ledger already took back)
 *
 * Every posting is idempotent on its reference (the unique transactions.reference_id): a replay returns the
 * original posting with `replayed: true`, a replay with different details is a 409, and concurrent duplicates
 * are serialised by the account row locks (the loser re-checks under the lock, or loses the unique index and
 * replays). Locking order, the balance ceiling and the outbox are the ledger's usual ones. Least privilege:
 * this service can only move money between a customer account and PAYMENT_CLEARING, and only take back what
 * a top-up put in.
 */
export class PaymentLedgerService {
  /** Id of the committed PAYMENT_CLEARING account, once seen (it never changes) */
  private clearingId: string | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly commits: LedgerCommits = new LedgerCommits()
  ) {}

  /** What payment-service may know about a customer account before creating a top-up */
  public async getAccount(accountId: string): Promise<PaymentAccountView> {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account || account.kind !== 'CUSTOMER') throw new NotFoundError('Account not found');
    return {
      accountId: account.id,
      customerId: account.customerId,
      accountNumberLast4: account.accountNumber.slice(-4),
      isActive: account.isActive,
      closed: Boolean(account.closedAt),
    };
  }

  /**
   * Idempotent: creates the PAYMENT_CLEARING account if the migration didn't (fresh or test databases).
   * Called at startup; postings call it too (inside their transaction) until the account has been seen.
   */
  public async ensureClearingAccount(client: Client = this.prisma): Promise<{ id: string }> {
    const existing = await client.ledgerAccount.findUnique({ where: { accountNumber: PAYMENT_CLEARING_ACCOUNT_NUMBER } });
    if (existing) {
      if (existing.kind !== 'PAYMENT_CLEARING') {
        throw new Error(`Ledger account ${PAYMENT_CLEARING_ACCOUNT_NUMBER} exists with kind ${existing.kind}`);
      }
      // Seen as existing, so it is committed (one created below may still roll back with its transaction)
      this.clearingId = existing.id;
      return existing;
    }
    try {
      return await client.ledgerAccount.create({
        data: {
          kind: 'PAYMENT_CLEARING',
          customerId: 'BANK',
          accountNumber: PAYMENT_CLEARING_ACCOUNT_NUMBER,
          currency: 'INR',
          dailyLimit: 900_000_000_000_000_000n,
          isActive: true,
        },
      });
    } catch (err: any) {
      // Created concurrently (another replica's startup): use that one
      if (err?.code !== 'P2002') throw err;
      return client.ledgerAccount.findUniqueOrThrow({ where: { accountNumber: PAYMENT_CLEARING_ACCOUNT_NUMBER } });
    }
  }

  /**
   * Credits a captured top-up. 409 ACCOUNT_NOT_CREDITABLE if the account is inactive (frozen), closed, not
   * in INR or not the customer's; 404 if there is no such customer account; 422 BALANCE_LIMIT above the
   * balance ceiling.
   */
  public async credit(dto: TopUpCreditDTO): Promise<PaymentPostingResult> {
    const referenceId = topUpReference(dto.topUpId);
    const same: SameRequest = (t) =>
      t.type === TransactionType.ONLINE_TOP_UP &&
      t.destinationAccountId === dto.accountId &&
      t.amount === dto.amountPaise &&
      t.topUpId === dto.topUpId &&
      t.externalReference === dto.providerPaymentId &&
      t.initiatedBy === dto.customerId;

    return this.post(referenceId, same, async (tx, replay) => {
      const { account, clearingRow } = await this.lock(tx, dto.accountId, await this.clearingAccountId(tx));
      const replayed = await replay(tx);
      if (replayed) return replayed;

      if (!account) throw new NotFoundError('Account not found');
      if (account.customer_id !== dto.customerId || !account.is_active || account.closed_at || account.currency !== 'INR') {
        throw notCreditable();
      }

      const transaction = await tx.transaction.create({
        data: {
          referenceId,
          type: TransactionType.ONLINE_TOP_UP,
          status: TransactionStatus.COMPLETED,
          amount: dto.amountPaise,
          currency: account.currency,
          destinationAccountId: account.id,
          initiatedBy: dto.customerId,
          topUpId: dto.topUpId,
          externalReference: dto.providerPaymentId,
          description: 'Money added online',
        },
      });
      await postDoubleEntry(tx, {
        transactionId: transaction.id,
        type: TransactionType.ONLINE_TOP_UP,
        debit: clearingRow,
        credit: account,
        amount: dto.amountPaise,
      });
      await stageTransactionEvent(tx, transaction.id, account.id, {
        referenceId,
        type: TransactionType.ONLINE_TOP_UP,
        amountInPaise: dto.amountPaise.toString(),
        currency: transaction.currency,
        destinationAccountId: account.id,
        destinationCustomerId: account.customer_id,
        initiatedBy: dto.customerId,
        topUpId: dto.topUpId,
      });
      return { transactionId: transaction.id, referenceId, replayed: false };
    });
  }

  /**
   * Takes a refunded top-up back from the customer. Bank-initiated, so no daily outflow limit applies (and
   * it doesn't use up the customer's allowance), but it never overdraws: 409 INSUFFICIENT_FUNDS. Allowed on
   * a frozen account (the money returns to the payment method it came from), never on a closed one. The
   * ledger also checks that the top-up was credited to this account and that its refunds, net of reversals,
   * never exceed what it credited.
   */
  public async refund(dto: TopUpRefundDTO): Promise<PaymentPostingResult> {
    const referenceId = refundReference(dto.refundId);
    const same: SameRequest = async (t, client) =>
      t.type === TransactionType.TOP_UP_REFUND &&
      t.sourceAccountId === dto.accountId &&
      t.amount === dto.amountPaise &&
      t.topUpId === dto.topUpId &&
      (await this.ownerOf(client, t.sourceAccountId)) === dto.customerId;

    return this.post(referenceId, same, async (tx, replay) => {
      const { account, clearingRow } = await this.lock(tx, dto.accountId, await this.clearingAccountId(tx));
      const replayed = await replay(tx);
      if (replayed) return replayed;

      if (!account) throw new NotFoundError('Account not found');
      if (account.customer_id !== dto.customerId) throw accountMismatch();
      const credit = await tx.transaction.findUnique({ where: { referenceId: topUpReference(dto.topUpId) } });
      if (!credit || credit.type !== TransactionType.ONLINE_TOP_UP || credit.destinationAccountId !== account.id) {
        throw topUpNotCredited();
      }
      if (account.closed_at) throw accountClosed();
      // Under the account row lock, so concurrent refunds of one top-up see each other
      const alreadyRefunded = await this.netRefunded(tx, dto.topUpId);
      if (alreadyRefunded + dto.amountPaise > credit.amount) throw refundExceedsTopUp();
      if (account.balance < dto.amountPaise) throw insufficientFunds();

      const transaction = await tx.transaction.create({
        data: {
          referenceId,
          type: TransactionType.TOP_UP_REFUND,
          status: TransactionStatus.COMPLETED,
          amount: dto.amountPaise,
          currency: account.currency,
          sourceAccountId: account.id,
          initiatedBy: PAYMENT_SERVICE_ACTOR,
          topUpId: dto.topUpId,
          description: 'Top-up refunded to the original payment method',
        },
      });
      await postDoubleEntry(tx, {
        transactionId: transaction.id,
        type: TransactionType.TOP_UP_REFUND,
        debit: account,
        credit: clearingRow,
        amount: dto.amountPaise,
      });
      await stageTransactionEvent(tx, transaction.id, account.id, {
        referenceId,
        type: TransactionType.TOP_UP_REFUND,
        amountInPaise: dto.amountPaise.toString(),
        currency: transaction.currency,
        sourceAccountId: account.id,
        sourceCustomerId: account.customer_id,
        initiatedBy: PAYMENT_SERVICE_ACTOR,
        topUpId: dto.topUpId,
        refundId: dto.refundId,
      });
      return { transactionId: transaction.id, referenceId, replayed: false };
    });
  }

  /**
   * Compensation for a refund the provider refused: gives the customer the refunded amount back (debit
   * PAYMENT_CLEARING, credit the customer, typed ONLINE_TOP_UP because it is top-up money coming back).
   * Idempotent; 404 REFUND_NOT_FOUND when that refund was never posted (nothing to compensate). Works on a
   * frozen account; a closed one is refused (409 ACCOUNT_CLOSED) for a person to resolve. A refund id is
   * single-use: after a reversal, refunding the top-up again needs a new refund id.
   */
  public async reverseRefund(refundId: string): Promise<PaymentPostingResult> {
    const refund = await this.prisma.transaction.findUnique({ where: { referenceId: refundReference(refundId) } });
    if (!refund || refund.type !== TransactionType.TOP_UP_REFUND || !refund.sourceAccountId) {
      throw new HttpError(404, 'REFUND_NOT_FOUND', 'No refund was posted with this id');
    }
    const accountId = refund.sourceAccountId;
    const referenceId = refundReversalReference(refundId);
    const same: SameRequest = (t) =>
      t.type === TransactionType.ONLINE_TOP_UP &&
      t.destinationAccountId === accountId &&
      t.amount === refund.amount &&
      t.topUpId === refund.topUpId;

    return this.post(referenceId, same, async (tx, replay) => {
      const { account, clearingRow } = await this.lock(tx, accountId, await this.clearingAccountId(tx));
      const replayed = await replay(tx);
      if (replayed) return replayed;

      if (!account) throw new NotFoundError('Account not found');
      if (account.closed_at) {
        logger.error({ refundId, accountId, alert: 'TOP_UP_REFUND_REVERSAL_ON_CLOSED_ACCOUNT' }, 'A refund reversal targets a closed account: resolve it manually');
        throw accountClosed();
      }

      const transaction = await tx.transaction.create({
        data: {
          referenceId,
          type: TransactionType.ONLINE_TOP_UP,
          status: TransactionStatus.COMPLETED,
          amount: refund.amount,
          currency: account.currency,
          destinationAccountId: account.id,
          initiatedBy: PAYMENT_SERVICE_ACTOR,
          topUpId: refund.topUpId,
          description: 'Top-up refund reversed (the refund did not go through)',
        },
      });
      await postDoubleEntry(tx, {
        transactionId: transaction.id,
        type: TransactionType.ONLINE_TOP_UP,
        debit: clearingRow,
        credit: account,
        amount: refund.amount,
      });
      await stageTransactionEvent(tx, transaction.id, account.id, {
        referenceId,
        type: TransactionType.ONLINE_TOP_UP,
        amountInPaise: refund.amount.toString(),
        currency: transaction.currency,
        destinationAccountId: account.id,
        destinationCustomerId: account.customer_id,
        initiatedBy: PAYMENT_SERVICE_ACTOR,
        topUpId: refund.topUpId,
        refundId,
      });
      return { transactionId: transaction.id, referenceId, replayed: false };
    });
  }

  /** Refunded so far for a top-up, minus the refunds that were reversed. Served by transactions(top_up_id). */
  private async netRefunded(tx: TxClient, topUpId: string): Promise<bigint> {
    const [refunded, reversed] = await Promise.all([
      tx.transaction.aggregate({ _sum: { amount: true }, where: { topUpId, type: TransactionType.TOP_UP_REFUND } }),
      tx.transaction.aggregate({
        _sum: { amount: true },
        where: { topUpId, type: TransactionType.ONLINE_TOP_UP, referenceId: { startsWith: REFUND_REVERSAL_PREFIX } },
      }),
    ]);
    return (refunded._sum.amount ?? 0n) - (reversed._sum.amount ?? 0n);
  }

  private async ownerOf(client: Client, accountId: string | null): Promise<string | null> {
    if (!accountId) return null;
    const account = await client.ledgerAccount.findUnique({ where: { id: accountId }, select: { customerId: true } });
    return account?.customerId ?? null;
  }

  private async clearingAccountId(tx: TxClient): Promise<string> {
    return this.clearingId ?? (await this.ensureClearingAccount(tx)).id;
  }

  /** Customer account and clearing account, row-locked in the ledger's global (ascending id) order */
  private async lock(tx: TxClient, accountId: string, clearingId: string): Promise<{ account?: LockedAccount; clearingRow: LockedAccount }> {
    const rows = await lockAccounts(tx, [accountId, clearingId]);
    const account = rows.find((a) => a.id === accountId && a.kind === 'CUSTOMER');
    const clearingRow = rows.find((a) => a.id === clearingId);
    if (!clearingRow || clearingRow.kind !== 'PAYMENT_CLEARING') throw new Error('PAYMENT_CLEARING account is missing');
    return { account, clearingRow };
  }

  /**
   * Idempotent posting on `referenceId`: an existing posting is replayed (fast path without locks, and again
   * under the row locks inside `work` for a concurrent duplicate), or refused if it differs. The transaction
   * runs in LedgerCommits.run, so cached balances and history are invalidated once it commits.
   */
  private async post(
    referenceId: string,
    same: SameRequest,
    work: (tx: TxClient, replay: (client: Client) => Promise<PaymentPostingResult | null>) => Promise<PaymentPostingResult>
  ): Promise<PaymentPostingResult> {
    const replay = async (client: Client): Promise<PaymentPostingResult | null> => {
      const existing = await client.transaction.findUnique({ where: { referenceId } });
      if (!existing) return null;
      if (!(await same(existing, client))) throw conflictingReplay(referenceId);
      return { transactionId: existing.id, referenceId, replayed: true };
    };

    const earlier = await replay(this.prisma);
    if (earlier) return earlier;
    try {
      return await this.commits.run(() =>
        this.prisma.$transaction((tx) => work(tx, replay), {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 10_000,
          timeout: 15_000,
        })
      );
    } catch (err: any) {
      // Lost the race on the unique reference to a concurrent duplicate that committed first
      if (err?.code === 'P2002') {
        const winner = await replay(this.prisma);
        if (winner) return winner;
      }
      throw err;
    }
  }
}
