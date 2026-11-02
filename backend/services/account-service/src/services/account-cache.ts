import { CacheLike, NoopCache } from '@banksphere/common';
import { BankAccount } from '../../generated/client';

/**
 * A customer's account list (account metadata only: numbers, type, status, limits, versions; balances live
 * in the ledger and are never cached here), on the cache Redis under namespace `account` (design section 11):
 *
 *   cache:account:list:<customerId>:v<version>   TTL 5 min
 *
 * The version (cache:account:ver:cust:<customerId>) is bumped AFTER every committed change to one of the
 * customer's accounts (opening, status, limit, control version), so a reader can never cache a list older
 * than a committed write under the current version, and a slow reader that loaded before the write can only
 * fill a key nobody reads any more. Callers authorize (and record staff access) themselves.
 */
export const ACCOUNT_LIST_TTL_SECONDS = 300;

export class AccountListCache {
  constructor(
    private readonly cache: CacheLike = new NoopCache(),
    private readonly ttlSeconds = ACCOUNT_LIST_TTL_SECONDS
  ) {}

  public async list(customerId: string, load: () => Promise<BankAccount[]>): Promise<BankAccount[]> {
    const key = await this.cache.versioned(tag(customerId), `list:${customerId}`);
    return this.cache.getOrLoad(key, load, { ttlSeconds: this.ttlSeconds });
  }

  /** Call after the change has committed */
  public async changed(customerId: string): Promise<void> {
    await this.cache.bumpVersion(tag(customerId));
  }
}

const tag = (customerId: string) => `cust:${customerId}`;
