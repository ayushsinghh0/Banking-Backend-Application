import { CacheLike, NoopCache } from '@banksphere/common';

/**
 * Read-through cache for ledger reads (cache Redis, namespace `ledger`; see design section 11):
 *
 * | key                                         | TTL    | invalidation                                     |
 * |---------------------------------------------|--------|--------------------------------------------------|
 * | cache:ledger:acct:<id>  (owner, kind)        | 10 min | never changes; deleted when the account closes   |
 * | cache:ledger:bal:<id>:v<ver>                 | 30 s   | cache:ledger:ver:<id> bumped after every commit   |
 * | cache:ledger:hist:<id>:v<ver>:<limit>:<off>  | 60 s   | same version key (first pages only)              |
 *
 * The version is bumped only AFTER the posting's transaction has committed (LedgerCommits), so a reader
 * that sees the new version reads the committed data, and one that read the old version can only fill a
 * key nobody reads any more. Nothing here is ever called inside a database transaction, and callers
 * authorize the request before reading.
 */
export const LEDGER_CACHE_TTL_SECONDS = { account: 600, balance: 30, history: 60 } as const;

/** History pages are cached only near the top of the statement (what screens actually show) */
export const HISTORY_CACHE_DEPTH = 100;

/** What authorization needs about an account; none of it ever changes */
export interface LedgerAccountMeta {
  id: string;
  customerId: string;
  kind: string;
  currency: string;
}

export class LedgerReadCache {
  constructor(private readonly cache: CacheLike = new NoopCache()) {}

  /** Owner and kind of an account, or null if there is no such account (a miss is never cached) */
  public async account(accountId: string, load: () => Promise<LedgerAccountMeta | null>): Promise<LedgerAccountMeta | null> {
    const meta = await this.cache.getOrLoad<LedgerAccountMeta | undefined>(
      `acct:${accountId}`,
      async () => (await load()) ?? undefined,
      { ttlSeconds: LEDGER_CACHE_TTL_SECONDS.account }
    );
    return meta ?? null;
  }

  public async balance(accountId: string, load: () => Promise<bigint | null>): Promise<bigint | null> {
    const key = await this.cache.versioned(accountId, `bal:${accountId}`);
    const balance = await this.cache.getOrLoad<bigint | undefined>(key, async () => (await load()) ?? undefined, {
      ttlSeconds: LEDGER_CACHE_TTL_SECONDS.balance,
    });
    return balance ?? null;
  }

  public async history<T>(accountId: string, limit: number, offset: number, load: () => Promise<T>): Promise<T> {
    if (offset + limit > HISTORY_CACHE_DEPTH) return load();
    const key = `${await this.cache.versioned(accountId, `hist:${accountId}`)}:${limit}:${offset}`;
    return this.cache.getOrLoad(key, load, { ttlSeconds: LEDGER_CACHE_TTL_SECONDS.history });
  }

  /** After a commit that posted to these accounts: every cached balance and history page of them is stale */
  public async accountsChanged(accountIds: string[]): Promise<void> {
    if (accountIds.length) await this.cache.bumpVersion(...accountIds);
  }

  /** After an account was closed (committed) */
  public async accountClosed(accountId: string): Promise<void> {
    await this.cache.invalidate(`acct:${accountId}`);
    await this.cache.bumpVersion(accountId);
  }
}
