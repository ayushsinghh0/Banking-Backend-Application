// Money movement: own-account transfers (SAVINGS <-> CURRENT) with an Idempotency-Key per attempt, a single
// same-key retry when the outcome is unknown, and an occasional deliberate replay that must return the original
// transfer. Exercises the ledger write path: row locks, double entry, outbox, cache version bumps.
//
//   PROFILE=smoke (default): 1 transfer/s for 30s; PROFILE=load: 10 transfers/s (RATE=...)
import { transfer } from './lib/journeys.js';
import { arrivalScenario, errorThresholds, summaryTrendStats } from './lib/scenarios.js';

export const options = {
  scenarios: {
    // ~3s per iteration: two balance reads, 1-3s on the review screen, the transfer
    transfers: arrivalScenario('transfer', { smokeRate: 1, loadRate: 10, iterationSeconds: 3 }),
  },
  thresholds: {
    ...errorThresholds('transfers'),
    'http_req_duration{journey:transfers}': ['p(95)<800', 'p(99)<1500'],
    idempotent_replay_ok: ['rate==1'],
    business_rejections: ['count<1'],
    rate_limited: ['count<1'],
  },
  summaryTrendStats,
};

export { transfer };
