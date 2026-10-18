#!/usr/bin/env node
/**
 * End-to-end smoke + security regression test, run against a live stack through the API gateway.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/e2e.mjs [gatewayUrl]
 *
 * Requires every service to be running and a BANK_ADMIN created with
 * `npm run create-admin -w @banksphere/auth-service`.
 * Optional: DATABASE_URL_LEDGER=postgresql://... to also verify the append-only ledger trigger,
 * TRANSACTION_SERVICE_URL to verify the internal API rejects unauthenticated calls.
 */
import crypto from 'node:crypto';

const GATEWAY = process.argv[2] || process.env.GATEWAY_URL || 'http://localhost:8000';
const LEDGER_DIRECT = process.env.TRANSACTION_SERVICE_URL || 'http://localhost:8004';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}${detail !== undefined ? `\n      got: ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

async function api(method, path, { token, body, headers = {}, base = GATEWAY } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

const key = () => crypto.randomUUID();
const runId = crypto.randomBytes(4).toString('hex');

async function register(name) {
  const email = `${name}.${runId}@e2e.test`;
  const res = await api('POST', '/api/v1/auth/register', { body: { email, password: 'Passw0rdStrong' } });
  if (res.status !== 201) throw new Error(`register ${name} failed: ${JSON.stringify(res.body)}`);
  return { email, id: res.body.data.user.id, token: res.body.data.tokens.accessToken, refresh: res.body.data.tokens.refreshToken };
}

async function balance(token, accountId) {
  const res = await api('GET', `/api/v1/transactions/accounts/${accountId}/balance`, { token });
  return res.body?.data?.balanceInPaise;
}

console.log(`\nBankSphere E2E against ${GATEWAY}\n`);

// ---------------------------------------------------------------------------
console.log('Authentication & authorization');
const escalate = await api('POST', '/api/v1/auth/register', {
  body: { email: `mallory.${runId}@e2e.test`, password: 'Passw0rdStrong', role: 'BANK_ADMIN' },
});
check('self-registration with role=BANK_ADMIN is rejected', escalate.status === 400, escalate.body);

const alice = await register('alice');
const bob = await register('bob');
const adminLogin = await api('POST', '/api/v1/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
check('admin can log in', adminLogin.status === 200 && adminLogin.body.data.user.role === 'BANK_ADMIN', adminLogin.body);
const admin = { token: adminLogin.body.data.tokens.accessToken };

const spoof = await api('GET', '/api/v1/accounts', { headers: { 'x-user-id': alice.id, 'x-user-role': 'BANK_ADMIN' } });
check('spoofed x-user-id/x-user-role headers without a token are rejected (401)', spoof.status === 401, spoof.body);

const forged = await api('GET', '/api/v1/accounts', {
  token: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4Iiwicm9sZSI6IkJBTktfQURNSU4ifQ.',
});
check('alg=none forged JWT is rejected', forged.status === 401, forged.body);

const badLogin = await api('POST', '/api/v1/auth/login', { body: { email: alice.email, password: 'wrong-password' } });
check('wrong password gives generic 401', badLogin.status === 401 && /Invalid email or password/.test(badLogin.body.error.message), badLogin.body);

const me = await api('GET', '/api/v1/auth/me', { token: alice.token });
check('GET /auth/me returns the caller', me.status === 200 && me.body.data.email === alice.email, me.body);

// ---------------------------------------------------------------------------
console.log('Refresh token rotation');
const r1 = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refresh } });
check('refresh rotates the token', r1.status === 200 && r1.body.data.refreshToken !== alice.refresh, r1.body);
const replay = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refresh } });
check('replaying a rotated refresh token is rejected', replay.status === 401, replay.body);
const afterReuse = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: r1.body.data.refreshToken } });
check('reuse detection revoked the whole family (new token also dead)', afterReuse.status === 401, afterReuse.body);

const carol = await register('carol');
const raced = await Promise.all(
  Array.from({ length: 5 }, () => api('POST', '/api/v1/auth/refresh', { body: { refreshToken: carol.refresh } }))
);
check('5 concurrent refreshes of one token: at most one succeeds', raced.filter((r) => r.status === 200).length <= 1, raced.map((r) => r.status));

// ---------------------------------------------------------------------------
console.log('Customer profiles & KYC');
const profile = await api('POST', '/api/v1/customers/me', {
  token: alice.token,
  body: { fullName: 'Alice Example', phoneNumber: '+919876543210' },
});
check('customer can create own profile', profile.status === 201, profile.body);
const kycByCustomer = await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: alice.token, body: { kycStatus: 'VERIFIED' } });
check('customer cannot self-verify KYC (403)', kycByCustomer.status === 403, kycByCustomer.body);
const kycByAdmin = await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: admin.token, body: { kycStatus: 'VERIFIED' } });
check('admin can verify KYC', kycByAdmin.status === 200 && kycByAdmin.body.data.kycStatus === 'VERIFIED', kycByAdmin.body);
const meProfile = await api('GET', '/api/v1/customers/me', { token: alice.token });
check('profile read reflects KYC update (cache invalidated)', meProfile.body?.data?.kycStatus === 'VERIFIED', meProfile.body);

// ---------------------------------------------------------------------------
console.log('Accounts & ledger provisioning');
const hugeLimit = await api('POST', '/api/v1/accounts', { token: alice.token, body: { dailyLimitPaise: '999999999999' } });
check('customer cannot open an account with an excessive daily limit', hugeLimit.status === 403, hugeLimit.body);

const aliceAcc = (await api('POST', '/api/v1/accounts', { token: alice.token, body: { accountType: 'SAVINGS' } })).body.data;
const bobAcc = (await api('POST', '/api/v1/accounts', { token: bob.token, body: {} })).body.data;
check('accounts created with 12-digit numbers', /^\d{12}$/.test(aliceAcc?.accountNumber) && /^\d{12}$/.test(bobAcc?.accountNumber), { aliceAcc, bobAcc });
check('ledger account provisioned (balance readable, 0)', (await balance(alice.token, aliceAcc.id)) === '0');

const idor = await api('GET', `/api/v1/accounts/${aliceAcc.id}`, { token: bob.token });
check("IDOR: bob cannot read alice's account (404)", idor.status === 404, idor.body);
const idorBal = await api('GET', `/api/v1/transactions/accounts/${aliceAcc.id}/balance`, { token: bob.token });
check("IDOR: bob cannot read alice's balance (404)", idorBal.status === 404, idorBal.body);

// ---------------------------------------------------------------------------
console.log('Money movement');
const mint = await api('POST', '/api/v1/transactions/deposit', {
  token: alice.token,
  headers: { 'Idempotency-Key': key() },
  body: { accountId: aliceAcc.id, amountInPaise: '100000000' },
});
check('customer cannot deposit (mint money) (403)', mint.status === 403, mint.body);

const dep = await api('POST', '/api/v1/transactions/deposit', {
  token: admin.token,
  headers: { 'Idempotency-Key': key() },
  body: { accountId: aliceAcc.id, amountInPaise: '100000' },
});
check('teller (admin) deposit of 100000 paise succeeds', dep.status === 201, dep.body);
check('alice balance = 100000', (await balance(alice.token, aliceAcc.id)) === '100000');

const steal = await api('POST', '/api/v1/transactions/transfer', {
  token: bob.token,
  headers: { 'Idempotency-Key': key() },
  body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100000' },
});
check("THEFT: bob cannot transfer out of alice's account", steal.status === 404, steal.body);

const stealW = await api('POST', '/api/v1/transactions/withdraw', {
  token: bob.token,
  headers: { 'Idempotency-Key': key() },
  body: { accountId: aliceAcc.id, amountInPaise: '1' },
});
check("THEFT: bob cannot withdraw from alice's account", stealW.status === 404, stealW.body);

const noKey = await api('POST', '/api/v1/transactions/transfer', {
  token: alice.token,
  body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' },
});
check('transfer without Idempotency-Key is rejected (400)', noKey.status === 400, noKey.body);

const insufficient = await api('POST', '/api/v1/transactions/transfer', {
  token: alice.token,
  headers: { 'Idempotency-Key': key() },
  body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '999999999' },
});
check('insufficient funds returns 422 (was 500 before the fix)', insufficient.status === 422 && insufficient.body.error.code === 'INSUFFICIENT_FUNDS', insufficient.body);

const idemKey = key();
const sameKey = await Promise.all(
  Array.from({ length: 10 }, () =>
    api('POST', '/api/v1/transactions/transfer', {
      token: alice.token,
      headers: { 'Idempotency-Key': idemKey },
      body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '1000' },
    })
  )
);
const txIds = new Set(sameKey.filter((r) => r.status === 201).map((r) => r.body.data.transactionId));
check('DOUBLE SPEND: 10 concurrent requests with one Idempotency-Key move money once', txIds.size === 1 && (await balance(alice.token, aliceAcc.id)) === '99000', {
  statuses: sameKey.map((r) => r.status),
  txIds: [...txIds],
});
check('replays return the original response', sameKey.filter((r) => r.headers.get('x-idempotent-replay') === 'true').length >= 1);

const reuse = await api('POST', '/api/v1/transactions/transfer', {
  token: alice.token,
  headers: { 'Idempotency-Key': idemKey },
  body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '5000' },
});
check('reusing a key with a different payload is rejected (422)', reuse.status === 422, reuse.body);

const bobSameKey = await api('POST', '/api/v1/transactions/withdraw', {
  token: bob.token,
  headers: { 'Idempotency-Key': idemKey },
  body: { accountId: bobAcc.id, amountInPaise: '10' },
});
check("keys are per-user: bob's identical key does not replay alice's response", bobSameKey.status === 201 && bobSameKey.body.data.sourceAccountId === bobAcc.id, bobSameKey.body);

// Drain race: 30 concurrent 5000-paise transfers from a 99000 balance -> at most 19 can succeed
const drain = await Promise.all(
  Array.from({ length: 30 }, () =>
    api('POST', '/api/v1/transactions/transfer', {
      token: alice.token,
      headers: { 'Idempotency-Key': key() },
      body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '5000' },
    })
  )
);
const ok = drain.filter((r) => r.status === 201).length;
const finalAlice = BigInt(await balance(alice.token, aliceAcc.id));
check(`OVERDRAFT RACE: 30 concurrent transfers -> ${ok} succeeded, balance never negative`, ok === 19 && finalAlice === 99000n - BigInt(ok) * 5000n && finalAlice >= 0n, {
  ok,
  finalAlice: finalAlice.toString(),
  statuses: drain.map((r) => r.status),
});
const finalBob = BigInt(await balance(bob.token, bobAcc.id));
check('money is conserved (alice + bob = deposits - bob withdrawal)', finalAlice + finalBob === 100000n - 10n, {
  finalAlice: finalAlice.toString(),
  finalBob: finalBob.toString(),
});

const history = await api('GET', `/api/v1/transactions/accounts/${aliceAcc.id}/history?limit=1000`, { token: alice.token });
check('history pagination is clamped to 100', history.status === 200 && history.body.pagination.limit === 100, history.body?.pagination);

// ---------------------------------------------------------------------------
console.log('Daily limit');
const lowLimit = await api('PATCH', `/api/v1/accounts/${bobAcc.id}/daily-limit`, { token: bob.token, body: { dailyLimitPaise: '50000' } });
check('customer can lower their own daily limit', lowLimit.status === 200, lowLimit.body);
const overLimit = await api('POST', '/api/v1/transactions/withdraw', {
  token: bob.token,
  headers: { 'Idempotency-Key': key() },
  body: { accountId: bobAcc.id, amountInPaise: '50000' },
});
check('withdrawal over the remaining daily limit is rejected (422 DAILY_LIMIT_EXCEEDED)', overLimit.status === 422 && overLimit.body.error.code === 'DAILY_LIMIT_EXCEEDED', overLimit.body);

// ---------------------------------------------------------------------------
console.log('Freeze / unfreeze');
const freeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: alice.token, body: { status: 'FROZEN' } });
check('customer can freeze own account', freeze.status === 200 && freeze.body.data.status === 'FROZEN', freeze.body);
const whileFrozen = await api('POST', '/api/v1/transactions/transfer', {
  token: alice.token,
  headers: { 'Idempotency-Key': key() },
  body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' },
});
check('frozen account cannot send money (ledger enforced)', whileFrozen.status === 403 && whileFrozen.body.error.code === 'ACCOUNT_INACTIVE', whileFrozen.body);
const selfUnfreeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: alice.token, body: { status: 'ACTIVE' } });
check('customer cannot unfreeze (403)', selfUnfreeze.status === 403, selfUnfreeze.body);
const adminUnfreeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: admin.token, body: { status: 'ACTIVE' } });
check('admin can unfreeze', adminUnfreeze.status === 200 && adminUnfreeze.body.data.status === 'ACTIVE', adminUnfreeze.body);
const closeWithMoney = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: admin.token, body: { status: 'CLOSED' } });
check('account with balance cannot be closed (409)', closeWithMoney.status === 409, closeWithMoney.body);

// ---------------------------------------------------------------------------
console.log('Staff-only data & internal API');
const fraudAsCustomer = await api('GET', '/api/v1/fraud/alerts', { token: alice.token });
check('customer cannot read fraud alerts (403)', fraudAsCustomer.status === 403, fraudAsCustomer.body);
const fraudAsAdmin = await api('GET', '/api/v1/fraud/alerts', { token: admin.token });
check('admin can read fraud alerts', fraudAsAdmin.status === 200, fraudAsAdmin.body);
const logsAsCustomer = await api('GET', '/api/v1/notifications/logs', { token: alice.token });
check('customer cannot read notification logs (403)', logsAsCustomer.status === 403, logsAsCustomer.body);
const internalViaGateway = await api('POST', '/internal/v1/ledger-accounts', { body: {} });
check('internal API is not reachable through the gateway (404)', internalViaGateway.status === 404, internalViaGateway.body);
const internalDirect = await api('PATCH', `/internal/v1/ledger-accounts/${aliceAcc.id}`, {
  base: LEDGER_DIRECT,
  body: { dailyLimitPaise: '999999999999' },
});
check('internal API rejects calls without the service token (401)', internalDirect.status === 401, internalDirect.body);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
