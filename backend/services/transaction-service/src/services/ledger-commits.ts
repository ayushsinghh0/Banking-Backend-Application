import { AsyncLocalStorage } from 'async_hooks';
import { counter } from '@banksphere/common';
import { LedgerReadCache } from './ledger-cache';

const postingsTotal = counter('ledger_postings_total', 'Ledger postings committed, by transaction type', ['type']);

/** The postings made inside one database transaction, applied once it has committed */
class PostingLog {
  readonly accounts = new Set<string>();
  readonly types: string[] = [];
}

const currentLog = new AsyncLocalStorage<PostingLog>();

/**
 * Records a posting made by the current transaction. Every posting goes through postDoubleEntry, which
 * calls this; outside LedgerCommits.run it throws, so a posting path that would skip cache invalidation
 * (or the postings metric) can't exist: it fails, and rolls back, the first time a test runs it.
 */
export function notePosting(type: string, accountIds: string[]): void {
  const log = currentLog.getStore();
  if (!log) throw new Error('Ledger posting outside LedgerCommits.run: wrap the database transaction that posts it');
  log.types.push(type);
  for (const id of accountIds) log.accounts.add(id);
}

/**
 * Runs a database transaction that may post to the ledger and, only once it has COMMITTED, applies what
 * its postings imply outside the database: the cache versions of every account they touched are bumped
 * and `ledger_postings_total{type}` is counted. A rollback throws past this point, so nothing is bumped
 * or counted for it. Wrap the whole `$transaction` call:
 *
 *   commits.run(() => prisma.$transaction(async (tx) => { ...postDoubleEntry(tx, ...)... }))
 */
export class LedgerCommits {
  constructor(readonly readCache: LedgerReadCache = new LedgerReadCache()) {}

  public async run<T>(transaction: () => Promise<T>): Promise<T> {
    const log = new PostingLog();
    const result = await currentLog.run(log, transaction);
    for (const type of log.types) postingsTotal.inc({ type });
    await this.readCache.accountsChanged([...log.accounts]);
    return result;
  }
}
