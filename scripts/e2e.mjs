#!/usr/bin/env node
/**
 * End-to-end functional + security regression suite, run against a live stack through the API gateway.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/e2e.mjs
 *
 * Environment:
 *   GATEWAY_URL              default http://localhost:8000
 *   MAILPIT_URL              default http://localhost:8025 (dev SMTP capture; used to read verification/reset emails)
 *   TRANSACTION_SERVICE_URL  default http://localhost:8004 (set to "skip" when services aren't reachable directly)
 *
 * Requires a BANK_ADMIN created with `npm run create-admin -w @banksphere/auth-service` and Kafka running
 * (the suite waits for event-driven notifications and fraud alerts).
 */
import crypto from 'node:crypto';

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8000';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
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
    console.log(`  ✘ ${name}${detail !== undefined ? `\n      got: ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
  }
}
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverErrors = [];

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
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function waitFor(fn, { timeoutMs = 45000, intervalMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

/** Waits for an email to `to` whose subject matches, and returns its text body */
async function waitForEmail(to, subjectPattern, { notIds = new Set(), timeoutMs } = {}) {
  return waitFor(async () => {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
    if (!res.ok) return null;
    const { messages = [] } = await res.json();
    const match = messages.find((m) => subjectPattern.test(m.Subject) && !notIds.has(m.ID));
    if (!match) return null;
    const full = await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json();
    return { id: match.ID, subject: match.Subject, text: full.Text, html: full.HTML };
  }, { timeoutMs });
}

const tokenFrom = (text) => decodeURIComponent(/#token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? '');
const key = () => crypto.randomUUID();
const runId = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'Passw0rdStrong';

async function registerVerified(name) {
  const email = `${name}.${runId}@e2e.test`;
  const reg = await api('POST', '/api/v1/auth/register', { body: { email, password: PASSWORD } });
  if (reg.status !== 202) throw new Error(`register ${name}: ${JSON.stringify(reg.body)}`);
  const mail = await waitForEmail(email, /Verify your BankSphere email/);
  if (!mail) throw new Error(`no verification email for ${name}`);
  const verify = await api('POST', '/api/v1/auth/email/verify', { body: { token: tokenFrom(mail.text) } });
  if (verify.status !== 200) throw new Error(`verify ${name}: ${JSON.stringify(verify.body)}`);
  const login = await api('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`login ${name}: ${JSON.stringify(login.body)}`);
  return {
    email,
    id: login.body.data.user.id,
    token: login.body.data.tokens.accessToken,
    refresh: login.body.data.tokens.refreshToken,
  };
}

async function kycVerified(user, admin) {
  await api('POST', '/api/v1/customers/me', {
    token: user.token,
    body: { fullName: `E2E ${user.email.split('.')[0]}`, phoneNumber: '+919876543210' },
  });
  await api('PATCH', `/api/v1/customers/${user.id}/kyc`, { token: admin.token, body: { kycStatus: 'VERIFIED' } });
}

async function balance(token, accountId) {
  const res = await api('GET', `/api/v1/transactions/accounts/${accountId}/balance`, { token });
  return res.body?.data?.balanceInPaise;
}

console.log(`BankSphere E2E against ${GATEWAY} (run ${runId})`);

// ---------------------------------------------------------------------------
section('Registration & email verification');
const escalate = await api('POST', '/api/v1/auth/register', {
  body: { email: `mallory.${runId}@e2e.test`, password: PASSWORD, role: 'BANK_ADMIN' },
});
check('self-registration with role=BANK_ADMIN is rejected (400)', escalate.status === 400, escalate.body);

const weak = await api('POST', '/api/v1/auth/register', { body: { email: `weak.${runId}@e2e.test`, password: 'password' } });
check('weak password is rejected (400)', weak.status === 400, weak.body);

const pendingEmail = `pending.${runId}@e2e.test`;
const reg = await api('POST', '/api/v1/auth/register', { body: { email: pendingEmail, password: PASSWORD } });
check('registration answers 202 without issuing tokens', reg.status === 202 && !reg.body.data, reg.body);
const unverifiedLogin = await api('POST', '/api/v1/auth/login', { body: { email: pendingEmail, password: PASSWORD } });
check('login before verifying email is refused (403 EMAIL_NOT_VERIFIED)', unverifiedLogin.status === 403 && unverifiedLogin.body.error.code === 'EMAIL_NOT_VERIFIED', unverifiedLogin.body);
const dupReg = await api('POST', '/api/v1/auth/register', { body: { email: pendingEmail, password: PASSWORD } });
check('ENUMERATION: registering an existing email gives the identical 202 response', dupReg.status === 202 && dupReg.body.message === reg.body.message, dupReg.body);
const dupMail = await waitForEmail(pendingEmail, /Sign-up attempt/);
check('...and the owner gets a "sign-up attempt" notice instead', Boolean(dupMail));

const verifyMail = await waitForEmail(pendingEmail, /Verify your BankSphere email/);
check('verification email delivered over SMTP with a #token= link', Boolean(verifyMail) && /verify-email#token=/.test(verifyMail.text), verifyMail?.text);
check('verification email has an HTML part', Boolean(verifyMail?.html) && /<a href=/.test(verifyMail.html));
const badVerify = await api('POST', '/api/v1/auth/email/verify', { body: { token: 'A'.repeat(43) } });
check('forged verification token is rejected (400)', badVerify.status === 400, badVerify.body);
const goodVerify = await api('POST', '/api/v1/auth/email/verify', { body: { token: tokenFrom(verifyMail.text) } });
check('valid verification token verifies the email', goodVerify.status === 200, goodVerify.body);
const replayVerify = await api('POST', '/api/v1/auth/email/verify', { body: { token: tokenFrom(verifyMail.text) } });
check('verification token is single-use', replayVerify.status === 400, replayVerify.body);

// ---------------------------------------------------------------------------
section('Authentication & sessions');
const alice = await registerVerified('alice');
const bob = await registerVerified('bob');
const adminLogin = await api('POST', '/api/v1/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
check('admin can log in', adminLogin.status === 200 && adminLogin.body.data.user.role === 'BANK_ADMIN', adminLogin.body);
const admin = { token: adminLogin.body.data?.tokens?.accessToken };

const spoof = await api('GET', '/api/v1/accounts', { headers: { 'x-user-id': alice.id, 'x-user-role': 'BANK_ADMIN' } });
check('spoofed x-user-id/x-user-role headers without a token are rejected (401)', spoof.status === 401, spoof.body);
const forged = await api('GET', '/api/v1/accounts', {
  token: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4Iiwicm9sZSI6IkJBTktfQURNSU4ifQ.',
});
check('alg=none forged JWT is rejected (401)', forged.status === 401, forged.body);

const me = await api('GET', '/api/v1/auth/me', { token: alice.token });
check('GET /auth/me returns the caller', me.status === 200 && me.body.data.email === alice.email && me.body.data.isEmailVerified === true, me.body);

const r1 = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refresh } });
check('refresh rotates the refresh token', r1.status === 200 && r1.body.data.refreshToken !== alice.refresh, r1.body);
const replay = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refresh } });
check('replaying a rotated refresh token is rejected', replay.status === 401, replay.body);
const afterReuse = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: r1.body.data.refreshToken } });
check('reuse detection revoked the whole family', afterReuse.status === 401, afterReuse.body);

const carol = await registerVerified('carol');
const raced = await Promise.all(
  Array.from({ length: 5 }, () => api('POST', '/api/v1/auth/refresh', { body: { refreshToken: carol.refresh } }))
);
check('5 concurrent refreshes of one token: at most one succeeds', raced.filter((r) => r.status === 200).length <= 1, raced.map((r) => r.status));

// Logout revokes the access token immediately (Redis denylist), not at expiry
const dave = await registerVerified('dave');
check('access token works before logout', (await api('GET', '/api/v1/auth/me', { token: dave.token })).status === 200);
const logout = await api('POST', '/api/v1/auth/logout', { token: dave.token, body: { refreshToken: dave.refresh } });
check('logout succeeds', logout.status === 200, logout.body);
const afterLogout = await api('GET', '/api/v1/accounts', { token: dave.token });
check('REVOCATION: the access token is rejected right after logout (on another service)', afterLogout.status === 401, afterLogout.body);
const refreshAfterLogout = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: dave.refresh } });
check('refresh token is dead after logout', refreshAfterLogout.status === 401, refreshAfterLogout.body);

// Brute force: per-account lockout
const erin = await registerVerified('erin');
const bad = [];
for (let i = 0; i < 5; i++) {
  bad.push((await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: `WrongPass${i}x` } })).status);
}
const locked = await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: PASSWORD } });
check('LOCKOUT: after 5 wrong passwords even the right one is refused (429)', bad.every((s) => s === 401) && locked.status === 429, { bad, locked: locked.status });
const ghostLock = [];
for (let i = 0; i < 6; i++) {
  ghostLock.push((await api('POST', '/api/v1/auth/login', { body: { email: `ghost.${runId}@e2e.test`, password: `WrongPass${i}x` } })).status);
}
check('ENUMERATION: unknown emails lock out identically', ghostLock.slice(0, 5).every((s) => s === 401) && ghostLock[5] === 429, ghostLock);

// ---------------------------------------------------------------------------
section('Forgot / reset / change password');
const forgotUnknown = await api('POST', '/api/v1/auth/password/forgot', { body: { email: `nobody.${runId}@e2e.test` } });
const forgotErin = await api('POST', '/api/v1/auth/password/forgot', { body: { email: erin.email } });
check('ENUMERATION: forgot-password answers identically for known and unknown emails', forgotUnknown.status === 202 && forgotErin.status === 202 && forgotUnknown.body.message === forgotErin.body.message, [forgotUnknown.body, forgotErin.body]);
const resetMail = await waitForEmail(erin.email, /Reset your BankSphere password/);
check('reset email delivered with a #token= link', Boolean(resetMail) && /reset-password#token=/.test(resetMail.text), resetMail?.text);
const resetToken = tokenFrom(resetMail?.text ?? '');
const weakReset = await api('POST', '/api/v1/auth/password/reset', { body: { token: resetToken, newPassword: 'short' } });
check('reset with a weak password is rejected (400)', weakReset.status === 400, weakReset.body);
const NEW_PASSWORD = 'BrandNewPassw0rd';
const reset = await api('POST', '/api/v1/auth/password/reset', { body: { token: resetToken, newPassword: NEW_PASSWORD } });
check('reset with a valid token succeeds', reset.status === 200, reset.body);
const resetReplay = await api('POST', '/api/v1/auth/password/reset', { body: { token: resetToken, newPassword: 'AnotherPassw0rd1' } });
check('reset token is single-use', resetReplay.status === 400, resetReplay.body);
const oldAccess = await api('GET', '/api/v1/auth/me', { token: erin.token });
check('REVOCATION: access tokens issued before the reset are rejected', oldAccess.status === 401, oldAccess.body);
const oldRefresh = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: erin.refresh } });
check('refresh tokens issued before the reset are rejected', oldRefresh.status === 401, oldRefresh.body);
const oldPwLogin = await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: PASSWORD } });
const newPwLogin = await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: NEW_PASSWORD } });
check('old password no longer works; new one does (and the lockout was cleared)', oldPwLogin.status === 401 && newPwLogin.status === 200, [oldPwLogin.status, newPwLogin.body]);
const changedMail = await waitForEmail(erin.email, /password was changed/);
check('"password changed" security notice emailed', Boolean(changedMail));

const erinToken = newPwLogin.body.data?.tokens?.accessToken;
const wrongCurrent = await api('POST', '/api/v1/auth/password/change', { token: erinToken, body: { currentPassword: 'NotIt12345', newPassword: 'ChangedPassw0rd' } });
check('change-password requires the current password', wrongCurrent.status === 401, wrongCurrent.body);
const change = await api('POST', '/api/v1/auth/password/change', { token: erinToken, body: { currentPassword: NEW_PASSWORD, newPassword: 'ChangedPassw0rd' } });
check('change-password succeeds and returns fresh tokens', change.status === 200 && change.body.data.tokens.accessToken, change.body);
check('...the previous access token is revoked', (await api('GET', '/api/v1/auth/me', { token: erinToken })).status === 401);
check('...the fresh access token works', (await api('GET', '/api/v1/auth/me', { token: change.body.data?.tokens?.accessToken })).status === 200);

// ---------------------------------------------------------------------------
section('Customer profiles & KYC');
const profile = await api('POST', '/api/v1/customers/me', { token: alice.token, body: { fullName: 'Alice Example', phoneNumber: '+919876543210' } });
check('customer can create own profile', profile.status === 201, profile.body);
const noKycAccount = await api('POST', '/api/v1/accounts', { token: alice.token, body: {} });
check('KYC: account opening is refused until KYC is verified (403 KYC_NOT_VERIFIED)', noKycAccount.status === 403 && noKycAccount.body.error.code === 'KYC_NOT_VERIFIED', noKycAccount.body);
const kycByCustomer = await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: alice.token, body: { kycStatus: 'VERIFIED' } });
check('customer cannot self-verify KYC (403)', kycByCustomer.status === 403, kycByCustomer.body);
const kycByAdmin = await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: admin.token, body: { kycStatus: 'VERIFIED' } });
check('admin can verify KYC', kycByAdmin.status === 200 && kycByAdmin.body.data.kycStatus === 'VERIFIED', kycByAdmin.body);
const meProfile = await api('GET', '/api/v1/customers/me', { token: alice.token });
check('profile read reflects KYC update (cache invalidated)', meProfile.body?.data?.kycStatus === 'VERIFIED', meProfile.body);
await kycVerified(bob, admin);

// ---------------------------------------------------------------------------
section('Accounts & ledger provisioning');
const hugeLimit = await api('POST', '/api/v1/accounts', { token: alice.token, body: { dailyLimitPaise: '999999999999' } });
check('customer cannot open an account with an excessive daily limit', hugeLimit.status === 403, hugeLimit.body);
const aliceAcc = (await api('POST', '/api/v1/accounts', { token: alice.token, body: { accountType: 'SAVINGS' } })).body.data;
const bobAcc = (await api('POST', '/api/v1/accounts', { token: bob.token, body: {} })).body.data;
check('accounts created with 12-digit numbers', /^\d{12}$/.test(aliceAcc?.accountNumber) && /^\d{12}$/.test(bobAcc?.accountNumber), { aliceAcc, bobAcc });
check('ledger account provisioned (balance 0)', (await balance(alice.token, aliceAcc.id)) === '0');
const idor = await api('GET', `/api/v1/accounts/${aliceAcc.id}`, { token: bob.token });
check("IDOR: bob cannot read alice's account (404)", idor.status === 404, idor.body);
const idorBal = await api('GET', `/api/v1/transactions/accounts/${aliceAcc.id}/balance`, { token: bob.token });
check("IDOR: bob cannot read alice's balance (404)", idorBal.status === 404, idorBal.body);
const welcome = await waitForEmail(alice.email, /Welcome to BankSphere/);
check('KAFKA: account.created.v1 -> welcome email to the real owner, account number masked', Boolean(welcome) && /X{8}\d{4}/.test(welcome.text) && !welcome.text.includes(aliceAcc.accountNumber), welcome?.text);

// ---------------------------------------------------------------------------
section('Money movement');
const mint = await api('POST', '/api/v1/transactions/deposit', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { accountId: aliceAcc.id, amountInPaise: '100000000' } });
check('customer cannot deposit (mint money) (403)', mint.status === 403, mint.body);
const dep = await api('POST', '/api/v1/transactions/deposit', { token: admin.token, headers: { 'Idempotency-Key': key() }, body: { accountId: aliceAcc.id, amountInPaise: '100000' } });
check('teller (admin) deposit succeeds', dep.status === 201, dep.body);
check('alice balance = 100000', (await balance(alice.token, aliceAcc.id)) === '100000');
const depositMail = await waitForEmail(alice.email, /credited to your account/);
check('KAFKA: transaction.completed.v1 -> credit alert email to alice', Boolean(depositMail), depositMail);

const steal = await api('POST', '/api/v1/transactions/transfer', { token: bob.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100000' } });
check("THEFT: bob cannot transfer out of alice's account", steal.status === 404, steal.body);
const stealW = await api('POST', '/api/v1/transactions/withdraw', { token: bob.token, headers: { 'Idempotency-Key': key() }, body: { accountId: aliceAcc.id, amountInPaise: '1' } });
check("THEFT: bob cannot withdraw from alice's account", stealW.status === 404, stealW.body);
const noKey = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' } });
check('transfer without Idempotency-Key is rejected (400)', noKey.status === 400, noKey.body);
const insufficient = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '999999999' } });
check('insufficient funds returns 422 INSUFFICIENT_FUNDS', insufficient.status === 422 && insufficient.body.error.code === 'INSUFFICIENT_FUNDS', insufficient.body);

const idemKey = key();
const sameKey = await Promise.all(
  Array.from({ length: 10 }, () =>
    api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': idemKey }, body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '1000' } })
  )
);
const txIds = new Set(sameKey.filter((r) => r.status === 201).map((r) => r.body.data.transactionId));
check('DOUBLE SPEND: 10 concurrent requests with one Idempotency-Key move money once', txIds.size === 1 && (await balance(alice.token, aliceAcc.id)) === '99000', { statuses: sameKey.map((r) => r.status), txIds: [...txIds] });
const reuse = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': idemKey }, body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '5000' } });
check('reusing a key with a different payload is rejected (422)', reuse.status === 422, reuse.body);
const bobSameKey = await api('POST', '/api/v1/transactions/withdraw', { token: bob.token, headers: { 'Idempotency-Key': idemKey }, body: { accountId: bobAcc.id, amountInPaise: '10' } });
check("keys are per-user: bob's identical key does not replay alice's response", bobSameKey.status === 201 && bobSameKey.body.data.sourceAccountId === bobAcc.id, bobSameKey.body);

const drain = await Promise.all(
  Array.from({ length: 30 }, () =>
    api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '5000' } })
  )
);
const ok = drain.filter((r) => r.status === 201).length;
const finalAlice = BigInt(await balance(alice.token, aliceAcc.id));
const drainStatuses = new Set(drain.map((r) => r.status));
check('OVERDRAFT RACE: every losing request gets a clean 422 (no 5xx under contention)', [...drainStatuses].every((s) => s === 201 || s === 422), [...drainStatuses]);
check(`OVERDRAFT RACE: 30 concurrent transfers -> ${ok} succeeded, balance never negative`, ok === 19 && finalAlice === 99000n - BigInt(ok) * 5000n, { ok, finalAlice: finalAlice.toString(), statuses: drain.map((r) => r.status) });
const finalBob = BigInt(await balance(bob.token, bobAcc.id));
check('money is conserved', finalAlice + finalBob === 100000n - 10n, { finalAlice: finalAlice.toString(), finalBob: finalBob.toString() });
const history = await api('GET', `/api/v1/transactions/accounts/${aliceAcc.id}/history?limit=1000`, { token: alice.token });
check('history pagination is clamped to 100', history.status === 200 && history.body.pagination.limit === 100, history.body?.pagination);

// ---------------------------------------------------------------------------
section('Daily limit, freeze, fraud');
const lowLimit = await api('PATCH', `/api/v1/accounts/${bobAcc.id}/daily-limit`, { token: bob.token, body: { dailyLimitPaise: '50000' } });
check('customer can lower their own daily limit', lowLimit.status === 200, lowLimit.body);
const overLimit = await api('POST', '/api/v1/transactions/withdraw', { token: bob.token, headers: { 'Idempotency-Key': key() }, body: { accountId: bobAcc.id, amountInPaise: '50000' } });
check('withdrawal over the remaining daily limit is rejected (422 DAILY_LIMIT_EXCEEDED)', overLimit.status === 422 && overLimit.body.error.code === 'DAILY_LIMIT_EXCEEDED', overLimit.body);

const freeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: alice.token, body: { status: 'FROZEN' } });
check('customer can freeze own account', freeze.status === 200 && freeze.body.data.status === 'FROZEN', freeze.body);
const whileFrozen = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' } });
check('frozen account cannot send money (ledger enforced)', whileFrozen.status === 403 && whileFrozen.body.error.code === 'ACCOUNT_INACTIVE', whileFrozen.body);
const selfUnfreeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: alice.token, body: { status: 'ACTIVE' } });
check('customer cannot unfreeze (403)', selfUnfreeze.status === 403, selfUnfreeze.body);
const adminUnfreeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: admin.token, body: { status: 'ACTIVE' } });
check('admin can unfreeze', adminUnfreeze.status === 200 && adminUnfreeze.body.data.status === 'ACTIVE', adminUnfreeze.body);
const statusMail = await waitForEmail(alice.email, /your account is now FROZEN/);
check('KAFKA: account.status.changed.v1 -> freeze notice email', Boolean(statusMail));
const closeWithMoney = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: admin.token, body: { status: 'CLOSED' } });
check('account with balance cannot be closed (409)', closeWithMoney.status === 409, closeWithMoney.body);

// High-value transfer -> fraud alert via Kafka -> security team email
await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/daily-limit`, { token: admin.token, body: { dailyLimitPaise: '100000000' } });
await api('POST', '/api/v1/transactions/deposit', { token: admin.token, headers: { 'Idempotency-Key': key() }, body: { accountId: aliceAcc.id, amountInPaise: '30000000' } });
const big = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '25000000' } });
check('high-value transfer (Rs 2.5 lakh) succeeds within the raised limit', big.status === 201, big.body);
const alert = await waitFor(async () => {
  const res = await api('GET', '/api/v1/fraud/alerts?limit=100', { token: admin.token });
  return res.body?.data?.find((a) => a.transactionId === big.body?.data?.transactionId);
});
check('KAFKA: fraud-service raised a HIGH alert for the high-value transfer', alert && ['HIGH', 'CRITICAL'].includes(alert.severity), alert);
const triage = alert && (await api('PATCH', `/api/v1/fraud/alerts/${alert.id}`, { token: admin.token, body: { status: 'UNDER_REVIEW' } }));
check('admin can triage the alert', triage?.status === 200 && triage.body.data.status === 'UNDER_REVIEW', triage?.body);

// ---------------------------------------------------------------------------
section('Staff-only data, admin controls & internal API');
const fraudAsCustomer = await api('GET', '/api/v1/fraud/alerts', { token: alice.token });
check('customer cannot read fraud alerts (403)', fraudAsCustomer.status === 403, fraudAsCustomer.body);
const logsAsCustomer = await api('GET', '/api/v1/notifications/logs', { token: alice.token });
check('customer cannot read notification logs (403)', logsAsCustomer.status === 403, logsAsCustomer.body);
const logsAsAdmin = await api('GET', `/api/v1/notifications/logs?recipient=${encodeURIComponent(alice.email)}`, { token: admin.token });
check('admin can audit notification logs', logsAsAdmin.status === 200 && logsAsAdmin.body.data.length >= 2, logsAsAdmin.body?.data?.length);

const disable = await api('PATCH', `/api/v1/auth/admin/users/${bob.id}/status`, { token: admin.token, body: { isActive: false } });
check('admin can disable a user', disable.status === 200 && disable.body.data.isActive === false, disable.body);
const bobAfterDisable = await api('GET', `/api/v1/accounts/${bobAcc.id}`, { token: bob.token });
check('REVOCATION: a disabled user is locked out immediately (old access token rejected)', bobAfterDisable.status === 401, bobAfterDisable.body);
const bobLogin = await api('POST', '/api/v1/auth/login', { body: { email: bob.email, password: PASSWORD } });
check('disabled user cannot log in', bobLogin.status === 401, bobLogin.body);

const internalViaGateway = await api('POST', '/internal/v1/ledger-accounts', { body: {} });
check('internal API is not reachable through the gateway (404)', internalViaGateway.status === 404, internalViaGateway.body);
if (LEDGER_DIRECT !== 'skip') {
  const internalDirect = await api('PATCH', `/internal/v1/ledger-accounts/${aliceAcc.id}`, { base: LEDGER_DIRECT, body: { dailyLimitPaise: '999999999999' } });
  check('internal API rejects calls without the service token (401)', internalDirect.status === 401, internalDirect.body);
}

section('Global');
check('no request in the whole run returned a 5xx', serverErrors.length === 0, serverErrors);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
