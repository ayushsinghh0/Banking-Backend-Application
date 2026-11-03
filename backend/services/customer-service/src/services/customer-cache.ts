import { CacheLike, NoopCache } from '@banksphere/common';
import { CustomerProfile, KycStatus } from '../../generated/client';

/**
 * Read-through cache for customer reads, on the cache Redis under namespace `customer` (design section 11):
 *
 *   cache:customer:profile:<userId>:v<n>   TTL 5 min   the caller's own profile (GET /customers/me)
 *   cache:customer:kyc:<userId>:v<n>       TTL 60 s    KYC status for account opening (internal API)
 *
 * The design table says both are deleted on a profile update and on a KYC decision. As in the account and
 * ledger caches, that is done by bumping a per-user version that is part of the key
 * (cache:customer:ver:profile:<userId>, cache:customer:ver:kyc:<userId>) once the write has COMMITTED: a
 * reader that loaded the old row just before the commit can only fill a key nobody reads any more, so a
 * stale profile can never outlive the write, which a plain delete racing a slow reader cannot promise.
 *
 * Staff reads are never served from here (each one is access-logged, one row per read), and callers
 * authorize before they read: the only cached profile read is the caller's own, keyed by the token's id.
 */
export const CUSTOMER_CACHE_TTL_SECONDS = { profile: 300, kyc: 60 } as const;

export class CustomerCache {
  constructor(private readonly cache: CacheLike = new NoopCache()) {}

  /**
   * The profile, and whether it came from the cache (`load` did not run in this call; a request that waited
   * for another request's in-flight load counts as a hit too). Shown as the X-Cache-Lookup header.
   */
  public async profile(
    userId: string,
    load: () => Promise<CustomerProfile>
  ): Promise<{ profile: CustomerProfile; fromCache: boolean }> {
    let loaded = false;
    const key = await this.cache.versioned(profileTag(userId), `profile:${userId}`);
    const profile = await this.cache.getOrLoad(
      key,
      () => {
        loaded = true;
        return load();
      },
      { ttlSeconds: CUSTOMER_CACHE_TTL_SECONDS.profile }
    );
    return { profile, fromCache: !loaded };
  }

  public async kycStatus(userId: string, load: () => Promise<KycStatus>): Promise<KycStatus> {
    const key = await this.cache.versioned(kycTag(userId), `kyc:${userId}`);
    return this.cache.getOrLoad(key, load, { ttlSeconds: CUSTOMER_CACHE_TTL_SECONDS.kyc });
  }

  /** After a committed profile change that left the KYC status as it was */
  public async profileChanged(userId: string): Promise<void> {
    await this.cache.bumpVersion(profileTag(userId));
  }

  /** After a committed KYC decision, or an identity change that sent KYC back to PENDING: both views are stale */
  public async kycChanged(userId: string): Promise<void> {
    await this.cache.bumpVersion(profileTag(userId), kycTag(userId));
  }
}

const profileTag = (userId: string) => `profile:${userId}`;
const kycTag = (userId: string) => `kyc:${userId}`;
