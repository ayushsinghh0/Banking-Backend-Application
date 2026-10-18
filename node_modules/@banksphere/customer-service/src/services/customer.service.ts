import { PrismaClient, CustomerProfile } from '../generated/client';
import Redis from 'ioredis';
import { NotFoundError, ConflictError } from '@banksphere/common';

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
      console.warn('[CustomerService] Redis cache read failed, falling back to database', cacheErr);
    }

    // 2. Query PostgreSQL
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new NotFoundError(`Customer profile not found for user '${userId}'`);
    }

    // 3. Populate Redis asynchronously with TTL
    try {
      await this.redis.set(cacheKey, JSON.stringify(profile), 'EX', this.cacheTTLSeconds);
    } catch (cacheErr) {
      console.warn('[CustomerService] Redis cache write failed', cacheErr);
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
  public async updateProfile(userId: string, dto: UpdateProfileDTO): Promise<CustomerProfile> {
    const existing = await this.prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (!existing) {
      throw new NotFoundError(`Customer profile not found for user '${userId}'`);
    }

    const updated = await this.prisma.customerProfile.update({
      where: { userId },
      data: {
        ...(dto.fullName && { fullName: dto.fullName }),
        ...(dto.phoneNumber && { phoneNumber: dto.phoneNumber }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.dateOfBirth !== undefined && { dateOfBirth: dto.dateOfBirth }),
      },
    });

    // CACHE INVALIDATION: Delete stale key from Redis
    try {
      await this.redis.del(this.getCacheKey(userId));
    } catch (cacheErr) {
      console.warn('[CustomerService] Redis cache invalidation failed', cacheErr);
    }

    return updated;
  }
}
