// Read-heavy dashboard traffic: accounts, every balance, recent history, now and then profile and identity.
// The bulk of real load (design 1: ~95 % of requests are reads) and the main consumer of the ledger caches.
//
//   PROFILE=smoke (default): 2 views/s for 30s on at most 5 VUs; PROFILE=load: 50 views/s (RATE=...)
import { browse } from './lib/journeys.js';
import { arrivalScenario, errorThresholds, summaryTrendStats } from './lib/scenarios.js';

export const options = {
  scenarios: {
    browse: arrivalScenario('browse', { smokeRate: 2, loadRate: 50, iterationSeconds: 1 }),
  },
  thresholds: {
    ...errorThresholds('browse'),
    'http_req_duration{journey:browse}': ['p(95)<300', 'p(99)<800'],
    rate_limited: ['count<1'],
  },
  summaryTrendStats,
};

export { browse };
