import { logger } from '@banksphere/common';
import { conversationsPurged, retentionRuns } from '../metrics';
import { ConversationStore } from '../store/conversation-store';

export const RETENTION_LEASE = 'assistant-retention';

export interface RetentionOptions {
  retentionDays: number;
  /** Conversations deleted per statement */
  batchSize?: number;
  /** Stop starting new batches after this long (well inside the lease) */
  budgetMs?: number;
  leaseSeconds?: number;
  now?: () => Date;
}

export interface PurgeReport {
  cutoff: string;
  deleted: number;
  /** The time budget ran out before everything past retention was gone; the next run continues */
  truncated: boolean;
  durationMs: number;
}

type RetentionStore = Pick<ConversationStore, 'purgeConversations' | 'acquireLease' | 'releaseLease'>;

/**
 * Conversations are kept for ASSISTANT_RETENTION_DAYS after their last message, then deleted with their messages
 * (design section 7). Runs periodically on one replica, under a job lease, in bounded batches.
 */
export class RetentionJob {
  private running = false;
  private readonly batchSize: number;
  private readonly budgetMs: number;
  private readonly leaseSeconds: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: RetentionStore,
    private readonly options: RetentionOptions
  ) {
    this.batchSize = options.batchSize ?? 500;
    this.budgetMs = options.budgetMs ?? 60_000;
    this.leaseSeconds = options.leaseSeconds ?? 300;
    this.now = options.now ?? (() => new Date());
  }

  /** The periodic run: null unless this replica holds the lease (and isn't already running) */
  public async runScheduled(): Promise<PurgeReport | null> {
    if (this.running) return null;
    if (!(await this.store.acquireLease(RETENTION_LEASE, this.leaseSeconds))) {
      retentionRuns.inc({ result: 'skipped' });
      return null;
    }
    this.running = true;
    try {
      const report = await this.purge();
      retentionRuns.inc({ result: 'ok' });
      return report;
    } catch (error) {
      retentionRuns.inc({ result: 'error' });
      throw error;
    } finally {
      this.running = false;
      await this.store.releaseLease(RETENTION_LEASE).catch((err) => logger.warn({ err }, 'Could not release the retention lease'));
    }
  }

  /** Deletes everything past retention (within the time budget), regardless of the lease */
  public async purge(): Promise<PurgeReport> {
    const started = Date.now();
    const cutoff = new Date(this.now().getTime() - this.options.retentionDays * 86_400_000);
    let deleted = 0;
    let truncated = false;
    for (;;) {
      const count = await this.store.purgeConversations(cutoff, this.batchSize);
      deleted += count;
      if (count < this.batchSize) break;
      if (Date.now() - started >= this.budgetMs) {
        truncated = true;
        break;
      }
    }
    if (deleted > 0) conversationsPurged.inc(deleted);
    const report: PurgeReport = { cutoff: cutoff.toISOString(), deleted, truncated, durationMs: Date.now() - started };
    logger[deleted > 0 || truncated ? 'info' : 'debug'](report, 'Assistant conversations past retention removed');
    return report;
  }

  /** Runs soon after start-up, then every `intervalMs`; returns the function that stops it */
  public start(intervalMs: number): () => void {
    const tick = () => {
      this.runScheduled().catch((err) => logger.error({ err, alert: 'ASSISTANT_RETENTION_ERROR' }, 'Assistant retention run failed'));
    };
    const first = setTimeout(tick, Math.min(intervalMs, 30_000));
    const timer = setInterval(tick, intervalMs);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }
}
