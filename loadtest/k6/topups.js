// Add money (Razorpay top-ups) in SIMULATOR mode: config -> order (Idempotency-Key) -> simulated checkout ->
// confirm. Exercises payment-service, the simulator round trip, signature verification and the ledger credit.
// Aborts at once if the stack is not in simulator mode: it must never create real Razorpay orders.
//
//   PROFILE=smoke (default): 1 top-up every 2s for 30s; PROFILE=load: 2 top-ups/s (RATE=...)
//   TOPUP_AMOUNT_PAISE (default 10000 = Rs 100); each user may top up Rs 2 lakh a day and hold 3 open orders
import { users } from './lib/config.js';
import { topUp } from './lib/journeys.js';
import { arrivalScenario, errorThresholds, summaryTrendStats } from './lib/scenarios.js';

const scenario = arrivalScenario('topUp', { smokeRate: 0.5, loadRate: 2, iterationSeconds: 6 });

// VUs share users round-robin and each VU can hold one open order: more than 3 VUs per user hits the API's
// open-order cap (a 409, counted as a business rejection) instead of measuring anything
if (Math.ceil(scenario.maxVUs / users.length) > 3) {
  console.warn(`topups: up to ${scenario.maxVUs} VUs over ${users.length} users can exceed 3 open orders per user; seed more users`);
}

export const options = {
  scenarios: { topups: scenario },
  thresholds: {
    ...errorThresholds('topups'),
    'http_req_duration{journey:topups}': ['p(95)<1500'],
    'journey_duration{journey:topups}': ['p(95)<12000'], // includes the 2-6s spent in checkout
    business_rejections: ['count<1'],
    rate_limited: ['count<1'],
  },
  summaryTrendStats,
};

export { topUp };
