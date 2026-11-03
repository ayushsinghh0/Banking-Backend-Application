import { PrismaClient, Prisma, CustomerProfile, KycStatus } from '../../generated/client';
import { AuthenticatedUser, ConflictError, ForbiddenError, HttpError, NotFoundError } from '@banksphere/common';
import { CustomerCache } from './customer-cache';

export interface CreateProfileDTO {
  userId: string;
  fullName: string;
  phoneNumber: string;
  address?: string;
  dateOfBirth?: Date;
}

export interface UpdateProfileDTO {
  fullName?: string;
  phoneNumber?: string;
  address?: string;
  dateOfBirth?: Date;
}

/** Staff search: optional KYC status, and q = an exact user id (UUID) or part of a name / phone number */
export interface StaffProfileFilter {
  kycStatus?: KycStatus;
  q?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CustomerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache: CustomerCache = new CustomerCache()
  ) {}

  /**
   * The caller's own profile, read through the cache (see CustomerCache). A missing profile is a 404 and is
   * never cached, so creating one needs no invalidation.
   */
  public async getProfileByUserId(
    userId: string
  ): Promise<{ profile: CustomerProfile; fromCache: boolean }> {
    return this.cache.profile(userId, async () => {
      const profile = await this.prisma.customerProfile.findUnique({ where: { userId } });
      if (!profile) throw new NotFoundError('Customer profile not found');
      return profile;
    });
  }

  /**
   * Creates a new customer profile
   */
  public async createProfile(dto: CreateProfileDTO): Promise<CustomerProfile> {
    const existing = await this.prisma.customerProfile.findUnique({
      where: { userId: dto.userId },
    });

    if (existing) {
      throw new ConflictError('A profile already exists for this customer');
    }

    const profile = await this.prisma.customerProfile.create({
      data: {
        userId: dto.userId,
        fullName: dto.fullName,
        phoneNumber: dto.phoneNumber,
        address: dto.address,
        dateOfBirth: dto.dateOfBirth,
      },
    });

    return profile;
  }

  /**
   * Updates the caller's own profile under a row lock. Every change bumps the profile version, so a KYC
   * review in progress no longer matches. Identity fields that KYC vouched for (full name, date of birth,
   * address) can still be corrected, but doing so sends a VERIFIED/REJECTED profile back to PENDING.
   */
  public async updateProfile(userId: string, dto: UpdateProfileDTO): Promise<CustomerProfile> {
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customer_profiles WHERE user_id = ${userId} FOR UPDATE`;
      const existing = await tx.customerProfile.findUnique({ where: { userId } });
      if (!existing) {
        throw new NotFoundError('Customer profile not found');
      }

      const nameChanged = dto.fullName !== undefined && dto.fullName !== existing.fullName;
      const dobChanged =
        dto.dateOfBirth !== undefined &&
        (existing.dateOfBirth?.getTime() ?? null) !== (dto.dateOfBirth?.getTime() ?? null);
      const addressChanged = dto.address !== undefined && dto.address !== existing.address;
      const identityChanged = nameChanged || dobChanged || addressChanged;
      const resetKyc = identityChanged && existing.kycStatus !== KycStatus.PENDING;

      const result = await tx.customerProfile.update({
        where: { userId },
        data: {
          ...(dto.fullName && { fullName: dto.fullName }),
          ...(dto.phoneNumber && { phoneNumber: dto.phoneNumber }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(dto.dateOfBirth !== undefined && { dateOfBirth: dto.dateOfBirth }),
          ...(resetKyc && { kycStatus: KycStatus.PENDING }),
          version: { increment: 1 },
        },
      });

      if (identityChanged) {
        await tx.kycEvent.create({
          data: {
            userId,
            actorId: userId,
            action: resetKyc ? 'IDENTITY_CHANGED_KYC_RESET' : 'IDENTITY_CHANGED',
            fromStatus: existing.kycStatus,
            toStatus: result.kycStatus,
            details: {
              ...(nameChanged && { fullName: { from: existing.fullName, to: dto.fullName } }),
              ...(dobChanged && {
                dateOfBirth: { from: existing.dateOfBirth?.toISOString() ?? null, to: dto.dateOfBirth?.toISOString() ?? null },
              }),
              ...(addressChanged && { address: { from: existing.address, to: dto.address } }),
            },
          },
        });
      }
      return { result, resetKyc };
    });

    // After the commit: an identity change that sent KYC back to PENDING also makes the KYC view stale
    if (updated.resetKyc) await this.cache.kycChanged(userId);
    else await this.cache.profileChanged(userId);
    return updated.result;
  }

  /**
   * KYC status for account-opening decisions, cached for 60 s and invalidated after every committed decision
   * or KYC reset, so a reader never sees a status older than the last commit. Customers without a profile are
   * reported as PENDING.
   */
  public async getKycStatus(userId: string): Promise<KycStatus> {
    return this.cache.kycStatus(userId, async () => {
      const profile = await this.prisma.customerProfile.findUnique({
        where: { userId },
        select: { kycStatus: true },
      });
      return profile?.kycStatus ?? KycStatus.PENDING;
    });
  }

  /**
   * KYC review outcome, set by a KYC officer. The decision applies only to the exact profile version the
   * officer reviewed (compare-and-set): if the customer changed anything meanwhile, it is refused and must
   * be re-reviewed. Staff never decide their own KYC; every decision is recorded in kyc_events.
   */
  public async updateKycStatus(
    actor: AuthenticatedUser,
    userId: string,
    kycStatus: KycStatus,
    expectedVersion: number
  ): Promise<CustomerProfile> {
    if (actor.id === userId) {
      throw new ForbiddenError('Staff cannot review their own KYC');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.customerProfile.findUnique({ where: { userId } });
      if (!existing) {
        throw new NotFoundError('Customer profile not found');
      }
      const result = await tx.customerProfile.updateMany({
        where: { userId, version: expectedVersion },
        data: { kycStatus, version: { increment: 1 } },
      });
      if (result.count !== 1) {
        throw new HttpError(409, 'PROFILE_CHANGED', 'The profile changed since it was reviewed; reload and review it again');
      }
      await tx.kycEvent.create({
        data: {
          userId,
          actorId: actor.id,
          action: 'KYC_DECISION',
          fromStatus: existing.kycStatus,
          toStatus: kycStatus,
          details: { reviewedVersion: expectedVersion },
        },
      });
      return tx.customerProfile.findUniqueOrThrow({ where: { userId } });
    });

    await this.cache.kycChanged(userId);
    return updated;
  }

  /** Staff read of a customer's profile: always served from the database and recorded */
  public async getProfileForStaff(actor: AuthenticatedUser, userId: string): Promise<CustomerProfile> {
    const profile = await this.prisma.customerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundError('Customer profile not found');
    await this.prisma.staffAccessLog.create({
      data: { actorId: actor.id, actorRole: actor.role, userId, action: 'VIEW_PROFILE' },
    });
    return profile;
  }

  /**
   * Staff search over customer profiles, always served from the database. PENDING is the KYC review queue
   * (oldest first); anything else is newest first. Every profile returned is recorded first (one row each).
   */
  public async listProfilesForStaff(
    actor: AuthenticatedUser,
    filter: StaffProfileFilter,
    page: { limit: number; offset: number }
  ): Promise<CustomerProfile[]> {
    const where: Prisma.CustomerProfileWhereInput = {};
    if (filter.kycStatus) where.kycStatus = filter.kycStatus;
    if (filter.q) {
      if (UUID_PATTERN.test(filter.q)) {
        where.userId = filter.q.toLowerCase();
      } else {
        where.OR = [{ fullName: { contains: filter.q, mode: 'insensitive' } }, { phoneNumber: { contains: filter.q } }];
      }
    }
    const direction = filter.kycStatus === KycStatus.PENDING ? 'asc' : 'desc';
    const profiles = await this.prisma.customerProfile.findMany({
      where,
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: page.limit,
      skip: page.offset,
    });
    if (profiles.length) {
      await this.prisma.staffAccessLog.createMany({
        data: profiles.map((p) => ({ actorId: actor.id, actorRole: actor.role, userId: p.userId, action: 'LIST_CUSTOMERS' })),
      });
    }
    return profiles;
  }

  /** Staff read of a customer's KYC trail (it carries identity data: names, dates of birth, addresses): recorded */
  public async getKycHistory(actor: AuthenticatedUser, userId: string) {
    const events = await this.prisma.kycEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
    await this.prisma.staffAccessLog.create({
      data: { actorId: actor.id, actorRole: actor.role, userId, action: 'VIEW_KYC_HISTORY' },
    });
    return events;
  }
}
