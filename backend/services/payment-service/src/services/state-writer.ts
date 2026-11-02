import { logger } from '@banksphere/common';
import { TopUp } from '../domain/types';
import { topUpTransitions } from '../metrics';
import { PaymentStore, TransitionRequest } from '../store/payment-store';

/** Bounded re-read/re-decide loops: a guard that keeps failing means heavy contention, not something to spin on */
export const MAX_CAS_ATTEMPTS = 5;

/**
 * Applies status transitions through the store's compare-and-set and records each committed change
 * (metric + log line). Returns null when the guard failed, i.e. someone else moved the top-up first.
 */
export class StateWriter {
  constructor(private readonly store: PaymentStore) {}

  public async move(request: TransitionRequest): Promise<TopUp | null> {
    const updated = await this.store.transition(request);
    if (updated) {
      topUpTransitions.inc({ status: request.to });
      logger.info(
        { topUpId: updated.id, from: request.topUp.status, to: request.to, source: request.source, reason: request.reason ?? undefined },
        'Top-up status changed'
      );
    }
    return updated;
  }

  /** The current state of a top-up that must exist (it was read a moment ago) */
  public async reload(id: string): Promise<TopUp> {
    const topUp = await this.store.findById(id);
    if (!topUp) throw new Error(`Top-up ${id} disappeared`);
    return topUp;
  }
}
