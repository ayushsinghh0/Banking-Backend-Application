// Real-time fan-out capacity: hold STREAMS concurrent SSE connections to /api/v1/realtime/stream through the
// whole edge (nginx -> gateway -> realtime-service). Each VU is one open app: it holds a stream for HOLD_SECONDS,
// reconnects, and backs off after a refusal. Connections ramp up gradually, as they do after a deploy.
//
//   PROFILE=smoke (default): 5 streams, 20s holds, ~1 minute; PROFILE=load: 500 streams for 10 minutes
//   STREAMS=N  HOLD_SECONDS=S  RAMP=2m  HOLD=10m
//
// A user may hold at most 5 streams (design 8), so seed at least STREAMS / 5 users. k6 cannot read events from
// a stream it is still holding; see lib/journeys.js realtimeHold for what is and is not measured.
import { PROFILE, users } from './lib/config.js';
import { HOLD_SECONDS, realtimeHold } from './lib/journeys.js';
import { envNumber, summaryTrendStats } from './lib/scenarios.js';

const STREAMS = envNumber('STREAMS', PROFILE === 'smoke' ? 5 : 500);
if (Math.ceil(STREAMS / users.length) > 5) {
  throw new Error(`realtime: ${STREAMS} streams over ${users.length} users exceeds 5 streams per user; seed at least ${Math.ceil(STREAMS / 5)} users`);
}

const env = (name, fallback) => __ENV[name] || fallback;
const STAGES = {
  smoke: [
    { duration: '10s', target: STREAMS },
    { duration: env('DURATION', '50s'), target: STREAMS },
  ],
  load: [
    { duration: env('RAMP', '2m'), target: STREAMS },
    { duration: env('HOLD', '10m'), target: STREAMS },
    { duration: '1m', target: 0 },
  ],
  stress: [0.5, 1, 2, 3, 4].map((f) => ({ duration: env('STEP', '3m'), target: Math.round(STREAMS * f) })).concat({ duration: '1m', target: 0 }),
  soak: [
    { duration: '5m', target: STREAMS },
    { duration: env('SOAK', '2h'), target: STREAMS },
    { duration: '2m', target: 0 },
  ],
}[PROFILE];

export const options = {
  scenarios: {
    realtime: {
      executor: 'ramping-vus',
      exec: 'realtimeHold',
      startVUs: 0,
      stages: STAGES,
      // Let a stream that is being held finish instead of counting it as an early close
      gracefulRampDown: `${HOLD_SECONDS + 10}s`,
      gracefulStop: `${HOLD_SECONDS + 10}s`,
    },
  },
  thresholds: {
    realtime_stream_ok: [{ threshold: 'rate>0.99', abortOnFail: true, delayAbortEval: '30s' }],
    'checks{journey:auth}': ['rate>0.99'],
  },
  summaryTrendStats,
};

export { realtimeHold };
