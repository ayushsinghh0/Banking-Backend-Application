// Load shapes and pass/fail criteria shared by the scenarios.
//
// Every scenario is open-model (arrival-rate): iterations start on schedule whatever the response times, so a
// slow system builds a queue the way real traffic does instead of the test politely slowing down with it.
//
//   PROFILE=smoke   constant low rate for DURATION (default 30s), at most MAX_VUS (default 5) VUs
//   PROFILE=load    ramp to the target over RAMP (2m), hold for HOLD (10m), ramp down
//   PROFILE=stress  steps of 0.5x, 1x, 1.5x, 2x, 3x the target (STEP, default 3m each) to find the knee
//   PROFILE=soak    ramp to the target over 5m, hold for SOAK (2h): leaks, pool exhaustion, slow drift
//
// RATE overrides a script's target (iterations/second at the load level).
import { PROFILE } from './config.js';

export function envNumber(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number (got ${raw})`);
  return value;
}

const env = (name, fallback) => __ENV[name] || fallback;

/** Rates are expressed per minute so fractional per-second targets (0.4 top-ups/s) stay exact */
const perMinute = (perSecond) => Math.max(1, Math.round(perSecond * 60));

function stages(target) {
  switch (PROFILE) {
    case 'load':
      return [
        { duration: env('RAMP', '2m'), target: perMinute(target) },
        { duration: env('HOLD', '10m'), target: perMinute(target) },
        { duration: '1m', target: 0 },
      ];
    case 'stress':
      return [0.5, 1, 1.5, 2, 3]
        .flatMap((f) => [
          { duration: '1m', target: perMinute(target * f) },
          { duration: env('STEP', '3m'), target: perMinute(target * f) },
        ])
        .concat({ duration: '1m', target: 0 });
    case 'soak':
      return [
        { duration: '5m', target: perMinute(target) },
        { duration: env('SOAK', '2h'), target: perMinute(target) },
        { duration: '2m', target: 0 },
      ];
    default:
      throw new Error(`no stages for ${PROFILE}`);
  }
}

/**
 * An arrival-rate scenario for `exec` (the exported function name).
 *   smokeRate / loadRate   iterations per second at the smoke and load levels (RATE overrides both)
 *   rate                   an exact target for every profile, ignoring RATE (mixed.js derives it from TARGET_RPS)
 *   iterationSeconds       expected wall time of one iteration including think time; sizes the VU pool
 */
export function arrivalScenario(exec, { smokeRate, loadRate, rate: fixedRate, iterationSeconds, startTime }) {
  if (PROFILE === 'smoke') {
    const rate = fixedRate ?? envNumber('RATE', smokeRate);
    const maxVUs = envNumber('MAX_VUS', 5);
    return {
      executor: 'constant-arrival-rate',
      exec,
      rate: perMinute(rate),
      timeUnit: '1m',
      duration: env('DURATION', '30s'),
      preAllocatedVUs: Math.min(maxVUs, Math.max(1, Math.ceil(rate * iterationSeconds))),
      maxVUs,
      ...(startTime ? { startTime } : {}),
    };
  }
  const target = fixedRate ?? envNumber('RATE', loadRate);
  const peak = PROFILE === 'stress' ? target * 3 : target;
  const needed = Math.ceil(peak * iterationSeconds);
  return {
    executor: 'ramping-arrival-rate',
    exec,
    startRate: 0,
    timeUnit: '1m',
    stages: stages(target),
    preAllocatedVUs: Math.max(1, Math.ceil(needed * 1.2)),
    maxVUs: envNumber('MAX_VUS', Math.max(10, needed * 4)),
    ...(startTime ? { startTime } : {}),
  };
}

/** Total length of a stage list in seconds ("1h30m", "2m", "45s") */
export function stagesSeconds(list) {
  return list.reduce((total, s) => {
    let seconds = 0;
    for (const [, n, unit] of String(s.duration).matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) {
      seconds += Number(n) * { h: 3600, m: 60, s: 1, ms: 0.001 }[unit];
    }
    return total + seconds;
  }, 0);
}

/** Wall time of an arrival-rate scenario in seconds */
export function scenarioSeconds(scenario) {
  return scenario.stages ? stagesSeconds(scenario.stages) : stagesSeconds([{ duration: scenario.duration }]);
}

/** Highest arrival rate of a scenario, in iterations per minute */
export function peakPerMinute(scenario) {
  return scenario.stages ? Math.max(...scenario.stages.map((s) => s.target)) : scenario.rate;
}

/**
 * Error-rate gates for a journey: abort early when it is clearly broken (> 5 % after a 20 s grace period),
 * fail the run above 1 %; checks must pass 99 % of the time.
 */
export function errorThresholds(journey) {
  return {
    [`http_req_failed{journey:${journey}}`]: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '20s' }, 'rate<0.01'],
    [`checks{journey:${journey}}`]: ['rate>0.99'],
  };
}

export const summaryTrendStats = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];
