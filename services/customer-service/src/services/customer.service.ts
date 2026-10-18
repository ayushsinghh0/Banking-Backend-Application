import { PrismaClient, CustomerProfile, KycStatus } from '../../generated/client';
import Redis from 'ioredis';
import { AuthenticatedUser, ConflictError, ForbiddenError, HttpError, NotFoundError, logger } from '@banksphere/common';

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

export class CustomerService {
  private readonly cacheTTLSeconds: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    cacheTTLSeconds = 1800 // 30 minutes default TTL
  ) {
    this.cacheTTLSeconds = cacheTTLSeconds;
  }

  private getCacheKey(userId: string): string {
    return `customer:profile:${userId}`;
  }

  /**
   * CACHE-ASIDE PATTERN:
   * 1. Query Redis cache first.
   * 2. On Cache Hit: return cached JSON immediately.
   * 3. On Cache Miss: query PostgreSQL, populate Redis, and return result.
   */
  public async getProfileByUserId(
    userId: string
  ): Promise<{ profile: CustomerProfile; fromCache: boolean }> {
    const cacheKey = this.getCacheKey(userId);

    // 1. Check Redis cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        // Re-hydrate Date objects
        if (parsed.dateOfBirth) parsed.dateOfBirth = new Date(parsed.dateOfBirth);
        if (parsed.createdAt) parsed.createdAt = new Date(parsed.createdAt);
        if (parsed.updatedAt) parsed.updatedAt = new Date(parsed.updatedAt);
        return { profile: parsed, fromCache: true };
      }
    } catch (cacheErr) {
      // Non-blocking cache error: log and fallback directly to Postgres
      logger.warn({ err: cacheErr }, 'Redis cache read failed, falling back to database');
    }

    // 2. Query PostgreSQL
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new NotFoundError('Customer profile not found');
    }

    // 3. Populate Redis asynchronously with TTL
    try {
      await this.redis.set(cacheKey, JSON.stringify(profile), 'EX', this.cacheTTLSeconds);
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, 'Redis cache write failed');
    }

    return { profile, fromCache: false };
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

    // Populate cache
    try {
      await this.redis.set(
        this.getCacheKey(dto.userId),
        JSON.stringify(profile),
        'EX',
        this.cacheTTLSeconds
      );
    } catch {}

    return profile;
  }

  /**
   * CACHE INVALIDATION ON MUTATION:
   * When profile fields update in PostgreSQL, immediately purge the stale Redis cache entry.
   */
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
      return result;
    });

    await this.invalidateCache(userId);
    return updated;
  }

  private async invalidateCache(userId: string): Promise<void> {
    try {
      await this.redis.del(this.getCacheKey(userId));
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, 'Redis cache invalidation failed');
    }
  }

  /**
   * Authoritative KYC status (bypasses the cache: used for account-opening decisions).
   * Customers without a profile are reported as PENDING.
   */
  public async getKycStatus(userId: string): Promise<KycStatus> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
      select: { kycStatus: true },
    });
    return profile?.kycStatus ?? KycStatus.PENDING;
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

    await this.invalidateCache(userId);
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

  public async getKycHistory(userId: string) {
    return this.prisma.kycEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
}
