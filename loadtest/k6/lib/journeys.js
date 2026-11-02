// What a customer actually does, one function per journey. The single-journey scripts and mixed.js all call
// these, so a journey behaves the same whether it is measured alone or in the realistic mix.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { BASE_URL, PROFILE, THINK_SCALE, accountOf, currentUser, pick, randomInt, weighted } from './config.js';
import { api, businessRejections, dataOf, errorCode, getAll, journeyDuration } from './http.js';
import { accessToken, dropSession } from './session.js';
import { parseSse } from './sse.js';
import { envNumber } from './scenarios.js';

const assistantTtfb = new Trend('assistant_ttfb', true);
const assistantAnswer = new Trend('assistant_answer_duration', true);
const assistantTokens = new Counter('assistant_tokens_streamed');
const idempotentRetries = new Counter('idempotent_retries');
const idempotentReplayOk = new Rate('idempotent_replay_ok');
const streamOk = new Rate('realtime_stream_ok');
const streamRejected = new Counter('realtime_stream_rejected');
const streamSeconds = new Trend('realtime_stream_seconds');

const think = (min, max) => {
  if (THINK_SCALE > 0) sleep(THINK_SCALE * (min + Math.random() * (max - min)));
};

// ---------------------------------------------------------------------------------------------------------
// browse: the dashboard. Accounts, every balance in parallel, the latest history of one account, and now and
// then the profile and identity (the web app caches those, so they are not on every view).

const PROFILE_READ_SHARE = envNumber('PROFILE_READ_SHARE', 0.25);

export function browse() {
  if (!accessToken()) return;
  const started = Date.now();
  const list = api('GET', '/api/v1/accounts', { journey: 'browse', name: 'GET /accounts' });
  const accounts = (dataOf(list) ?? []).filter((a) => a.status === 'ACTIVE');
  if (accounts.length) {
    getAll(
      accounts.map((a) => [`/api/v1/transactions/accounts/${a.id}/balance`, 'GET /transactions/accounts/:id/balance']),
      { journey: 'browse' }
    );
    api('GET', `/api/v1/transactions/accounts/${pick(accounts).id}/history?limit=20&offset=0`, {
      journey: 'browse',
      name: 'GET /transactions/accounts/:id/history',
    });
  }
  if (Math.random() < PROFILE_READ_SHARE) {
    getAll(
      [
        ['/api/v1/customers/me', 'GET /customers/me'],
        ['/api/v1/auth/me', 'GET /auth/me'],
      ],
      { journey: 'browse' }
    );
  }
  journeyDuration.add(Date.now() - started, { journey: 'browse' });
}

// ---------------------------------------------------------------------------------------------------------
// transfers: money between the customer's own SAVINGS and CURRENT accounts (no payee or cooling-off needed),
// Rs 1-10 at a time so the per-account (Rs 1 lakh) and per-customer (Rs 5 lakh) daily limits are never the
// bottleneck. Money is conserved, so the seeded balances last for any run length.

// A short smoke replays often enough for the idempotency threshold to have samples
const REPLAY_SHARE = envNumber('REPLAY_SHARE', PROFILE === 'smoke' ? 0.25 : 0.02);
const TRANSFER_PATH = '/api/v1/transactions/transfer';

export function transfer() {
  if (!accessToken()) return;
  const user = currentUser();
  const savings = accountOf(user, 'SAVINGS');
  const current = accountOf(user, 'CURRENT');
  const started = Date.now();
  // The transfer screen shows both balances before the customer picks an amount
  const balances = getAll(
    [savings, current].map((a) => [`/api/v1/transactions/accounts/${a.id}/balance`, 'GET /transactions/accounts/:id/balance']),
    { journey: 'transfers' }
  );
  if (!balances) return;
  const [fromSavings, fromCurrent] = balances.map((r) => BigInt(dataOf(r)?.balanceInPaise ?? '0'));
  const [from, to, available] = fromSavings >= fromCurrent ? [savings, current, fromSavings] : [current, savings, fromCurrent];
  const amount = randomInt(100, 1000);
  if (available < BigInt(amount)) {
    businessRejections.add(1, { journey: 'transfers', code: 'LOW_BALANCE' });
    return;
  }
  think(1, 3);

  const options = {
    journey: 'transfers',
    name: 'POST /transactions/transfer',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { sourceAccountId: from.id, destinationAccountId: to.id, amountInPaise: String(amount), description: 'k6 own-account transfer' },
    expected: [201],
  };
  let res = api('POST', TRANSFER_PATH, options);
  if (res && [0, 502, 503, 504].includes(res.status)) {
    // Outcome unknown (network error or gateway timeout): retry with the SAME key, which moves money at most once
    idempotentRetries.add(1);
    res = api('POST', TRANSFER_PATH, options);
  } else if (res?.status === 201 && Math.random() < REPLAY_SHARE) {
    // A double-submitted form: the same key and body must return the original transfer, not a second one
    const replay = api('POST', TRANSFER_PATH, { ...options, name: 'POST /transactions/transfer (replay)', expected: [200, 201] });
    idempotentReplayOk.add(Boolean(dataOf(res)?.transactionId) && dataOf(replay)?.transactionId === dataOf(res)?.transactionId);
  }
  if (res?.status === 422) businessRejections.add(1, { journey: 'transfers', code: errorCode(res) });
  journeyDuration.add(Date.now() - started, { journey: 'transfers' });
}

// ---------------------------------------------------------------------------------------------------------
// topups: add money with Razorpay in SIMULATOR mode only (design 6): config -> order -> simulated checkout ->
// confirm (signature verified, payment fetched, ledger credited). Each VU finishes or cancels its order before
// the next, so a user never holds more than (VUs sharing the user) open orders; the API allows 3.

const TOPUP_AMOUNT_PAISE = BigInt(envNumber('TOPUP_AMOUNT_PAISE', 10000)); // Rs 100: 2,000 per user under the Rs 2 lakh daily cap

function paymentTriple(data) {
  const src = data?.razorpayPaymentId || data?.razorpay_payment_id ? data : (data?.payment ?? data?.response ?? data);
  const triple = {
    razorpayPaymentId: src?.razorpayPaymentId ?? src?.razorpay_payment_id,
    razorpayOrderId: src?.razorpayOrderId ?? src?.razorpay_order_id,
    razorpaySignature: src?.razorpaySignature ?? src?.razorpay_signature,
  };
  return triple.razorpayPaymentId && triple.razorpayOrderId && triple.razorpaySignature ? triple : null;
}

export function topUp() {
  if (!accessToken()) return;
  const account = accountOf(currentUser(), 'SAVINGS');
  const started = Date.now();
  const config = dataOf(api('GET', '/api/v1/payments/config', { journey: 'topups', name: 'GET /payments/config' }));
  if (!config) return;
  if (config.mode !== 'simulator') {
    exec.test.abort(`topups run only against the Razorpay simulator; GET /payments/config says mode=${config.mode}`);
  }
  if (BigInt(config.limits?.remainingTodayPaise ?? '0') < TOPUP_AMOUNT_PAISE) {
    businessRejections.add(1, { journey: 'topups', code: 'DAILY_CAP' });
    return;
  }
  const created = api('POST', '/api/v1/payments/top-ups', {
    journey: 'topups',
    name: 'POST /payments/top-ups',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { accountId: account.id, amountPaise: TOPUP_AMOUNT_PAISE.toString() },
    expected: [201],
  });
  const order = dataOf(created)?.topUp;
  if (!order) {
    if (created?.status === 409 || created?.status === 422) businessRejections.add(1, { journey: 'topups', code: errorCode(created) });
    return;
  }
  think(2, 6); // choosing a method and paying in Checkout

  const simulated = api('POST', `/api/v1/payments/top-ups/${order.id}/simulate`, {
    journey: 'topups',
    name: 'POST /payments/top-ups/:id/simulate',
    body: { outcome: 'success', method: weighted([['upi', 70], ['card', 20], ['netbanking', 10]]) },
  });
  const triple = paymentTriple(dataOf(simulated));
  if (!triple) {
    // Leave no open order behind: the API allows only 3 per customer
    api('POST', `/api/v1/payments/top-ups/${order.id}/cancel`, { journey: 'topups', name: 'POST /payments/top-ups/:id/cancel', body: {} });
    return;
  }
  const confirmed = api('POST', `/api/v1/payments/top-ups/${order.id}/confirm`, {
    journey: 'topups',
    name: 'POST /payments/top-ups/:id/confirm',
    body: triple,
  });
  check(confirmed, { 'top-up confirmed and CREDITED': () => dataOf(confirmed)?.topUp?.status === 'CREDITED' }, { journey: 'topups' });
  journeyDuration.add(Date.now() - started, { journey: 'topups' });
}

// ---------------------------------------------------------------------------------------------------------
// assistant: one Sphere question per iteration over SSE. A conversation lasts a few questions, like a person's
// chat. The server allows 20 messages per minute per user (design 7); the scripts check their rate against it.

const QUESTIONS = [
  'What is my balance?',
  'Show my recent transactions',
  'How much did I spend this week?',
  'List my payees',
  'What are my transfer limits?',
  'How do I add money to my account?',
  'Show my recent top-ups',
  'Help me move 500 rupees from savings to current',
];
let conversation = null;

export function assistantMessage() {
  if (!accessToken()) return;
  const started = Date.now();
  if (!conversation || conversation.messages >= 6) {
    const created = api('POST', '/api/v1/assistant/conversations', {
      journey: 'assistant',
      name: 'POST /assistant/conversations',
      body: { title: 'k6 load test' },
      expected: [200, 201],
    });
    const id = dataOf(created)?.id;
    if (!id) return;
    conversation = { id, messages: 0 };
  }
  const res = api('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, {
    journey: 'assistant',
    name: 'POST /assistant/conversations/:id/messages',
    headers: { Accept: 'text/event-stream' },
    body: { content: pick(QUESTIONS) },
    timeout: '60s',
  });
  conversation.messages++;
  if (res?.status === 200) {
    // Time to the first byte is the first event (message.start); k6 buffers the body, so per-token timing is
    // not observable here, only the complete answer
    assistantTtfb.add(res.timings.waiting);
    assistantAnswer.add(res.timings.duration);
    const events = parseSse(res.body);
    const names = events.map((e) => e.event);
    check(
      res,
      {
        'assistant: message.start': () => names.includes('message.start'),
        'assistant: message.end': () => names.includes('message.end'),
        'assistant: no error event': () => !names.includes('error'),
      },
      { journey: 'assistant' }
    );
    assistantTokens.add(names.filter((n) => n === 'token').length);
  } else if (res?.status === 404) {
    conversation = null; // expired or deleted: start a new one
  }
  journeyDuration.add(Date.now() - started, { journey: 'assistant' });
  think(3, 8); // reading the answer
}

// ---------------------------------------------------------------------------------------------------------
// realtime: an open app holds one SSE stream (design 8). k6 has no SSE client, so a stream is held with a GET
// whose timeout is the hold time: ending in that client timeout means the server kept it open (success); the
// server ending it with `reauth` at token expiry is also success; an early non-200 (429: more than 5 streams for
// one user) or an early close is a failure. Events received while holding are not visible to k6 (it drops the
// body on timeout), so delivery latency is measured by the API e2e suite, not here.

export const HOLD_SECONDS = envNumber('HOLD_SECONDS', PROFILE === 'smoke' ? 20 : 120);

export function realtimeHold() {
  // Refresh first if the token would expire mid-hold, so the server does not end the stream for re-auth
  const token = accessToken(Math.min(HOLD_SECONDS + 10, 600));
  if (!token) {
    sleep(1);
    return;
  }
  const started = Date.now();
  const res = http.get(`${BASE_URL}/api/v1/realtime/stream`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    timeout: `${HOLD_SECONDS}s`,
    tags: { journey: 'realtime', name: 'GET /realtime/stream' },
    // A held stream ends in a client-side timeout by design: keep it out of http_req_failed
    responseCallback: null,
  });
  const held = (Date.now() - started) / 1000;
  streamSeconds.add(held);
  let ok = false;
  let reason;
  if (res.status === 0 && res.error_code === 1050) {
    ok = held >= HOLD_SECONDS * 0.9;
    reason = ok ? undefined : 'timeout-early';
  } else if (res.status === 200) {
    const names = parseSse(res.body).map((e) => e.event);
    ok = names.includes('reauth') || held >= HOLD_SECONDS * 0.9;
    reason = ok ? undefined : 'closed-early';
  } else {
    if (res.status === 401) dropSession();
    reason = String(res.status || res.error_code);
  }
  streamOk.add(ok, { journey: 'realtime' });
  if (!ok) {
    streamRejected.add(1, { reason });
    sleep(1 + Math.random() * 2); // back off like the web app does, instead of a hot reconnect loop
  }
}

// ---------------------------------------------------------------------------------------------------------
// other: the less frequent screens, one per visit: payees, top-up history, signed-in devices.

export function otherReads() {
  if (!accessToken()) return;
  const started = Date.now();
  const [path, name] = weighted([
    [['/api/v1/transactions/beneficiaries', 'GET /transactions/beneficiaries'], 40],
    [['/api/v1/payments/top-ups?limit=10', 'GET /payments/top-ups'], 30],
    [['/api/v1/auth/sessions', 'GET /auth/sessions'], 30],
  ]);
  api('GET', path, { journey: 'other', name });
  journeyDuration.add(Date.now() - started, { journey: 'other' });
}
