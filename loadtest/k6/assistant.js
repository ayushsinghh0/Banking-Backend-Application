// Sphere assistant over SSE: one question per iteration in short conversations; checks the event stream
// (message.start ... message.end, no error event) and records time to first byte and the complete answer.
// With no LLM_API_KEY the built-in assistant answers, which measures the service, not an LLM provider.
//
//   PROFILE=smoke (default): 1 question every 2s for 30s; PROFILE=load: 3 questions/s (RATE=...)
import { users } from './lib/config.js';
import { assistantMessage } from './lib/journeys.js';
import { arrivalScenario, errorThresholds, peakPerMinute, summaryTrendStats } from './lib/scenarios.js';

const scenario = arrivalScenario('assistantMessage', { smokeRate: 0.5, loadRate: 3, iterationSeconds: 10 });

// The server allows 20 messages per minute per user (GCRA, design 7): above that the test would only measure 429s
const perUserPerMinute = peakPerMinute(scenario) / users.length;
if (perUserPerMinute > 18) {
  throw new Error(
    `assistant: ${perUserPerMinute.toFixed(1)} messages/min per user exceeds the 20/min limit; seed at least ` +
      `${Math.ceil(peakPerMinute(scenario) / 18)} users or lower RATE`
  );
}

export const options = {
  scenarios: { assistant: scenario },
  thresholds: {
    ...errorThresholds('assistant'),
    assistant_ttfb: ['p(95)<2000'],
    assistant_answer_duration: ['p(95)<15000'],
    rate_limited: ['count<1'],
  },
  summaryTrendStats,
};

export { assistantMessage };
