// The realistic mix: every journey at once, at rates derived from one target request rate, plus the open apps'
// real-time streams. This is the run whose numbers feed docs/operations/capacity-plan.md.
//
//   TARGET_RPS   HTTP requests per second at the edge at the load level (default: smoke 5, others 200)
//   STREAMS      concurrent SSE streams (default TARGET_RPS x STREAMS_PER_RPS, capped at 4 per seeded user)
//   PROFILE      smoke (default) | load | stress (steps to 3x TARGET_RPS) | soak
//
// Mix assumptions (share of HTTP requests, retail-banking traffic, design 1):
//   browse     80 %  dashboard views: accounts, balances, history, profile        ~4.5 requests per view
//   other      12 %  payees, top-up history, signed-in devices                      1 request per visit
//   transfers   4 %  own-account transfers (balances + transfer)                    ~3 requests
//   assistant   3 %  Sphere questions over SSE                                      ~1.2 requests
//   topups      1 %  add money via the Razorpay simulator                            4 requests
// Money movements (transfers + top-ups) are 5 % of requests. Token refreshes (one per session every ~14 min)
// come on top. STREAMS_PER_RPS (default 7.5) comes from the capacity plan's ratio of open apps to request rate
// (about 60k streams at 8k requests/s); change it there and here together.
import { PROFILE, users } from './lib/config.js';
import { HOLD_SECONDS, assistantMessage, browse, otherReads, realtimeHold, topUp, transfer } from './lib/journeys.js';
import { arrivalScenario, envNumber, errorThresholds, peakPerMinute, scenarioSeconds, summaryTrendStats } from './lib/scenarios.js';

const TARGET_RPS = envNumber('TARGET_RPS', PROFILE === 'smoke' ? 5 : 200);

const MIX = {
  browse: { exec: 'browse', share: 0.8, requestsPerIteration: 4.5, iterationSeconds: 1 },
  other: { exec: 'otherReads', share: 0.12, requestsPerIteration: 1, iterationSeconds: 0.5 },
  transfers: { exec: 'transfer', share: 0.04, requestsPerIteration: 3, iterationSeconds: 3 },
  assistant: { exec: 'assistantMessage', share: 0.03, requestsPerIteration: 1.17, iterationSeconds: 10 },
  topups: { exec: 'topUp', share: 0.01, requestsPerIteration: 4, iterationSeconds: 6 },
};

const scenarios = {};
for (const [journey, m] of Object.entries(MIX)) {
  scenarios[journey] = arrivalScenario(m.exec, {
    rate: (TARGET_RPS * m.share) / m.requestsPerIteration,
    iterationSeconds: m.iterationSeconds,
  });
}

const perUserAssistant = peakPerMinute(scenarios.assistant) / users.length;
if (perUserAssistant > 18) {
  throw new Error(`mixed: ${perUserAssistant.toFixed(1)} assistant messages/min per user exceeds the 20/min limit; seed more users`);
}

const wanted = envNumber('STREAMS', PROFILE === 'smoke' ? 5 : Math.round(TARGET_RPS * envNumber('STREAMS_PER_RPS', 7.5)));
const STREAMS = Math.min(wanted, users.length * 4);
if (STREAMS < wanted) {
  console.warn(`mixed: holding ${STREAMS} streams instead of ${wanted} (4 per seeded user); seed ${Math.ceil(wanted / 4)} users for the full count`);
}
if (STREAMS > 0) {
  scenarios.realtime = {
    executor: 'constant-vus',
    exec: 'realtimeHold',
    vus: STREAMS,
    duration: `${Math.round(scenarioSeconds(scenarios.browse))}s`,
    gracefulStop: `${HOLD_SECONDS + 10}s`,
  };
}

export const options = {
  scenarios,
  thresholds: {
    ...errorThresholds('browse'),
    ...errorThresholds('other'),
    ...errorThresholds('transfers'),
    ...errorThresholds('assistant'),
    ...errorThresholds('topups'),
    'http_req_duration{journey:browse}': ['p(95)<300', 'p(99)<800'],
    'http_req_duration{journey:other}': ['p(95)<300', 'p(99)<800'],
    'http_req_duration{journey:transfers}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{journey:topups}': ['p(95)<1500'],
    assistant_ttfb: ['p(95)<2000'],
    ...(STREAMS > 0 ? { realtime_stream_ok: ['rate>0.99'] } : {}),
    rate_limited: ['count<1'],
  },
  summaryTrendStats,
};

export { assistantMessage, browse, otherReads, realtimeHold, topUp, transfer };
