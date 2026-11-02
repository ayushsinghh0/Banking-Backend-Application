import crypto from 'crypto';
import { Beneficiary, Prisma, PrismaClient } from '../../generated/client';
import { AuthenticatedUser, ConflictError, HttpError, NotFoundError, RateLimitExceededError } from '@banksphere/common';
import { LedgerPolicy, Refusal, TxClient, advisoryLock, audit, commitThenRefuse, defaultLedgerPolicy, hasStepUp } from './ledger-core';

/** Every audited add attempt counts towards the daily cap, failed lookups included */
const ADD_ATTEMPT_ACTIONS = ['BENEFICIARY_ADDED', 'BENEFICIARY_READDED', 'BENEFICIARY_LOOKUP_FAILED'];

/**
 * Registered payees. A customer can only transfer to their own accounts or to an active beneficiary.
 * A new beneficiary activates after a cooling-off period, or immediately when added from an
 * MFA-authenticated session; either way it is capped during its first 24 hours. Add attempts (adds,
 * re-adds and failed lookups) are capped per customer per rolling day, so the endpoint can't be used to
 * enumerate account numbers, and every add is announced to the customer (beneficiary.added.v1).
 */
export class BeneficiaryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: LedgerPolicy = defaultLedgerPolicy()
  ) {}

  public async add(customer: AuthenticatedUser, accountNumber: string, nickname: string) {
    return commitThenRefuse(
      this.prisma.$transaction(async (tx) => {
        // One add at a time per customer, so parallel requests can't race past the daily cap
        await advisoryLock(tx, `beneficiaries:${customer.id}`);
        const attempts = await tx.auditLog.count({
          where: { actorId: customer.id, action: { in: ADD_ATTEMPT_ACTIONS }, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        });
        if (attempts >= this.policy.maxNewBeneficiariesPerDay) {
          throw new RateLimitExceededError('Too many beneficiaries added today');
        }

        const target = await tx.ledgerAccount.findUnique({ where: { accountNumber } });
        if (!target || target.kind !== 'CUSTOMER' || !target.isActive || target.closedAt) {
          // Committed although refused: failed lookups use up the daily attempts, so probing is capped
          await audit(tx, customer.id, 'BENEFICIARY_LOOKUP_FAILED', accountNumber);
          return new Refusal(new HttpError(422, 'INVALID_DESTINATION', 'This account cannot be added as a beneficiary'));
        }
        if (target.customerId === customer.id) {
          throw new HttpError(400, 'OWN_ACCOUNT', 'Your own accounts do not need to be added as beneficiaries');
        }

        // Immediate only with recent strong authentication on an established factor
        const immediate = hasStepUp(customer, this.policy);
        const activatesAt = immediate ? new Date() : new Date(Date.now() + this.policy.beneficiaryCoolingMinutes * 60_000);
        const existing = await tx.beneficiary.findUnique({
          where: { customerId_accountId: { customerId: customer.id, accountId: target.id } },
        });
        if (existing && !existing.revokedAt) throw new ConflictError('This beneficiary already exists');

        // Re-adding a removed beneficiary restarts the cooling-off period (and its first-day cap)
        const beneficiary = existing
          ? await tx.beneficiary.update({ where: { id: existing.id }, data: { revokedAt: null, nickname, activatesAt } })
          : await tx.beneficiary.create({ data: { customerId: customer.id, accountId: target.id, accountNumber, nickname, activatesAt } });
        await audit(tx, customer.id, existing ? 'BENEFICIARY_READDED' : 'BENEFICIARY_ADDED', beneficiary.id, {
          accountNumber,
          immediate,
          ...(existing && { previouslyRevokedAt: existing.revokedAt?.toISOString() }),
        });
        await this.stageAddedEvent(tx, customer.id, beneficiary, accountNumber);
        return beneficiary;
      })
    );
  }

  /** The customer is told by email, so a payee added from a stolen session doesn't go unnoticed */
  private async stageAddedEvent(tx: TxClient, customerId: string, beneficiary: Beneficiary, accountNumber: string): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateType: 'BENEFICIARY',
        aggregateId: beneficiary.id,
        eventType: 'beneficiary.added.v1',
        payload: {
          eventId: crypto.randomUUID(),
          eventType: 'beneficiary.added.v1',
          timestamp: new Date().toISOString(),
          customerId,
          beneficiaryId: beneficiary.id,
          accountNumberLast4: accountNumber.slice(-4),
          nickname: beneficiary.nickname,
          activatesAt: beneficiary.activatesAt.toISOString(),
        } as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });
  }

  public async list(customer: AuthenticatedUser) {
    return this.prisma.beneficiary.findMany({
      where: { customerId: customer.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async remove(customer: AuthenticatedUser, beneficiaryId: string) {
    // The removal and its audit row commit together
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.beneficiary.updateMany({
        where: { id: beneficiaryId, customerId: customer.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count !== 1) throw new NotFoundError('Beneficiary not found');
      await audit(tx, customer.id, 'BENEFICIARY_REMOVED', beneficiaryId);
    });
  }
}
