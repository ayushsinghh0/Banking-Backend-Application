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
 *   ADMIN_TOTP_SECRET        the bootstrap admin's TOTP secret. If unset, the suite enrols MFA on first run
 *                            and remembers the secret in scripts/.e2e-state.json (git-ignored).
 *
 * Requires a BANK_ADMIN created with `npm run create-admin -w @banksphere/auth-service` and Kafka running.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8000';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
const LEDGER_DIRECT = process.env.TRANSACTION_SERVICE_URL || 'http://localhost:8004';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.e2e-state.json');
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

async function api(method, p, { token, body, headers = {}, base = GATEWAY } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 500) serverErrors.push(`${method} ${p} -> ${res.status} ${text.slice(0, 200)}`);
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

async function waitForEmail(to, subjectPattern, { timeoutMs } = {}) {
  return waitFor(async () => {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
    if (!res.ok) return null;
    const { messages = [] } = await res.json();
    const match = messages.find((m) => subjectPattern.test(m.Subject));
    if (!match) return null;
    const full = await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json();
    return { id: match.ID, subject: match.Subject, text: full.Text, html: full.HTML };
  }, { timeoutMs });
}

// --- RFC 6238 TOTP (same algorithm as authenticator apps) ---
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const c of input.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
}
/**
 * A code for a time step not used before by this secret. Codes are single-use server-side, so the last
 * used step is remembered across runs (scripts/.e2e-state.json) — re-running within 30s waits for the next window.
 */
const persisted = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const usedSteps = new Map(Object.entries(persisted.usedSteps ?? {}));
function saveState(extra = {}) {
  const current = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...current, ...extra, usedSteps: Object.fromEntries(usedSteps) }, null, 2), { mode: 0o600 });
}
async function freshTotp(secret) {
  for (;;) {
    const step = Math.floor(Date.now() / 30000);
    if ((usedSteps.get(secret) ?? -1) < step) {
      usedSteps.set(secret, step);
      saveState();
      return totp(secret, step);
    }
    await sleep(1000);
  }
}

const tokenFrom = (text) => decodeURIComponent(/#token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? '');
const key = () => crypto.randomUUID();
const runId = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'Passw0rdStrong';

/** Logs in, completing the MFA step when enrolled. Returns the login response data. */
async function login(email, password, totpSecret) {
  const res = await api('POST', '/api/v1/auth/login', { body: { email, password } });
  if (res.status !== 200) return res;
  if (!res.body.data.mfaRequired) return res;
  if (!totpSecret) return res;
  return api('POST', '/api/v1/auth/login/mfa', { body: { challengeToken: res.body.data.challengeToken, code: await freshTotp(totpSecret) } });
}

/** Enrols TOTP for a logged-in user; returns { secret, tokens } */
async function enrolMfa(accessToken) {
  const setup = await api('POST', '/api/v1/auth/mfa/setup', { token: accessToken });
  const secret = setup.body?.data?.secret;
  const enable = await api('POST', '/api/v1/auth/mfa/enable', { token: accessToken, body: { code: await freshTotp(secret) } });
  return { secret, tokens: enable.body?.data?.tokens, setupStatus: setup.status, enableStatus: enable.status };
}

async function registerVerified(name) {
  const email = `${name}.${runId}@e2e.test`;
  const reg = await api('POST', '/api/v1/auth/register', { body: { email, password: PASSWORD } });
  if (reg.status !== 202) throw new Error(`register ${name}: ${JSON.stringify(reg.body)}`);
  const mail = await waitForEmail(email, /Verify your BankSphere email/);
  if (!mail) throw new Error(`no verification email for ${name}`);
  const verify = await api('POST', '/api/v1/auth/email/verify', { body: { token: tokenFrom(mail.text) } });
  if (verify.status !== 200) throw new Error(`verify ${name}: ${JSON.stringify(verify.body)}`);
  const res = await login(email, PASSWORD);
  if (res.status !== 200) throw new Error(`login ${name}: ${JSON.stringify(res.body)}`);
  return { email, id: res.body.data.user.id, token: res.body.data.tokens.accessToken, refresh: res.body.data.tokens.refreshToken };
}

async function kycVerified(user, admin) {
  await api('POST', '/api/v1/customers/me', { token: user.token, body: { fullName: `E2E ${user.email.split('.')[0]}`, phoneNumber: '+919876543210' } });
  await api('PATCH', `/api/v1/customers/${user.id}/kyc`, { token: admin.token, body: { kycStatus: 'VERIFIED' } });
}

async function balance(token, accountId) {
  const res = await api('GET', `/api/v1/transactions/accounts/${accountId}/balance`, { token });
  return res.body?.data?.balanceInPaise;
}

console.log(`BankSphere E2E against ${GATEWAY} (run ${runId})`);

// ---------------------------------------------------------------------------
section('Staff sign-in & MFA');
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
let adminSecret = process.env.ADMIN_TOTP_SECRET || state[ADMIN_EMAIL];
let adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD, adminSecret);
if (adminLogin.status === 200 && !adminLogin.body.data.mfaRequired && adminLogin.body.data.tokens && !adminSecret) {
  const noMfaToken = adminLogin.body.data.tokens.accessToken;
  const blocked = await api('GET', '/api/v1/fraud/alerts', { token: noMfaToken });
  check('MFA: a staff session without MFA cannot use privileged APIs (403 MFA_REQUIRED)', blocked.status === 403 && blocked.body.error.code === 'MFA_REQUIRED', blocked.body);
  const enrol = await enrolMfa(noMfaToken);
  check('MFA: staff can enrol TOTP with the restricted session', enrol.setupStatus === 200 && enrol.enableStatus === 200, enrol);
  adminSecret = enrol.secret;
  saveState({ [ADMIN_EMAIL]: adminSecret });
  adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD, adminSecret);
}
const pwOnly = await api('POST', '/api/v1/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
check('MFA: with MFA enrolled, the password alone only returns a challenge (no tokens)', pwOnly.status === 200 && pwOnly.body.data.mfaRequired === true && !pwOnly.body.data.tokens, pwOnly.body);
const badCode = await api('POST', '/api/v1/auth/login/mfa', { body: { challengeToken: pwOnly.body.data?.challengeToken, code: '000000' } });
check('MFA: a wrong code is rejected', badCode.status === 401, badCode.body);
check('admin completes login with password + TOTP', adminLogin.status === 200 && adminLogin.body.data.user.role === 'BANK_ADMIN', adminLogin.body);
if (adminLogin.status !== 200 || !adminLogin.body.data.tokens) {
  console.error('\nCannot continue without an admin session.');
  process.exit(1);
}
const admin = { token: adminLogin.body.data?.tokens?.accessToken, id: adminLogin.body.data?.user?.id };

// A second administrator, so cash operations can be approved by someone other than the requester
const checkerEmail = `checker.${runId}@e2e.test`;
const createChecker = await api('POST', '/api/v1/auth/admin/users', { token: admin.token, body: { email: checkerEmail, password: PASSWORD, role: 'BANK_ADMIN' } });
check('admin (MFA) can create another administrator', createChecker.status === 201, createChecker.body);
const checkerFirst = await login(checkerEmail, PASSWORD);
const checkerEnrol = await enrolMfa(checkerFirst.body.data.tokens.accessToken);
const checker = { token: checkerEnrol.tokens?.accessToken, id: checkerFirst.body.data.user.id };
check('new administrator enrols MFA and gets an MFA session', Boolean(checker.token), checkerEnrol);
const replayCode = totp(checkerEnrol.secret, usedSteps.get(checkerEnrol.secret));
const checkerReplay = await api('POST', '/api/v1/auth/login', { body: { email: checkerEmail, password: PASSWORD } });
const replayAttempt = await api('POST', '/api/v1/auth/login/mfa', { body: { challengeToken: checkerReplay.body.data?.challengeToken, code: replayCode } });
check('MFA REPLAY: an already-used TOTP code cannot be used again', replayAttempt.status === 401, replayAttempt.body);

// ---------------------------------------------------------------------------
section('Registration & email verification');
const escalate = await api('POST', '/api/v1/auth/register', { body: { email: `mallory.${runId}@e2e.test`, password: PASSWORD, role: 'BANK_ADMIN' } });
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
check('...and the owner gets a "sign-up attempt" notice instead', Boolean(await waitForEmail(pendingEmail, /Sign-up attempt/)));
const verifyMail = await waitForEmail(pendingEmail, /Verify your BankSphere email/);
check('verification email delivered over SMTP (text + HTML) with a #token= link', Boolean(verifyMail) && /verify-email#token=/.test(verifyMail.text) && /<a href=/.test(verifyMail.html ?? ''), verifyMail?.text);
check('forged verification token is rejected (400)', (await api('POST', '/api/v1/auth/email/verify', { body: { token: 'A'.repeat(43) } })).status === 400);
check('valid verification token verifies the email', (await api('POST', '/api/v1/auth/email/verify', { body: { token: tokenFrom(verifyMail.text) } })).status === 200);
check('verification token is single-use', (await api('POST', '/api/v1/auth/email/verify', { body: { token: tokenFrom(verifyMail.text) } })).status === 400);

// ---------------------------------------------------------------------------
section('Sessions, revocation & brute force');
const alice = await registerVerified('alice');
const bob = await registerVerified('bob');
const spoof = await api('GET', '/api/v1/accounts', { headers: { 'x-user-id': alice.id, 'x-user-role': 'BANK_ADMIN' } });
check('spoofed x-user-id/x-user-role headers without a token are rejected (401)', spoof.status === 401, spoof.body);
const forged = await api('GET', '/api/v1/accounts', { token: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4Iiwicm9sZSI6IkJBTktfQURNSU4ifQ.' });
check('alg=none forged JWT is rejected (401)', forged.status === 401, forged.body);
const me = await api('GET', '/api/v1/auth/me', { token: alice.token });
check('GET /auth/me returns the caller', me.status === 200 && me.body.data.email === alice.email, me.body);

const r1 = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refresh } });
check('refresh rotates the refresh token', r1.status === 200 && r1.body.data.refreshToken !== alice.refresh, r1.body);
check('replaying a rotated refresh token is rejected', (await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refresh } })).status === 401);
check('reuse detection revoked the whole family', (await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: r1.body.data.refreshToken } })).status === 401);

const carol = await registerVerified('carol');
const raced = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/api/v1/auth/refresh', { body: { refreshToken: carol.refresh } })));
check('5 concurrent refreshes of one token: at most one succeeds', raced.filter((r) => r.status === 200).length <= 1, raced.map((r) => r.status));

const dave = await registerVerified('dave');
await api('POST', '/api/v1/auth/logout', { token: dave.token, body: { refreshToken: dave.refresh } });
check('REVOCATION: the access token is rejected right after logout (on another service)', (await api('GET', '/api/v1/accounts', { token: dave.token })).status === 401);
check('refresh token is dead after logout', (await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: dave.refresh } })).status === 401);

const erin = await registerVerified('erin');
const bad = [];
for (let i = 0; i < 5; i++) {
  // Each attempt claims a different client IP: the gateway must ignore it, so the lockout still applies
  bad.push((await api('POST', '/api/v1/auth/login', { headers: { 'x-forwarded-for': `10.0.${i}.${i}` }, body: { email: erin.email, password: `WrongPass${i}x` } })).status);
}
const locked = await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: PASSWORD } });
check('LOCKOUT: after 5 wrong passwords even the right one is refused (429), spoofed X-Forwarded-For does not help', bad.every((s) => s === 401) && locked.status === 429, { bad, locked: locked.status });
const ghostLock = [];
for (let i = 0; i < 6; i++) ghostLock.push((await api('POST', '/api/v1/auth/login', { body: { email: `ghost.${runId}@e2e.test`, password: `WrongPass${i}x` } })).status);
check('ENUMERATION: unknown emails lock out identically', ghostLock.slice(0, 5).every((s) => s === 401) && ghostLock[5] === 429, ghostLock);

// ---------------------------------------------------------------------------
section('Forgot / reset / change password, customer MFA');
const forgotUnknown = await api('POST', '/api/v1/auth/password/forgot', { body: { email: `nobody.${runId}@e2e.test` } });
const forgotErin = await api('POST', '/api/v1/auth/password/forgot', { body: { email: erin.email } });
check('ENUMERATION: forgot-password answers identically for known and unknown emails', forgotUnknown.status === 202 && forgotErin.status === 202 && forgotUnknown.body.message === forgotErin.body.message);
const resetMail = await waitForEmail(erin.email, /Reset your BankSphere password/);
check('reset email delivered with a #token= link', Boolean(resetMail) && /reset-password#token=/.test(resetMail.text), resetMail?.text);
const resetToken = tokenFrom(resetMail?.text ?? '');
check('reset with a weak password is rejected (400)', (await api('POST', '/api/v1/auth/password/reset', { body: { token: resetToken, newPassword: 'short' } })).status === 400);
const NEW_PASSWORD = 'BrandNewPassw0rd';
check('reset with a valid token succeeds', (await api('POST', '/api/v1/auth/password/reset', { body: { token: resetToken, newPassword: NEW_PASSWORD } })).status === 200);
check('reset token is single-use', (await api('POST', '/api/v1/auth/password/reset', { body: { token: resetToken, newPassword: 'AnotherPassw0rd1' } })).status === 400);
check('REVOCATION: access tokens issued before the reset are rejected', (await api('GET', '/api/v1/auth/me', { token: erin.token })).status === 401);
check('refresh tokens issued before the reset are rejected', (await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: erin.refresh } })).status === 401);
const oldPwLogin = await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: PASSWORD } });
const newPwLogin = await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: NEW_PASSWORD } });
check('old password no longer works; new one does (and the lockout was cleared)', oldPwLogin.status === 401 && newPwLogin.status === 200, [oldPwLogin.status, newPwLogin.body]);
check('"password changed" security notice emailed', Boolean(await waitForEmail(erin.email, /password was changed/)));
const erinToken = newPwLogin.body.data?.tokens?.accessToken;
check('change-password requires the current password', (await api('POST', '/api/v1/auth/password/change', { token: erinToken, body: { currentPassword: 'NotIt12345', newPassword: 'ChangedPassw0rd' } })).status === 401);
const change = await api('POST', '/api/v1/auth/password/change', { token: erinToken, body: { currentPassword: NEW_PASSWORD, newPassword: 'ChangedPassw0rd' } });
check('change-password succeeds and returns fresh tokens', change.status === 200 && change.body.data.tokens.accessToken, change.body);
check('...the previous access token is revoked', (await api('GET', '/api/v1/auth/me', { token: erinToken })).status === 401);

const erinMfa = await enrolMfa(change.body.data?.tokens?.accessToken);
check('customer can opt in to MFA', erinMfa.enableStatus === 200, erinMfa);
const erinPwOnly = await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: 'ChangedPassw0rd' } });
check('customer with MFA: password alone is not enough', erinPwOnly.body?.data?.mfaRequired === true && !erinPwOnly.body.data.tokens, erinPwOnly.body);
check('"two-factor enabled" notice emailed', Boolean(await waitForEmail(erin.email, /Two-factor authentication enabled/)));

// ---------------------------------------------------------------------------
section('Customer profiles & KYC');
check('customer can create own profile', (await api('POST', '/api/v1/customers/me', { token: alice.token, body: { fullName: 'Alice Example', phoneNumber: '+919876543210' } })).status === 201);
const noKycAccount = await api('POST', '/api/v1/accounts', { token: alice.token, body: {} });
check('KYC: account opening is refused until KYC is verified (403 KYC_NOT_VERIFIED)', noKycAccount.status === 403 && noKycAccount.body.error.code === 'KYC_NOT_VERIFIED', noKycAccount.body);
check('customer cannot self-verify KYC (403)', (await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: alice.token, body: { kycStatus: 'VERIFIED' } })).status === 403);
const kycByAdmin = await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: admin.token, body: { kycStatus: 'VERIFIED' } });
check('admin can verify KYC', kycByAdmin.status === 200 && kycByAdmin.body.data.kycStatus === 'VERIFIED', kycByAdmin.body);
check('profile read reflects KYC update (cache invalidated)', (await api('GET', '/api/v1/customers/me', { token: alice.token })).body?.data?.kycStatus === 'VERIFIED');
await kycVerified(bob, admin);
await kycVerified(carol, admin);
const rename = await api('PATCH', '/api/v1/customers/me', { token: carol.token, body: { fullName: 'Someone Else Entirely' } });
check('KYC BYPASS: changing the name after verification sends KYC back to PENDING', rename.status === 200 && rename.body.data.kycStatus === 'PENDING', rename.body);
const kycHistory = await api('GET', `/api/v1/customers/${carol.id}/kyc/history`, { token: admin.token });
check('KYC history records the approval and the identity change', kycHistory.status === 200 && kycHistory.body.data.length >= 2, kycHistory.body?.data);

// ---------------------------------------------------------------------------
section('Accounts & ledger provisioning');
check('customer cannot open an account with an excessive daily limit', (await api('POST', '/api/v1/accounts', { token: alice.token, body: { dailyLimitPaise: '999999999999' } })).status === 403);
const aliceAcc = (await api('POST', '/api/v1/accounts', { token: alice.token, body: { accountType: 'SAVINGS' } })).body.data;
const bobAcc = (await api('POST', '/api/v1/accounts', { token: bob.token, body: {} })).body.data;
check('accounts created with 12-digit numbers', /^\d{12}$/.test(aliceAcc?.accountNumber) && /^\d{12}$/.test(bobAcc?.accountNumber), { aliceAcc, bobAcc });
check('ledger account provisioned and active (balance 0)', (await balance(alice.token, aliceAcc.id)) === '0');
check("IDOR: bob cannot read alice's account (404)", (await api('GET', `/api/v1/accounts/${aliceAcc.id}`, { token: bob.token })).status === 404);
check("IDOR: bob cannot read alice's balance (404)", (await api('GET', `/api/v1/transactions/accounts/${aliceAcc.id}/balance`, { token: bob.token })).status === 404);
const welcome = await waitForEmail(alice.email, /Welcome to BankSphere/);
check('KAFKA: account.created.v1 -> welcome email to the real owner, account number masked', Boolean(welcome) && /X{8}\d{4}/.test(welcome.text) && !welcome.text.includes(aliceAcc.accountNumber), welcome?.text);

// ---------------------------------------------------------------------------
section('Money movement');
check('customer cannot deposit (mint money) (403)', (await api('POST', '/api/v1/transactions/deposit', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { accountId: aliceAcc.id, amountInPaise: '100000000' } })).status === 403);
check('customer cannot use the teller withdrawal (403)', (await api('POST', '/api/v1/transactions/withdraw', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { accountId: aliceAcc.id, amountInPaise: '1' } })).status === 403);
const dep = await api('POST', '/api/v1/transactions/deposit', { token: admin.token, headers: { 'Idempotency-Key': key() }, body: { accountId: aliceAcc.id, amountInPaise: '100000' } });
check('teller deposit within the single-approval limit executes immediately (201)', dep.status === 201 && dep.body.data.status === 'EXECUTED', dep.body);
check('alice balance = 100000', (await balance(alice.token, aliceAcc.id)) === '100000');
check('KAFKA: transaction.completed.v1 -> credit alert email to alice', Boolean(await waitForEmail(alice.email, /credited to your account/)));

check("THEFT: bob cannot transfer out of alice's account", (await api('POST', '/api/v1/transactions/transfer', { token: bob.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100000' } })).status === 404);
check("STAFF THEFT: an administrator cannot transfer out of a customer's account (403)", (await api('POST', '/api/v1/transactions/transfer', { token: admin.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '1' } })).status === 403);
check('transfer without Idempotency-Key is rejected (400)', (await api('POST', '/api/v1/transactions/transfer', { token: alice.token, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' } })).status === 400);
const insufficient = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '999999999' } });
check('insufficient funds returns 422 INSUFFICIENT_FUNDS', insufficient.status === 422 && insufficient.body.error.code === 'INSUFFICIENT_FUNDS', insufficient.body);
const noSuchDest = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: '100100000000', amountInPaise: '100' } });
check('ORACLE: an unknown destination gives the generic 422 INVALID_DESTINATION', noSuchDest.status === 422 && noSuchDest.body.error.code === 'INVALID_DESTINATION', noSuchDest.body);
const emptyProbe = await api('POST', '/api/v1/transactions/transfer', { token: carol.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '1' } });
check('ORACLE: probing with an account you do not own reveals nothing (404)', emptyProbe.status === 404, emptyProbe.body);

const idemKey = key();
const sameKey = await Promise.all(Array.from({ length: 10 }, () =>
  api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': idemKey }, body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '1000' } })
));
const txIds = new Set(sameKey.filter((r) => r.status === 201).map((r) => r.body.data.transactionId));
check('DOUBLE SPEND: 10 concurrent requests with one Idempotency-Key move money once', txIds.size === 1 && (await balance(alice.token, aliceAcc.id)) === '99000', { statuses: sameKey.map((r) => r.status), txIds: [...txIds] });
check('reusing a key with a different payload is rejected (422)', (await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': idemKey }, body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '5000' } })).status === 422);
const bobSameKey = await api('POST', '/api/v1/transactions/transfer', { token: bob.token, headers: { 'Idempotency-Key': idemKey }, body: { sourceAccountId: bobAcc.id, destinationAccountId: aliceAcc.id, amountInPaise: '10' } });
check("keys are per-user: bob's identical key does not replay alice's response", bobSameKey.status === 201 && bobSameKey.body.data.sourceAccountId === bobAcc.id, bobSameKey.body);

const beforeDrain = BigInt(await balance(alice.token, aliceAcc.id));
const drain = await Promise.all(Array.from({ length: 30 }, () =>
  api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '5000' } })
));
const ok = drain.filter((r) => r.status === 201).length;
const expectedOk = Number(beforeDrain / 5000n);
const finalAlice = BigInt(await balance(alice.token, aliceAcc.id));
check('OVERDRAFT RACE: every losing request gets a clean 422 (no 5xx under contention)', [...new Set(drain.map((r) => r.status))].every((s) => s === 201 || s === 422), [...new Set(drain.map((r) => r.status))]);
check(`OVERDRAFT RACE: 30 concurrent transfers -> ${ok} succeeded (expected ${expectedOk}), balance never negative`, ok === expectedOk && finalAlice === beforeDrain - BigInt(ok) * 5000n && finalAlice >= 0n, { ok, finalAlice: finalAlice.toString() });
const finalBob = BigInt(await balance(bob.token, bobAcc.id));
check('money is conserved (alice + bob = total deposited)', finalAlice + finalBob === 100000n, { finalAlice: finalAlice.toString(), finalBob: finalBob.toString() });
const history = await api('GET', `/api/v1/transactions/accounts/${aliceAcc.id}/history?limit=1000&offset=99999999`, { token: alice.token });
check('history pagination is clamped (limit 100, offset capped)', history.status === 200 && history.body.pagination.limit === 100 && history.body.pagination.offset === 10000, history.body?.pagination);

// ---------------------------------------------------------------------------
section('Maker-checker cash operations');
const bigDeposit = await api('POST', '/api/v1/transactions/deposit', { token: admin.token, headers: { 'Idempotency-Key': key() }, body: { accountId: aliceAcc.id, amountInPaise: '60000000' } });
check('MINTING: a deposit above Rs 2 lakh is only recorded as PENDING_APPROVAL (202)', bigDeposit.status === 202 && bigDeposit.body.data.status === 'PENDING_APPROVAL', bigDeposit.body);
check('...and has not moved any money yet', BigInt(await balance(alice.token, aliceAcc.id)) === finalAlice);
const opId = bigDeposit.body.data?.cashOperationId;
const selfApprove = await api('POST', `/api/v1/transactions/cash-operations/${opId}/approve`, { token: admin.token, headers: { 'Idempotency-Key': key() } });
check('MAKER-CHECKER: the requester cannot approve their own request (403)', selfApprove.status === 403, selfApprove.body);
const pendingList = await api('GET', '/api/v1/transactions/cash-operations?status=PENDING_APPROVAL', { token: checker.token });
check('checker sees the pending request', pendingList.status === 200 && pendingList.body.data.some((o) => o.id === opId), pendingList.body?.data?.length);
const approve = await api('POST', `/api/v1/transactions/cash-operations/${opId}/approve`, { token: checker.token, headers: { 'Idempotency-Key': key() } });
check('a different administrator approves -> executed (201)', approve.status === 201 && approve.body.data.status === 'EXECUTED', approve.body);
check('...now the money arrived', BigInt(await balance(alice.token, aliceAcc.id)) === finalAlice + 60000000n);
const approveAgain = await api('POST', `/api/v1/transactions/cash-operations/${opId}/approve`, { token: checker.token, headers: { 'Idempotency-Key': key() } });
check('an executed request cannot be approved twice (409)', approveAgain.status === 409, approveAgain.body);

// ---------------------------------------------------------------------------
section('Daily limit, freeze, fraud');
check('customer can lower their own daily limit', (await api('PATCH', `/api/v1/accounts/${bobAcc.id}/daily-limit`, { token: bob.token, body: { dailyLimitPaise: '50000' } })).status === 200);
const overLimit = await api('POST', '/api/v1/transactions/withdraw', { token: admin.token, headers: { 'Idempotency-Key': key() }, body: { accountId: bobAcc.id, amountInPaise: '50000' } });
check('teller withdrawal over the remaining daily limit is rejected (422 DAILY_LIMIT_EXCEEDED)', overLimit.status === 422 && overLimit.body.error.code === 'DAILY_LIMIT_EXCEEDED', overLimit.body);

const freeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: alice.token, body: { status: 'FROZEN' } });
check('customer can freeze own account', freeze.status === 200 && freeze.body.data.status === 'FROZEN', freeze.body);
const whileFrozen = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' } });
check('frozen account cannot send money (ledger enforced)', whileFrozen.status === 403 && whileFrozen.body.error.code === 'ACCOUNT_INACTIVE', whileFrozen.body);
const toFrozen = await api('POST', '/api/v1/transactions/transfer', { token: bob.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: bobAcc.id, destinationAccountId: aliceAcc.id, amountInPaise: '1' } });
check('a frozen account cannot receive either (generic INVALID_DESTINATION)', toFrozen.status === 422 && toFrozen.body.error.code === 'INVALID_DESTINATION', toFrozen.body);
check('customer cannot unfreeze (403)', (await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: alice.token, body: { status: 'ACTIVE' } })).status === 403);
const adminUnfreeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: admin.token, body: { status: 'ACTIVE' } });
check('admin can unfreeze', adminUnfreeze.status === 200 && adminUnfreeze.body.data.status === 'ACTIVE', adminUnfreeze.body);
check('KAFKA: account.status.changed.v1 -> freeze notice email', Boolean(await waitForEmail(alice.email, /your account is now FROZEN/)));
const closeWithMoney = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: admin.token, body: { status: 'CLOSED' } });
check('account with balance cannot be closed (409, decided by the ledger)', closeWithMoney.status === 409, closeWithMoney.body);

await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/daily-limit`, { token: admin.token, body: { dailyLimitPaise: '100000000' } });
const big = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '25000000' } });
check('high-value transfer (Rs 2.5 lakh) succeeds within the raised limit', big.status === 201, big.body);
const overCustomerCap = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': key() }, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '25000000' } });
check('per-customer daily outflow cap (Rs 5 lakh across accounts) is enforced', overCustomerCap.status === 422 && overCustomerCap.body.error.code === 'DAILY_LIMIT_EXCEEDED', overCustomerCap.body);
const alerts = await waitFor(async () => {
  const res = await api('GET', '/api/v1/fraud/alerts?limit=100', { token: admin.token });
  const mine = res.body?.data?.filter((a) => a.transactionId === big.body?.data?.transactionId) ?? [];
  return mine.length >= 2 ? mine : null;
});
check('KAFKA: fraud-service flagged BOTH sides of the high-value transfer (outbound + inbound mule check)', alerts?.length === 2 && alerts.every((a) => ['HIGH', 'CRITICAL'].includes(a.severity)), alerts);
const alert = alerts?.[0];
const triage = alert && (await api('PATCH', `/api/v1/fraud/alerts/${alert.id}`, { token: checker.token, body: { status: 'UNDER_REVIEW', note: 'calling the customer' } }));
check('analyst triages the alert', triage?.status === 200 && triage.body.data.status === 'UNDER_REVIEW', triage?.body);
const alertHistory = alert && (await api('GET', `/api/v1/fraud/alerts/${alert.id}/history`, { token: admin.token }));
check('alert triage is attributed in the history', alertHistory?.body?.data?.[0]?.actorId === checker.id, alertHistory?.body);
check('KAFKA: the fraud alert reached the security team by email (via outbox)', Boolean(await waitForEmail('security-team@banksphere.local', /SECURITY ALERT/)));

// ---------------------------------------------------------------------------
section('Staff-only data, admin controls & internal API');
check('customer cannot read fraud alerts (403)', (await api('GET', '/api/v1/fraud/alerts', { token: alice.token })).status === 403);
check('customer cannot read notification logs (403)', (await api('GET', '/api/v1/notifications/logs', { token: alice.token })).status === 403);
const logsAsAdmin = await api('GET', `/api/v1/notifications/logs?recipient=${encodeURIComponent(alice.email)}`, { token: admin.token });
check('admin can audit notification logs', logsAsAdmin.status === 200 && logsAsAdmin.body.data.length >= 2, logsAsAdmin.body?.data?.length);
const selfDisable = await api('PATCH', `/api/v1/auth/admin/users/${admin.id}/status`, { token: admin.token, body: { isActive: false } });
check('an administrator cannot disable themselves (403)', selfDisable.status === 403, selfDisable.body);
const disable = await api('PATCH', `/api/v1/auth/admin/users/${bob.id}/status`, { token: admin.token, body: { isActive: false } });
check('admin can disable a user', disable.status === 200 && disable.body.data.isActive === false, disable.body);
check('REVOCATION: a disabled user is locked out immediately', (await api('GET', `/api/v1/accounts/${bobAcc.id}`, { token: bob.token })).status === 401);
check('disabled user cannot log in', (await api('POST', '/api/v1/auth/login', { body: { email: bob.email, password: PASSWORD } })).status === 401);
check('internal API is not reachable through the gateway (404)', (await api('POST', '/internal/v1/ledger-accounts', { body: {} })).status === 404);
const health = await api('GET', '/health');
check('public gateway health does not reveal the internal service map', health.status === 200 && !JSON.stringify(health.body).includes('service-'), health.body);
if (LEDGER_DIRECT !== 'skip') {
  check('internal API rejects calls without the service token (401)', (await api('PATCH', `/internal/v1/ledger-accounts/${aliceAcc.id}`, { base: LEDGER_DIRECT, body: { dailyLimitPaise: '999999999999' } })).status === 401);
}

section('Global');
check('no request in the whole run returned a 5xx', serverErrors.length === 0, serverErrors);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
