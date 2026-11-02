#!/usr/bin/env node
/**
 * End-to-end suite for the platform features: Razorpay top-ups (through the simulator), real-time updates
 * (Server-Sent Events), the Sphere assistant, sessions and devices, IP rules, tamper-evident audit and the edge.
 * Runs against a live stack started with the dev overlay (Mailpit + razorpay-simulator), after scripts/e2e.mjs
 * has enrolled the two bootstrap administrators (their TOTP secrets are read from scripts/.e2e-state.json).
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN2_EMAIL=... ADMIN2_PASSWORD=... GATEWAY_URL=http://localhost:8080 \
 *     node scripts/e2e-platform.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKit } from './lib/e2e-kit.mjs';

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.e2e-state.json');
const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN2_EMAIL, ADMIN2_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN2_EMAIL || !ADMIN2_PASSWORD) {
  console.error('ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN2_EMAIL and ADMIN2_PASSWORD are required');
  process.exit(2);
}

const kit = createKit({ gateway: GATEWAY, mailpit: MAILPIT, stateFile: STATE_FILE });
const { check, section, sleep, api, waitFor, freshTotp, idem, key, runId, PASSWORD, login, registerVerified, kycVerified, balance, bootstrapAdmin, serverErrors } = kit;

/** Reads a Server-Sent Events stream; `next(type)` resolves with the next event of that type (or null on timeout) */
async function openStream(token, { lastEventId, signal } = {}) {
  const res = await fetch(`${GATEWAY}/api/v1/realtime/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
    signal,
  });
  const events = [];
  const waiters = [];
  if (res.ok && res.body) {
    (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = { type: 'message', id: undefined, data: undefined };
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event.type = line.slice(7);
              else if (line.startsWith('id: ')) event.id = line.slice(4);
              else if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
            }
            if (event.data === undefined) continue; // heartbeat comment
            events.push(event);
            for (const w of waiters.splice(0)) w();
          }
        }
      } catch {
        // aborted by the test
      }
    })();
  }
  async function next(predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find((e) => !e.consumed && predicate(e));
      if (found) {
        found.consumed = true;
        return found;
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, left);
      });
    }
  }
  return { status: res.status, events, next };
}

/** Sends a message to the assistant and collects the streamed events */
async function ask(token, conversationId, content) {
  const res = await fetch(`${GATEWAY}/api/v1/assistant/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ content }),
  });
  const text = await res.text();
  if (res.status >= 500) serverErrors.push(`assistant message -> ${res.status} ${text.slice(0, 200)}`);
  const events = text
    .split('\n\n')
    .map((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return type && data ? { type, data: JSON.parse(data) } : null;
    })
    .filter(Boolean);
  const answer = events.filter((e) => e.type === 'token').map((e) => e.data.text).join('');
  return { status: res.status, contentType: res.headers.get('content-type'), events, answer };
}

async function stepUp(user) {
  const res = await api('POST', '/api/v1/auth/mfa/step-up', { token: user.token, body: { code: await freshTotp(user.secret) } });
  return res.body?.data?.accessToken;
}

async function topUpStatus(token, id, wanted) {
  return waitFor(async () => {
    const res = await api('GET', `/api/v1/payments/top-ups/${id}`, { token });
    const topUp = res.body?.data?.topUp;
    return wanted.includes(topUp?.status) ? topUp : null;
  }, { timeoutMs: 45_000 });
}

console.log(`BankSphere platform E2E against ${GATEWAY} (run ${runId})`);

// ---------------------------------------------------------------------------
section('Setup');
const admin = await bootstrapAdmin('admin', ADMIN_EMAIL, ADMIN_PASSWORD);
const admin2 = await bootstrapAdmin('admin2', ADMIN2_EMAIL, ADMIN2_PASSWORD);
const kyc = await kit.onboardStaff(admin, admin2, 'KYC_OFFICER', 'pkyc');
const support = await kit.onboardStaff(admin, admin2, 'SUPPORT', 'psupport');
const teller = await kit.onboardStaff(admin, admin2, 'TELLER', 'pteller');
const dave = await registerVerified('pdave');
const erin = await registerVerified('perin');
await kycVerified(dave, kyc);
const daveAcc = (await api('POST', '/api/v1/accounts', { token: dave.token, body: { accountType: 'SAVINGS' } })).body?.data;
check('a verified customer opens an account', Boolean(daveAcc?.id), daveAcc);
await kycVerified(erin, kyc);
const erinAcc = (await api('POST', '/api/v1/accounts', { token: erin.token, body: {} })).body?.data;

// ---------------------------------------------------------------------------
section('Real-time stream');
const live = new AbortController();
const stream = await openStream(dave.token, { signal: live.signal });
check('a customer opens a real-time stream (200)', stream.status === 200, stream.status);
const ready = await stream.next((e) => e.type === 'ready', 10_000);
check('...and is told it is ready', Boolean(ready?.data?.connectionId), ready);
check('no stream without a token (401)', (await openStream('')).status === 401);

// ---------------------------------------------------------------------------
section('Add money: Razorpay top-ups through the simulator');
const config = await api('GET', '/api/v1/payments/config', { token: dave.token });
check('payment config: simulator mode with limits', config.status === 200 && config.body.data.mode === 'simulator' && Boolean(config.body.data.limits?.maxPaise), config.body);
check('staff cannot create top-ups (403)', (await api('GET', '/api/v1/payments/config', { token: teller.token })).status === 403);
check('top-up without Idempotency-Key is refused (400)', (await api('POST', '/api/v1/payments/top-ups', { token: dave.token, body: { accountId: daveAcc.id, amountPaise: '50000' } })).status === 400);
check("THEFT: a customer cannot top up into someone else's account", [403, 404].includes((await api('POST', '/api/v1/payments/top-ups', { token: dave.token, headers: idem(), body: { accountId: erinAcc.id, amountPaise: '50000' } })).status));
const tooSmall = await api('POST', '/api/v1/payments/top-ups', { token: dave.token, headers: idem(), body: { accountId: daveAcc.id, amountPaise: '1' } });
check('amounts below the minimum are refused (422 AMOUNT_TOO_SMALL)', tooSmall.status === 422 && tooSmall.body?.error?.code === 'AMOUNT_TOO_SMALL', tooSmall.body);

const before = BigInt((await balance(dave.token, daveAcc.id)) ?? '0');
const intentKey = key();
const created = await api('POST', '/api/v1/payments/top-ups', { token: dave.token, headers: { 'Idempotency-Key': intentKey }, body: { accountId: daveAcc.id, amountPaise: '50000' } });
check('creates a top-up and a Razorpay order (201)', created.status === 201 && Boolean(created.body.data.checkout?.orderId) && created.body.data.topUp.status === 'CREATED', created.body);
const topUp = created.body.data?.topUp;
const replay = await api('POST', '/api/v1/payments/top-ups', { token: dave.token, headers: { 'Idempotency-Key': intentKey }, body: { accountId: daveAcc.id, amountPaise: '50000' } });
check('IDEMPOTENCY: the same request replays the same top-up', replay.body?.data?.topUp?.id === topUp?.id, replay.body);
const reuse = await api('POST', '/api/v1/payments/top-ups', { token: dave.token, headers: { 'Idempotency-Key': intentKey }, body: { accountId: daveAcc.id, amountPaise: '70000' } });
check('IDEMPOTENCY: the same key with a different amount is refused (409)', reuse.status === 409, reuse.body);

const paid = await api('POST', `/api/v1/payments/top-ups/${topUp.id}/simulate`, { token: dave.token, body: { outcome: 'success', method: 'upi' } });
check('the simulated checkout pays the order', paid.status === 200 && Boolean(paid.body.data?.razorpay_signature), paid.body);
// Simulate answers with Checkout.js's triple (snake_case); confirm takes the web app's camelCase body
const proof = {
  razorpayPaymentId: paid.body.data?.razorpay_payment_id,
  razorpayOrderId: paid.body.data?.razorpay_order_id,
  razorpaySignature: paid.body.data?.razorpay_signature,
};
const tampered = await api('POST', `/api/v1/payments/top-ups/${topUp.id}/confirm`, { token: dave.token, body: { ...proof, razorpaySignature: '0'.repeat(64) } });
check('SIGNATURE: a forged payment signature is refused', tampered.status === 400, tampered.body);
check('no money moved on the forged confirmation', BigInt((await balance(dave.token, daveAcc.id)) ?? '0') === before);
const confirmed = await api('POST', `/api/v1/payments/top-ups/${topUp.id}/confirm`, { token: dave.token, body: proof });
check('a genuine confirmation credits the account', confirmed.status === 200 && ['CREDITED', 'CAPTURED'].includes(confirmed.body.data?.topUp?.status), confirmed.body);
const credited = await topUpStatus(dave.token, topUp.id, ['CREDITED']);
check('...the top-up ends CREDITED', Boolean(credited), credited);
check('...and the balance grows by exactly ₹500', BigInt((await balance(dave.token, daveAcc.id)) ?? '0') === before + 50000n);
await api('POST', `/api/v1/payments/top-ups/${topUp.id}/confirm`, { token: dave.token, body: proof });
await sleep(3000); // let the simulator's webhook for the same payment arrive too
check('EXACTLY ONCE: a second confirmation and the webhook do not credit again', BigInt((await balance(dave.token, daveAcc.id)) ?? '0') === before + 50000n);
const history = await api('GET', `/api/v1/transactions/accounts/${daveAcc.id}/history?limit=5`, { token: dave.token });
check('the ledger shows an ONLINE_TOP_UP credit', JSON.stringify(history.body).includes('ONLINE_TOP_UP'), history.body);
const livePayment = await stream.next((e) => e.type === 'payment.updated' && e.data?.data?.topUpId === topUp.id);
check('REAL-TIME: the customer is told about the top-up on the open stream', Boolean(livePayment), stream.events.map((e) => e.type));
const livePosting = await stream.next((e) => e.type === 'transaction.posted');
check('REAL-TIME: ...and about the ledger posting', Boolean(livePosting), stream.events.map((e) => e.type));

const forgedHook = await api('POST', '/api/v1/payments/webhooks/razorpay', { headers: { 'x-razorpay-signature': 'bad', 'x-razorpay-event-id': `evt_${runId}` }, body: { event: 'payment.captured', payload: {} } });
check('WEBHOOK: an unsigned webhook is refused (400) and changes nothing', forgedHook.status === 400, forgedHook.body);

const failing = await api('POST', '/api/v1/payments/top-ups', { token: dave.token, headers: idem(), body: { accountId: daveAcc.id, amountPaise: '20000' } });
await api('POST', `/api/v1/payments/top-ups/${failing.body.data?.topUp?.id}/simulate`, { token: dave.token, body: { outcome: 'failure', method: 'card' } });
const failed = await topUpStatus(dave.token, failing.body.data?.topUp?.id, ['FAILED']);
check('a declined payment ends FAILED without touching the balance', Boolean(failed) && BigInt((await balance(dave.token, daveAcc.id)) ?? '0') === before + 50000n, failed);

const beyond = await api('POST', '/api/v1/payments/top-ups', { token: dave.token, headers: idem(), body: { accountId: daveAcc.id, amountPaise: config.body.data.limits.remainingTodayPaise === undefined ? '999999999' : (BigInt(config.body.data.limits.remainingTodayPaise) + 1n).toString() } });
check("LIMITS: a top-up beyond today's remaining limit is refused", beyond.status >= 400 && beyond.status < 500, beyond.body);

section('Payments: operations');
check('customers cannot use the payments console (403)', (await api('GET', '/api/v1/payments/admin/top-ups', { token: dave.token })).status === 403);
const consoleList = await api('GET', `/api/v1/payments/admin/top-ups?customerId=${dave.id}`, { token: support.token });
check('support can read top-ups in the console', consoleList.status === 200 && JSON.stringify(consoleList.body).includes(topUp.id), consoleList.body);
const summary = await api('GET', '/api/v1/payments/admin/summary', { token: admin.token });
check("the console summarises today's top-ups", summary.status === 200, summary.body);
const supportRefund = await api('POST', `/api/v1/payments/admin/top-ups/${topUp.id}/refund`, { token: support.token, body: { reason: 'Customer asked for a refund' } });
check('support cannot refund (403)', supportRefund.status === 403, supportRefund.body);
// Signing in with a TOTP code is itself a recent step-up, so use a refreshed token (same session, no fresh code)
const refreshed = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: admin.refreshToken } });
admin.token = refreshed.body?.data?.accessToken ?? refreshed.body?.data?.tokens?.accessToken ?? admin.token;
admin.refreshToken = refreshed.body?.data?.refreshToken ?? refreshed.body?.data?.tokens?.refreshToken;
const noStepUp = await api('POST', `/api/v1/payments/admin/top-ups/${topUp.id}/refund`, { token: admin.token, body: { reason: 'Customer asked for a refund' } });
check('STEP-UP: a refund needs a fresh authenticator code', noStepUp.status === 403 && noStepUp.body?.error?.code === 'STEP_UP_REQUIRED', noStepUp.body);
const adminFresh = await stepUp(admin);
const refund = await api('POST', `/api/v1/payments/admin/top-ups/${topUp.id}/refund`, { token: adminFresh, body: { reason: 'Customer asked for a refund' } });
check('an administrator refunds a credited top-up', [200, 202].includes(refund.status), refund.body);
const refunded = await topUpStatus(dave.token, topUp.id, ['REFUNDED']);
check('...it ends REFUNDED and the money leaves the account', Boolean(refunded) && BigInt((await balance(dave.token, daveAcc.id)) ?? '0') === before, refunded);
const reconcile = await api('POST', '/api/v1/payments/admin/reconcile', { token: admin.token });
check('an administrator can reconcile with Razorpay on demand', reconcile.status === 200, reconcile.body);

// ---------------------------------------------------------------------------
section('Sphere assistant');
const meta = await api('GET', '/api/v1/assistant/meta', { token: dave.token });
check('assistant meta (built-in engine without an LLM key)', meta.status === 200 && ['builtin', 'llm'].includes(meta.body.data.provider) && meta.body.data.suggestions?.length > 0, meta.body);
const conversation = (await api('POST', '/api/v1/assistant/conversations', { token: dave.token, body: {} })).body?.data;
check('starts a conversation', Boolean(conversation?.id), conversation);
const balanceAnswer = await ask(dave.token, conversation.id, "What's my balance?");
const types = balanceAnswer.events.map((e) => e.type);
check('streams the answer as server-sent events', balanceAnswer.contentType?.startsWith('text/event-stream') && types[0] === 'message.start' && types.at(-1) === 'message.end', types);
check('...after consulting the accounts tool', balanceAnswer.events.some((e) => e.type === 'tool.result' && e.data.card?.type === 'accounts'), types);
const draft = await ask(dave.token, conversation.id, 'Send 500 to my mom');
check('NEVER MOVES MONEY: a transfer request becomes a draft card only', draft.events.some((e) => e.type === 'tool.result' && e.data.card?.type === 'transferDraft') || /review|payee/i.test(draft.answer), draft.events.map((e) => e.type));
check('...and the balance is unchanged', BigInt((await balance(dave.token, daveAcc.id)) ?? '0') === before);
check("PRIVACY: another customer cannot read the conversation (404)", (await api('GET', `/api/v1/assistant/conversations/${conversation.id}`, { token: erin.token })).status === 404);
const tellerChat = (await api('POST', '/api/v1/assistant/conversations', { token: teller.token, body: {} })).body?.data;
const tellerAsk = await ask(teller.token, tellerChat.id, 'Show my balance');
check('staff get procedures, never customer data tools', !tellerAsk.events.some((e) => e.type === 'tool.result' && e.data.card?.type === 'accounts'), tellerAsk.events.map((e) => e.type));
const json = await fetch(`${GATEWAY}/api/v1/assistant/conversations/${conversation.id}/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${dave.token}`, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ content: 'Show my recent transactions' }),
});
check('the same answer is available as plain JSON', json.status === 200 && (await json.json()).data?.role === 'assistant');
check('messages are length-limited (400)', (await api('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { token: dave.token, body: { content: 'x'.repeat(5000) } })).status === 400);

// ---------------------------------------------------------------------------
section('Sessions and devices');
const second = await login(dave.email, PASSWORD);
const secondToken = second.body?.data?.tokens?.accessToken;
const sessions = await api('GET', '/api/v1/auth/sessions', { token: dave.token });
check('a customer sees their sessions, the current one marked', sessions.status === 200 && sessions.body.data.length >= 2 && sessions.body.data.filter((s) => s.current).length === 1, sessions.body);
check('...with masked addresses only', (sessions.body?.data ?? []).every((s) => !/^\d+\.\d+\.\d+\.\d+$/.test(s.ipMasked ?? '')), sessions.body);
const revokeOthers = await api('POST', '/api/v1/auth/sessions/revoke-others', { token: dave.token });
check('signs out every other device', revokeOthers.status === 200, revokeOthers.body);
check('REVOCATION: the other device is locked out at once', (await api('GET', '/api/v1/accounts', { token: secondToken })).status === 401);
check('...while this session keeps working', (await api('GET', '/api/v1/accounts', { token: dave.token })).status === 200);
const events = await api('GET', '/api/v1/auth/security-events?limit=20', { token: dave.token });
check('sign-in activity is listed', events.status === 200 && events.body.data.length > 0, events.body);
check('support can see a customer’s sessions', (await api('GET', `/api/v1/auth/admin/users/${dave.id}/sessions`, { token: support.token })).status === 200);
check("customers cannot see other users' sessions (403)", (await api('GET', `/api/v1/auth/admin/users/${erin.id}/sessions`, { token: dave.token })).status === 403);

// ---------------------------------------------------------------------------
section('IP rules and edge protection');
const wide = await api('POST', '/api/v1/auth/admin/ip-rules', { token: admin.token, body: { cidr: '0.0.0.0/0', reason: 'block everything' } });
check('a rule wider than /8 is refused (400)', wide.status === 400, wide.body);
const staffOverlap = await api('POST', '/api/v1/auth/admin/ip-rules', { token: admin.token, body: { cidr: '10.1.0.0/16', reason: 'overlaps the office VPN' } });
check('a rule overlapping the staff networks is refused (400)', staffOverlap.status === 400, staffOverlap.body);
const rule = await api('POST', '/api/v1/auth/admin/ip-rules', { token: admin.token, body: { cidr: '198.51.100.0/24', reason: 'Known credential-stuffing source', expiresInMinutes: 60 } });
check('an administrator blocks a network', rule.status === 201, rule.body);
check('support can read the rules but not change them', (await api('GET', '/api/v1/auth/admin/ip-rules', { token: support.token })).status === 200 && (await api('POST', '/api/v1/auth/admin/ip-rules', { token: support.token, body: { cidr: '203.0.113.0/24', reason: 'nope' } })).status === 403);
check('the rule is removed again', (await api('DELETE', `/api/v1/auth/admin/ip-rules/${rule.body.data?.id}`, { token: admin.token })).status === 200);
const limited = await api('GET', '/api/v1/accounts', { token: dave.token });
check('rate-limit headers are present at the edge', limited.headers.get('x-ratelimit-limit') !== null, Object.fromEntries(limited.headers));
check('metrics are never reachable from outside (404)', (await api('GET', '/metrics')).status === 404);
check('unauthenticated calls to new services are refused (401)', (await api('GET', '/api/v1/payments/top-ups')).status === 401 && (await api('GET', '/api/v1/assistant/conversations')).status === 401);

// ---------------------------------------------------------------------------
section('Tamper-evident audit');
const ledgerAudit = await api('GET', '/api/v1/transactions/audit/verify', { token: admin.token });
check('the ledger audit chain verifies', ledgerAudit.status === 200 && ledgerAudit.body.data.ok === true, ledgerAudit.body);
const authAudit = await api('GET', '/api/v1/auth/admin/audit/verify', { token: admin.token });
check('the identity audit chain verifies', authAudit.status === 200 && authAudit.body.data.ok === true, authAudit.body);
check('only administrators may verify audit chains (403)', (await api('GET', '/api/v1/transactions/audit/verify', { token: support.token })).status === 403);

live.abort();

section('Global');
check('no request in the whole run returned a 5xx', serverErrors.length === 0, serverErrors);
process.exit(kit.summary());
