import { PrismaClient } from '../../generated/client';
import { AuthenticatedUser, ConflictError, HttpError, NotFoundError, RateLimitExceededError } from '@banksphere/common';
import { LedgerPolicy, audit, defaultLedgerPolicy, hasStepUp } from './ledger-core';

const MAX_NEW_BENEFICIARIES_PER_DAY = Number(process.env.MAX_NEW_BENEFICIARIES_PER_DAY || 10);

/**
 * Registered payees. A customer can only transfer to their own accounts or to an active beneficiary.
 * A new beneficiary activates after a cooling-off period, or immediately when added from an
 * MFA-authenticated session; either way it is capped during its first 24 hours. Additions are rate
 * limited so the endpoint can't be used to enumerate account numbers.
 */
export class BeneficiaryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: LedgerPolicy = defaultLedgerPolicy()
  ) {}

  public async add(customer: AuthenticatedUser, accountNumber: string, nickname: string) {
    const addedToday = await this.prisma.beneficiary.count({
      where: { customerId: customer.id, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    });
    if (addedToday >= MAX_NEW_BENEFICIARIES_PER_DAY) {
      throw new RateLimitExceededError('Too many beneficiaries added today');
    }

    const target = await this.prisma.ledgerAccount.findUnique({ where: { accountNumber } });
    if (!target || target.kind !== 'CUSTOMER' || !target.isActive || target.closedAt) {
      throw new HttpError(422, 'INVALID_DESTINATION', 'This account cannot be added as a beneficiary');
    }
    if (target.customerId === customer.id) {
      throw new HttpError(400, 'OWN_ACCOUNT', 'Your own accounts do not need to be added as beneficiaries');
    }

    // Immediate only with recent strong authentication on an established factor
    const activatesAt = hasStepUp(customer, this.policy)
      ? new Date()
      : new Date(Date.now() + this.policy.beneficiaryCoolingMinutes * 60_000);
    try {
      const beneficiary = await this.prisma.beneficiary.create({
        data: { customerId: customer.id, accountId: target.id, accountNumber, nickname, activatesAt },
      });
      await audit(this.prisma, customer.id, 'BENEFICIARY_ADDED', beneficiary.id, { accountNumber, immediate: activatesAt.getTime() <= Date.now() });
      return beneficiary;
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      // Re-adding a revoked beneficiary restarts the cooling-off period
      const existing = await this.prisma.beneficiary.findUniqueOrThrow({
        where: { customerId_accountId: { customerId: customer.id, accountId: target.id } },
      });
      if (!existing.revokedAt) throw new ConflictError('This beneficiary already exists');
      return this.prisma.beneficiary.update({
        where: { id: existing.id },
        data: { revokedAt: null, nickname, activatesAt },
      });
    }
  }

  public async list(customer: AuthenticatedUser) {
    return this.prisma.beneficiary.findMany({
      where: { customerId: customer.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async remove(customer: AuthenticatedUser, beneficiaryId: string) {
    const result = await this.prisma.beneficiary.updateMany({
      where: { id: beneficiaryId, customerId: customer.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) throw new NotFoundError('Beneficiary not found');
    await audit(this.prisma, customer.id, 'BENEFICIARY_REMOVED', beneficiaryId);
  }
}
