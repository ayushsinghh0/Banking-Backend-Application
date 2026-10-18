#!/usr/bin/env node
/**
 * End-to-end functional + security regression suite, run against a live stack through the API gateway.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN2_EMAIL=... ADMIN2_PASSWORD=... node scripts/e2e.mjs
 *
 * Two bootstrap administrators are needed (create-admin twice), because every privileged change is
 * four-eyes: staff are requested by one administrator and approved by the other.
 *
 * Environment:
 *   GATEWAY_URL              default http://localhost:8000
 *   MAILPIT_URL              default http://localhost:8025 (dev SMTP capture; used to read verification/reset emails)
 *   TRANSACTION_SERVICE_URL  default http://localhost:8004 (set to "skip" when services aren't reachable directly)
 *   ADMIN_ENROLMENT_TOKEN    first run only: the ENROLMENT_TOKEN printed by create-admin for ADMIN_EMAIL
 *   ADMIN2_ENROLMENT_TOKEN   first run only: the same for ADMIN2_EMAIL
 *   The administrators' TOTP secrets are remembered in scripts/.e2e-state.json (git-ignored).
 *
 * Requires two BANK_ADMINs created with `npm run create-admin -w @banksphere/auth-service`, Kafka and Mailpit.
 * Staff users get @banksphere.local addresses, so STAFF_EMAIL_DOMAIN must be banksphere.local (or empty).
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
const ADMIN2_EMAIL = process.env.ADMIN2_EMAIL;
const ADMIN2_PASSWORD = process.env.ADMIN2_PASSWORD;
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.e2e-state.json');
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN2_EMAIL || !ADMIN2_PASSWORD) {
  console.error('ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN2_EMAIL and ADMIN2_PASSWORD are required');
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
const idem = () => ({ 'Idempotency-Key': key() });

/** Logs in, completing the MFA step when enrolled. Returns the login response. */
async function login(email, password, totpSecret) {
  const res = await api('POST', '/api/v1/auth/login', { body: { email, password } });
  if (res.status !== 200) return res;
  if (!res.body.data.mfaRequired) return res;
  if (!totpSecret) return res;
  return api('POST', '/api/v1/auth/login/mfa', { body: { challengeToken: res.body.data.challengeToken, code: await freshTotp(totpSecret) } });
}

/** Enrols TOTP for a signed-in user (staff also need their one-time enrolment token); returns { secret, tokens } */
async function enrolMfa(accessToken, password, enrolmentToken) {
  const setup = await api('POST', '/api/v1/auth/mfa/setup', { token: accessToken, body: { password, ...(enrolmentToken ? { enrolmentToken } : {}) } });
  const secret = setup.body?.data?.secret;
  const enable = secret
    ? await api('POST', '/api/v1/auth/mfa/enable', { token: accessToken, body: { code: await freshTotp(secret), ...(enrolmentToken ? { enrolmentToken } : {}) } })
    : { status: 0 };
  return { secret, tokens: enable.body?.data?.tokens, setupStatus: setup.status, setupBody: setup.body, enableStatus: enable.status };
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

/** KYC decision by a KYC officer on the profile version they actually reviewed */
async function decideKyc(officer, userId, kycStatus) {
  const profile = await api('GET', `/api/v1/customers/${userId}`, { token: officer.token });
  return api('PATCH', `/api/v1/customers/${userId}/kyc`, { token: officer.token, body: { kycStatus, expectedVersion: profile.body?.data?.version } });
}

async function kycVerified(user, officer) {
  await api('POST', '/api/v1/customers/me', { token: user.token, body: { fullName: `E2E ${user.email.split('.')[0]}`, phoneNumber: '+919876543210' } });
  const res = await decideKyc(officer, user.id, 'VERIFIED');
  if (res.status !== 200) throw new Error(`kyc ${user.email}: ${JSON.stringify(res.body)}`);
}

async function balance(token, accountId) {
  const res = await api('GET', `/api/v1/transactions/accounts/${accountId}/balance`, { token });
  return res.body?.data?.balanceInPaise;
}

/** Signs a bootstrap administrator in, enrolling MFA with the one-time token from create-admin on first use */
async function bootstrapAdmin(label, email, password, enrolmentToken) {
  let secret = state[email];
  let res = await login(email, password, secret);
  if (res.status === 200 && res.body.data.tokens && !res.body.data.mfaRequired && !secret) {
    const restricted = res.body.data.tokens.accessToken;
    const blocked = await api('GET', '/api/v1/fraud/alerts', { token: restricted });
    check(`${label}: a staff session without MFA cannot use privileged APIs (403 MFA_REQUIRED)`, blocked.status === 403 && blocked.body.error.code === 'MFA_REQUIRED', blocked.body);
    const noToken = await api('POST', '/api/v1/auth/mfa/setup', { token: restricted, body: { password } });
    check(`${label}: staff MFA enrolment needs the one-time enrolment token (stolen password is not enough)`, noToken.status === 403 && noToken.body.error.code === 'ENROLMENT_TOKEN_REQUIRED', noToken.body);
    if (!enrolmentToken) {
      console.error(`\n${label} has no MFA yet: pass the ENROLMENT_TOKEN printed by create-admin.`);
      process.exit(1);
    }
    const enrol = await enrolMfa(restricted, password, enrolmentToken);
    check(`${label}: enrols TOTP with the enrolment token`, enrol.setupStatus === 200 && enrol.enableStatus === 200, enrol);
    secret = enrol.secret;
    saveState({ [email]: secret });
    res = await login(email, password, secret);
  }
  if (res.status !== 200 || !res.body.data?.tokens) {
    console.error(`\nCannot continue without a session for ${label}: ${JSON.stringify(res.body)}`);
    process.exit(1);
  }
  return { token: res.body.data.tokens.accessToken, id: res.body.data.user.id, email, secret };
}

/**
 * Staff onboarding the production way: requested by one administrator, approved by another, activated by
 * the staff member from the email link (choosing their own password), then MFA enrolment.
 */
async function onboardStaff(role, name) {
  const email = `${name}.${runId}@banksphere.local`;
  const request = await api('POST', '/api/v1/auth/admin/users', { token: admin.token, body: { email, role } });
  if (request.status !== 202) throw new Error(`request ${role}: ${JSON.stringify(request.body)}`);
  const approve = await api('POST', `/api/v1/auth/admin/requests/${request.body.data.requestId}/approve`, { token: admin2.token });
  if (approve.status !== 200) throw new Error(`approve ${role}: ${JSON.stringify(approve.body)}`);
  const mail = await waitForEmail(email, /Activate your BankSphere staff account/);
  if (!mail) throw new Error(`no activation email for ${role}`);
  const activate = await api('POST', '/api/v1/auth/staff/activate', { body: { token: tokenFrom(mail.text), password: PASSWORD } });
  if (activate.status !== 200) throw new Error(`activate ${role}: ${JSON.stringify(activate.body)}`);
  const enrol = await enrolMfa(activate.body.data.tokens.accessToken, PASSWORD, activate.body.data.enrolmentToken);
  if (enrol.enableStatus !== 200) throw new Error(`enrol ${role}: ${JSON.stringify(enrol)}`);
  return { email, id: approve.body.data.outcome.userId, token: enrol.tokens.accessToken, secret: enrol.secret, requestId: request.body.data.requestId, activationText: mail.text };
}

console.log(`BankSphere E2E against ${GATEWAY} (run ${runId})`);
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};

// ---------------------------------------------------------------------------
section('Administrators: MFA & four-eyes staff onboarding');
const admin = await bootstrapAdmin('admin', ADMIN_EMAIL, ADMIN_PASSWORD, process.env.ADMIN_ENROLMENT_TOKEN);
const admin2 = await bootstrapAdmin('admin2', ADMIN2_EMAIL, ADMIN2_PASSWORD, process.env.ADMIN2_ENROLMENT_TOKEN);
const pwOnly = await api('POST', '/api/v1/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
check('MFA: with MFA enrolled, the password alone only returns a challenge (no tokens)', pwOnly.status === 200 && pwOnly.body.data.mfaRequired === true && !pwOnly.body.data.tokens, pwOnly.body);
const badCode = await api('POST', '/api/v1/auth/login/mfa', { body: { challengeToken: pwOnly.body.data?.challengeToken, code: '000000' } });
check('MFA: a wrong code is rejected', badCode.status === 401, badCode.body);

const withPassword = await api('POST', '/api/v1/auth/admin/users', { token: admin.token, body: { email: `x.${runId}@banksphere.local`, role: 'TELLER', password: PASSWORD } });
check('staff creation never accepts an administrator-chosen password (400)', withPassword.status === 400, withPassword.body);
const offDomain = await api('POST', '/api/v1/auth/admin/users', { token: admin.token, body: { email: `x.${runId}@gmail.com`, role: 'TELLER' } });
check('staff accounts must use the bank email domain (400 STAFF_EMAIL_DOMAIN)', offDomain.status === 400 && offDomain.body.error.code === 'STAFF_EMAIL_DOMAIN', offDomain.body);
const puppetEmail = `puppet.${runId}@banksphere.local`;
const puppet = await api('POST', '/api/v1/auth/admin/users', { token: admin.token, body: { email: puppetEmail, role: 'BANK_ADMIN' } });
check('creating a staff user only records a PENDING request (202)', puppet.status === 202 && puppet.body.data.status === 'PENDING', puppet.body);
check('...no account exists yet', (await api('POST', '/api/v1/auth/login', { body: { email: puppetEmail, password: PASSWORD } })).status === 401);
const selfApprove = await api('POST', `/api/v1/auth/admin/requests/${puppet.body.data.requestId}/approve`, { token: admin.token });
check('FOUR-EYES: the requesting administrator cannot approve their own request (403)', selfApprove.status === 403, selfApprove.body);
const rejectPuppet = await api('POST', `/api/v1/auth/admin/requests/${puppet.body.data.requestId}/reject`, { token: admin2.token });
check('a second administrator can reject it', rejectPuppet.status === 200, rejectPuppet.body);
const approveRejected = await api('POST', `/api/v1/auth/admin/requests/${puppet.body.data.requestId}/approve`, { token: admin2.token });
check('a rejected request can never be approved (409)', approveRejected.status === 409, approveRejected.body);

const teller = await onboardStaff('TELLER', 'teller');
check('approved by a second admin -> activation email -> staff sets own password -> MFA enrolled', Boolean(teller.token));
check('activation link is single-use', (await api('POST', '/api/v1/auth/staff/activate', { body: { token: tokenFrom(teller.activationText), password: 'AnotherPassw0rd' } })).status === 400);
const kyc = await onboardStaff('KYC_OFFICER', 'kyc');
const analyst = await onboardStaff('FRAUD_ANALYST', 'analyst1');
const analyst2 = await onboardStaff('FRAUD_ANALYST', 'analyst2');
check('KYC officer and two fraud analysts onboarded the same way', Boolean(kyc.token && analyst.token && analyst2.token));
const replayCode = totp(teller.secret, usedSteps.get(teller.secret));
const tellerPw = await api('POST', '/api/v1/auth/login', { body: { email: teller.email, password: PASSWORD } });
const replayAttempt = await api('POST', '/api/v1/auth/login/mfa', { body: { challengeToken: tellerPw.body.data?.challengeToken, code: replayCode } });
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
const twin = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refresh } });
check('a second tab refreshing the just-rotated token gets a retryable 409 (session survives)', twin.status === 409 && twin.body.error.code === 'REFRESH_IN_PROGRESS', twin.body);
await sleep(13_000); // past the 10s rotation grace, with margin for clock adjustments
const replayLater = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refresh } });
check('replaying a rotated refresh token later is token theft (401)', replayLater.status === 401, replayLater.body);
check('reuse detection revoked the whole family', (await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: r1.body.data.refreshToken } })).status === 401);
check('...and every access token of that session stopped working at once', (await api('GET', '/api/v1/accounts', { token: alice.token })).status === 401);
const aliceAgain = await login(alice.email, PASSWORD);
alice.token = aliceAgain.body.data.tokens.accessToken;

const carol = await registerVerified('carol');
const raced = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/api/v1/auth/refresh', { body: { refreshToken: carol.refresh } })));
check('5 concurrent refreshes of one token: exactly one succeeds, the rest get 409', raced.filter((r) => r.status === 200).length === 1 && raced.every((r) => [200, 409].includes(r.status)), raced.map((r) => r.status));

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

const erinWrongPw = await api('POST', '/api/v1/auth/mfa/setup', { token: change.body.data?.tokens?.accessToken, body: { password: 'NotMyPassw0rd' } });
check('MFA setup requires re-entering the password', erinWrongPw.status === 401, erinWrongPw.body);
const erinMfa = await enrolMfa(change.body.data?.tokens?.accessToken, 'ChangedPassw0rd');
check('customer can opt in to MFA (no enrolment token needed for customers)', erinMfa.enableStatus === 200, erinMfa);
const erinPwOnly = await api('POST', '/api/v1/auth/login', { body: { email: erin.email, password: 'ChangedPassw0rd' } });
check('customer with MFA: password alone is not enough', erinPwOnly.body?.data?.mfaRequired === true && !erinPwOnly.body.data.tokens, erinPwOnly.body);
check('"two-factor enabled" notice emailed', Boolean(await waitForEmail(erin.email, /Two-factor authentication enabled/)));

// ---------------------------------------------------------------------------
section('Customer profiles & KYC (KYC officers only)');
check('customer can create own profile', (await api('POST', '/api/v1/customers/me', { token: alice.token, body: { fullName: 'Alice Example', phoneNumber: '+919876543210' } })).status === 201);
const noKycAccount = await api('POST', '/api/v1/accounts', { token: alice.token, body: {} });
check('KYC: account opening is refused until KYC is verified (403 KYC_NOT_VERIFIED)', noKycAccount.status === 403 && noKycAccount.body.error.code === 'KYC_NOT_VERIFIED', noKycAccount.body);
check('customer cannot self-verify KYC (403)', (await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: alice.token, body: { kycStatus: 'VERIFIED', expectedVersion: 1 } })).status === 403);
check('SEPARATION OF DUTIES: an administrator cannot decide KYC (403)', (await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: admin.token, body: { kycStatus: 'VERIFIED', expectedVersion: 1 } })).status === 403);
const reviewed = await api('GET', `/api/v1/customers/${alice.id}`, { token: kyc.token });
await api('PATCH', '/api/v1/customers/me', { token: alice.token, body: { phoneNumber: '+919876500001' } });
const stale = await api('PATCH', `/api/v1/customers/${alice.id}/kyc`, { token: kyc.token, body: { kycStatus: 'VERIFIED', expectedVersion: reviewed.body?.data?.version } });
check('STALE REVIEW: a decision on a profile changed after it was reviewed is refused (409 PROFILE_CHANGED)', stale.status === 409 && stale.body.error.code === 'PROFILE_CHANGED', stale.body);
const kycDecision = await decideKyc(kyc, alice.id, 'VERIFIED');
check('KYC officer verifies KYC on the current version', kycDecision.status === 200 && kycDecision.body.data.kycStatus === 'VERIFIED', kycDecision.body);
check('profile read reflects KYC update (cache invalidated)', (await api('GET', '/api/v1/customers/me', { token: alice.token })).body?.data?.kycStatus === 'VERIFIED');
await kycVerified(bob, kyc);
await kycVerified(carol, kyc);
const rename = await api('PATCH', '/api/v1/customers/me', { token: carol.token, body: { fullName: 'Someone Else Entirely' } });
check('KYC BYPASS: changing the name after verification sends KYC back to PENDING', rename.status === 200 && rename.body.data.kycStatus === 'PENDING', rename.body);
const kycHistory = await api('GET', `/api/v1/customers/${carol.id}/kyc/history`, { token: admin.token });
check('KYC history records the approval and the identity change', kycHistory.status === 200 && kycHistory.body.data.length >= 2, kycHistory.body?.data);

// ---------------------------------------------------------------------------
section('Accounts & ledger provisioning');
check('customer cannot open an account with an excessive daily limit', (await api('POST', '/api/v1/accounts', { token: alice.token, body: { dailyLimitPaise: '999999999999' } })).status === 403);
const aliceAcc = (await api('POST', '/api/v1/accounts', { token: alice.token, body: { accountType: 'SAVINGS' } })).body.data;
const aliceAcc2 = (await api('POST', '/api/v1/accounts', { token: alice.token, body: { accountType: 'CURRENT' } })).body.data;
const bobAcc = (await api('POST', '/api/v1/accounts', { token: bob.token, body: {} })).body.data;
check('accounts created with 12-digit numbers', /^\d{12}$/.test(aliceAcc?.accountNumber) && /^\d{12}$/.test(aliceAcc2?.accountNumber) && /^\d{12}$/.test(bobAcc?.accountNumber), { aliceAcc, bobAcc });
check('ledger account provisioned and active (balance 0)', (await balance(alice.token, aliceAcc.id)) === '0');
check("IDOR: bob cannot read alice's account (404)", (await api('GET', `/api/v1/accounts/${aliceAcc.id}`, { token: bob.token })).status === 404);
check("IDOR: bob cannot read alice's balance (404)", (await api('GET', `/api/v1/transactions/accounts/${aliceAcc.id}/balance`, { token: bob.token })).status === 404);
const welcome = await waitForEmail(alice.email, /Welcome to BankSphere/);
check('KAFKA: account.created.v1 -> welcome email to the real owner, account number masked', Boolean(welcome) && /X{8}\d{4}/.test(welcome.text) && !welcome.text.includes(aliceAcc.accountNumber), welcome?.text);

// ---------------------------------------------------------------------------
section('Teller cash (sessions, drawer, customer withdrawal codes, maker-checker)');
check('customer cannot deposit (mint money) (403)', (await api('POST', '/api/v1/transactions/deposit', { token: alice.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '100000000' } })).status === 403);
check('SEPARATION OF DUTIES: an administrator cannot handle cash (403, tellers only)', (await api('POST', '/api/v1/transactions/deposit', { token: admin.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '100' } })).status === 403);
const noSession = await api('POST', '/api/v1/transactions/deposit', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '100' } });
check('a teller without an open session cannot handle cash (409 NO_TELLER_SESSION)', noSession.status === 409 && noSession.body.error.code === 'NO_TELLER_SESSION', noSession.body);
const OPENING_FLOAT = 5_000_000n;
check('a teller cannot issue their own float (403)', (await api('POST', '/api/v1/transactions/teller/sessions', { token: teller.token, body: { tellerId: teller.id, openingFloatPaise: '1' } })).status === 403);
const issue = await api('POST', '/api/v1/transactions/teller/sessions', { token: admin.token, body: { tellerId: teller.id, openingFloatPaise: OPENING_FLOAT.toString() } });
check('DUAL CONTROL: a supervisor issues the opening float (ISSUED, nothing booked yet)', issue.status === 201 && issue.body.data.status === 'ISSUED', issue.body);
check('...no cash can be handled before the teller accepts it (409)', (await api('POST', '/api/v1/transactions/deposit', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '100' } })).status === 409);
const miscount = await api('POST', '/api/v1/transactions/teller/sessions/accept', { token: teller.token, body: { countedFloatPaise: (OPENING_FLOAT - 1n).toString() } });
check('...the teller must count exactly the issued float (409 FLOAT_MISMATCH)', miscount.status === 409 && miscount.body.error.code === 'FLOAT_MISMATCH', miscount.body);
const open = await api('POST', '/api/v1/transactions/teller/sessions/accept', { token: teller.token, body: { countedFloatPaise: OPENING_FLOAT.toString() } });
check('the teller counts and accepts the float: booked vault -> drawer, session OPEN', open.status === 200 && open.body.data.status === 'OPEN', open.body);
check('only one session per teller per day (409)', (await api('POST', '/api/v1/transactions/teller/sessions', { token: admin2.token, body: { tellerId: teller.id, openingFloatPaise: '0' } })).status === 409);
const dep = await api('POST', '/api/v1/transactions/deposit', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '100000' } });
check('teller deposit within the single-approval limit executes immediately (201)', dep.status === 201 && dep.body.data.status === 'EXECUTED', dep.body);
check('alice balance = 100000', (await balance(alice.token, aliceAcc.id)) === '100000');
check('KAFKA: transaction.completed.v1 -> credit alert email to alice', Boolean(await waitForEmail(alice.email, /credited to your account/)));

check('customer cannot use the teller withdrawal (403)', (await api('POST', '/api/v1/transactions/withdraw', { token: alice.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '1', authorizationCode: '12345678' } })).status === 403);
const noCode = await api('POST', '/api/v1/transactions/withdraw', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '20000' } });
check('a teller withdrawal without the customer code is rejected (400)', noCode.status === 400, noCode.body);
const guessed = await api('POST', '/api/v1/transactions/withdraw', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '20000', authorizationCode: '12345678' } });
check('a guessed code is rejected (403 WITHDRAWAL_NOT_AUTHORISED)', guessed.status === 403 && guessed.body.error.code === 'WITHDRAWAL_NOT_AUTHORISED', guessed.body);
const notOwner = await api('POST', '/api/v1/transactions/withdrawal-codes', { token: bob.token, body: { accountId: aliceAcc.id, amountInPaise: '20000' } });
check("only the account owner can authorise a withdrawal (bob on alice's account: 404)", notOwner.status === 404, notOwner.body);
const code = await api('POST', '/api/v1/transactions/withdrawal-codes', { token: alice.token, body: { accountId: aliceAcc.id, amountInPaise: '20000' } });
check('customer generates a one-time 8-digit withdrawal code for an exact amount', code.status === 201 && /^\d{8}$/.test(code.body.data.authorizationCode), code.body);
check('...and is told by email that a cash withdrawal code was created', Boolean(await waitForEmail(alice.email, /cash withdrawal code was created/)));
const bigCode = await api('POST', '/api/v1/transactions/withdrawal-codes', { token: bob.token, body: { accountId: bobAcc.id, amountInPaise: '3000000' } });
check('a large withdrawal code needs a recent TOTP check (403 STEP_UP_REQUIRED)', bigCode.status === 403 && bigCode.body.error.code === 'STEP_UP_REQUIRED', bigCode.body);
const wrongAmount = await api('POST', '/api/v1/transactions/withdraw', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '25000', authorizationCode: code.body.data.authorizationCode } });
check('the code is bound to the amount (403 for a different amount)', wrongAmount.status === 403, wrongAmount.body);
const withdraw = await api('POST', '/api/v1/transactions/withdraw', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '20000', authorizationCode: code.body.data.authorizationCode } });
check('teller withdrawal with the customer code executes (201)', withdraw.status === 201 && withdraw.body.data.status === 'EXECUTED', withdraw.body);
const reused = await api('POST', '/api/v1/transactions/withdraw', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '20000', authorizationCode: code.body.data.authorizationCode } });
check('the withdrawal code is single-use (403)', reused.status === 403, reused.body);
check('alice balance = 80000', (await balance(alice.token, aliceAcc.id)) === '80000');

const bigDeposit = await api('POST', '/api/v1/transactions/deposit', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '60000000' } });
check('MINTING: a deposit above Rs 2 lakh is only recorded as PENDING_APPROVAL (202)', bigDeposit.status === 202 && bigDeposit.body.data.status === 'PENDING_APPROVAL', bigDeposit.body);
check('...and has not moved any money yet', (await balance(alice.token, aliceAcc.id)) === '80000');
const opId = bigDeposit.body.data?.cashOperationId;
const tellerApprove = await api('POST', `/api/v1/transactions/cash-operations/${opId}/approve`, { token: teller.token, headers: idem() });
check('MAKER-CHECKER: the teller cannot approve (403)', tellerApprove.status === 403, tellerApprove.body);
const pendingList = await api('GET', '/api/v1/transactions/cash-operations?status=PENDING_APPROVAL', { token: admin.token });
check('supervisor sees the pending request', pendingList.status === 200 && pendingList.body.data.some((o) => o.id === opId), pendingList.body?.data?.length);
const closeBlocked = await api('POST', '/api/v1/transactions/teller/sessions/close', { token: teller.token, body: { countedCashPaise: '0' } });
check('a session with unresolved approvals cannot be closed (409)', closeBlocked.status === 409, closeBlocked.body);
const approve = await api('POST', `/api/v1/transactions/cash-operations/${opId}/approve`, { token: admin.token, headers: idem() });
check('a supervisor approves -> executed against the teller drawer (201)', approve.status === 201 && approve.body.data.status === 'EXECUTED', approve.body);
check('...now the money arrived', (await balance(alice.token, aliceAcc.id)) === '60080000');
const approveAgain = await api('POST', `/api/v1/transactions/cash-operations/${opId}/approve`, { token: admin2.token, headers: idem() });
check('an executed request cannot be approved twice (409)', approveAgain.status === 409, approveAgain.body);

// ---------------------------------------------------------------------------
section('Transfers: beneficiaries, step-up, races');
const ALICE_START = 60_080_000n;
check("THEFT: bob cannot transfer out of alice's account", (await api('POST', '/api/v1/transactions/transfer', { token: bob.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100000' } })).status === 404);
check("STAFF THEFT: an administrator cannot transfer out of a customer's account (403)", (await api('POST', '/api/v1/transactions/transfer', { token: admin.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '1' } })).status === 403);
check('transfer without Idempotency-Key is rejected (400)', (await api('POST', '/api/v1/transactions/transfer', { token: alice.token, body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' } })).status === 400);
const insufficient = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: aliceAcc2.id, destinationAccountId: bobAcc.id, amountInPaise: '1000' } });
check("insufficient funds is checked first, before anything about the payee (422 INSUFFICIENT_FUNDS)", insufficient.status === 422 && insufficient.body.error.code === 'INSUFFICIENT_FUNDS', insufficient.body);
const noSuchDest = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: '100100000000', amountInPaise: '100' } });
check('ENUMERATION: an unregistered destination gets BENEFICIARY_REQUIRED whether or not it exists', noSuchDest.status === 422 && noSuchDest.body.error.code === 'BENEFICIARY_REQUIRED', noSuchDest.body);
const emptyProbe = await api('POST', '/api/v1/transactions/transfer', { token: carol.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '1' } });
check('ORACLE: probing with an account you do not own reveals nothing (404)', emptyProbe.status === 404, emptyProbe.body);
const noBeneficiary = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '1000' } });
check('PAYEE CONTROL: money can only go to a registered beneficiary (422 BENEFICIARY_REQUIRED)', noBeneficiary.status === 422 && noBeneficiary.body.error.code === 'BENEFICIARY_REQUIRED', noBeneficiary.body);
const ownMove = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountId: aliceAcc2.id, amountInPaise: '1000' } });
check("...but moving money between the customer's own accounts needs no beneficiary", ownMove.status === 201, ownMove.body);

// Server timestamps only (the client clock may differ from the server's)
function serverDelayMinutes(b) {
  return (new Date(b.activatesAt).getTime() - new Date(b.createdAt).getTime()) / 60_000;
}
// Bob adds alice without MFA: cooling-off period
const bobAddsAlice = await api('POST', '/api/v1/transactions/beneficiaries', { token: bob.token, body: { accountNumber: aliceAcc.accountNumber, nickname: 'Alice' } });
check('a beneficiary added without MFA only activates after a cooling-off period', bobAddsAlice.status === 201 && serverDelayMinutes(bobAddsAlice.body.data) >= 59, bobAddsAlice.body);
// Alice enrols MFA, then adds bob: active immediately
const aliceMfa = await enrolMfa(alice.token, PASSWORD);
check('alice enrols MFA', aliceMfa.enableStatus === 200, aliceMfa);
alice.token = aliceMfa.tokens.accessToken;
const aliceAddsBob = await api('POST', '/api/v1/transactions/beneficiaries', { token: alice.token, body: { accountNumber: bobAcc.accountNumber, nickname: 'Bob' } });
check('...a beneficiary added from an MFA session is active immediately', aliceAddsBob.status === 201 && serverDelayMinutes(aliceAddsBob.body.data) < 1, aliceAddsBob.body);

const idemKey = key();
const sameKey = await Promise.all(Array.from({ length: 10 }, () =>
  api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': idemKey }, body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '1000' } })
));
const txIds = new Set(sameKey.filter((r) => r.status === 201).map((r) => r.body.data.transactionId));
check('DOUBLE SPEND: 10 concurrent requests with one Idempotency-Key move money once', txIds.size === 1 && BigInt(await balance(alice.token, aliceAcc.id)) === ALICE_START - 2000n, { statuses: sameKey.map((r) => r.status), txIds: [...txIds] });
check('reusing a key with a different payload is rejected (422)', (await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: { 'Idempotency-Key': idemKey }, body: { sourceAccountId: aliceAcc.id, destinationAccountNumber: bobAcc.accountNumber, amountInPaise: '5000' } })).status === 422);
const bobSameKey = await api('POST', '/api/v1/transactions/transfer', { token: bob.token, headers: { 'Idempotency-Key': idemKey }, body: { sourceAccountId: bobAcc.id, destinationAccountId: aliceAcc.id, amountInPaise: '10' } });
check("keys are per-user: bob's identical key is evaluated on its own (alice is still cooling off: 422)", bobSameKey.status === 422 && bobSameKey.body.error.code === 'BENEFICIARY_COOLING_OFF', bobSameKey.body);
const bobStepUp = await api('POST', '/api/v1/transactions/transfer', { token: bob.token, headers: idem(), body: { sourceAccountId: bobAcc.id, destinationAccountId: aliceAcc.id, amountInPaise: '10000000' } });
check('STEP-UP: a transfer of Rs 1 lakh or more needs an MFA session (403 STEP_UP_REQUIRED)', bobStepUp.status === 403 && bobStepUp.body.error.code === 'STEP_UP_REQUIRED', bobStepUp.body);
const newPayeeCap = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '5000000' } });
check('NEW PAYEE CAP: at most Rs 50,000 to a new beneficiary in its first 24h (422)', newPayeeCap.status === 422 && newPayeeCap.body.error.code === 'NEW_BENEFICIARY_LIMIT', newPayeeCap.body);

// Overdraft race on an account holding exactly 100000
const raceAcc = aliceAcc2;
const beforeDrain = BigInt(await balance(alice.token, raceAcc.id));
const drain = await Promise.all(Array.from({ length: 30 }, () =>
  api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: raceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' } })
));
const ok = drain.filter((r) => r.status === 201).length;
const expectedOk = Math.min(30, Number(beforeDrain / 100n));
const finalRace = BigInt(await balance(alice.token, raceAcc.id));
check('OVERDRAFT RACE: every losing request gets a clean 422 (no 5xx under contention)', [...new Set(drain.map((r) => r.status))].every((s) => s === 201 || s === 422), [...new Set(drain.map((r) => r.status))]);
check(`OVERDRAFT RACE: 30 concurrent transfers -> ${ok} succeeded (expected ${expectedOk}), balance never negative`, ok === expectedOk && finalRace === beforeDrain - BigInt(ok) * 100n && finalRace >= 0n, { ok, finalRace: finalRace.toString() });
const total = BigInt(await balance(alice.token, aliceAcc.id)) + finalRace + BigInt(await balance(bob.token, bobAcc.id));
check('money is conserved (alice + bob = deposits - withdrawals)', total === 100000n - 20000n + 60000000n, { total: total.toString() });
const history = await api('GET', `/api/v1/transactions/accounts/${aliceAcc.id}/history?limit=1000&offset=99999999`, { token: alice.token });
check('history pagination is clamped (limit 100, offset capped)', history.status === 200 && history.body.pagination.limit === 100 && history.body.pagination.offset === 10000, history.body?.pagination);

// ---------------------------------------------------------------------------
section('Daily limit, freeze, fraud (four-eyes triage)');
check('customer can lower their own daily limit', (await api('PATCH', `/api/v1/accounts/${bobAcc.id}/daily-limit`, { token: bob.token, body: { dailyLimitPaise: '1500' } })).status === 200);
// bob holds 2000: a 1501 withdrawal is affordable but over his new daily limit
const bobCode = await api('POST', '/api/v1/transactions/withdrawal-codes', { token: bob.token, body: { accountId: bobAcc.id, amountInPaise: '1501' } });
const overLimit = await api('POST', '/api/v1/transactions/withdraw', { token: teller.token, headers: idem(), body: { accountId: bobAcc.id, amountInPaise: '1501', authorizationCode: bobCode.body?.data?.authorizationCode } });
check('teller withdrawal over the daily limit is rejected (422 DAILY_LIMIT_EXCEEDED)', overLimit.status === 422 && overLimit.body.error.code === 'DAILY_LIMIT_EXCEEDED', overLimit.body);

const freeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: alice.token, body: { status: 'FROZEN' } });
check('customer can freeze own account', freeze.status === 200 && freeze.body.data.status === 'FROZEN', freeze.body);
const whileFrozen = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountId: bobAcc.id, amountInPaise: '100' } });
check('frozen account cannot send money (ledger enforced)', whileFrozen.status === 403 && whileFrozen.body.error.code === 'ACCOUNT_INACTIVE', whileFrozen.body);
const toFrozen = await api('POST', '/api/v1/transactions/transfer', { token: bob.token, headers: idem(), body: { sourceAccountId: bobAcc.id, destinationAccountId: aliceAcc.id, amountInPaise: '1' } });
check('a frozen account cannot receive either (generic INVALID_DESTINATION)', toFrozen.status === 422 && toFrozen.body.error.code === 'INVALID_DESTINATION', toFrozen.body);
check('customer cannot unfreeze (403)', (await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: alice.token, body: { status: 'ACTIVE' } })).status === 403);
const adminUnfreeze = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: admin.token, body: { status: 'ACTIVE' } });
check('admin can unfreeze', adminUnfreeze.status === 200 && adminUnfreeze.body.data.status === 'ACTIVE', adminUnfreeze.body);
check('KAFKA: account.status.changed.v1 -> freeze notice email', Boolean(await waitForEmail(alice.email, /your account is now FROZEN/)));
const closeWithMoney = await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/status`, { token: admin.token, body: { status: 'CLOSED' } });
check('account with balance cannot be closed (409, decided by the ledger)', closeWithMoney.status === 409, closeWithMoney.body);

await api('PATCH', `/api/v1/accounts/${aliceAcc.id}/daily-limit`, { token: admin.token, body: { dailyLimitPaise: '100000000' } });
// Alice's TOTP check was minutes ago: a large transfer needs a fresh one (step-up)
const badStepUp = await api('POST', '/api/v1/auth/mfa/step-up', { token: alice.token, body: { code: '000000' } });
check('STEP-UP: a wrong code is refused (400)', badStepUp.status === 400 && badStepUp.body.error.code === 'INVALID_MFA_CODE', badStepUp.body);
const stepUp = await api('POST', '/api/v1/auth/mfa/step-up', { token: alice.token, body: { code: await freshTotp(aliceMfa.secret) } });
check('STEP-UP: re-verifying TOTP returns a short-lived step-up token for the same session', stepUp.status === 200 && Boolean(stepUp.body.data.accessToken), stepUp.body);
alice.token = stepUp.body.data?.accessToken ?? alice.token;
const big = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountId: aliceAcc2.id, amountInPaise: '25000000' } });
check('high-value transfer (Rs 2.5 lakh, fresh step-up) succeeds within the raised limit', big.status === 201, big.body);
const overCustomerCap = await api('POST', '/api/v1/transactions/transfer', { token: alice.token, headers: idem(), body: { sourceAccountId: aliceAcc.id, destinationAccountId: aliceAcc2.id, amountInPaise: '25000000' } });
check('per-customer daily outflow cap (Rs 5 lakh across accounts) is enforced', overCustomerCap.status === 422 && overCustomerCap.body.error.code === 'DAILY_LIMIT_EXCEEDED', overCustomerCap.body);
const alerts = await waitFor(async () => {
  const res = await api('GET', '/api/v1/fraud/alerts?limit=100', { token: analyst.token });
  const mine = res.body?.data?.filter((a) => a.transactionId === big.body?.data?.transactionId) ?? [];
  return mine.length >= 2 ? mine : null;
});
check('KAFKA: fraud-service flagged BOTH sides of the high-value transfer (outbound + inbound)', alerts?.length === 2 && alerts.every((a) => ['HIGH', 'CRITICAL'].includes(a.severity)), alerts);
const alert = alerts?.[0];
check('a teller cannot read fraud alerts (403)', (await api('GET', '/api/v1/fraud/alerts', { token: teller.token })).status === 403);
const propose = alert && (await api('PATCH', `/api/v1/fraud/alerts/${alert.id}`, { token: analyst.token, body: { status: 'DISMISSED', note: 'customer confirmed' } }));
check('FOUR-EYES: one analyst can only PROPOSE closing a HIGH alert', propose?.status === 200 && propose.body.data.pendingSecondApproval === true && propose.body.data.status === 'UNDER_REVIEW', propose?.body);
const selfConfirm = alert && (await api('PATCH', `/api/v1/fraud/alerts/${alert.id}`, { token: analyst.token, body: { status: 'DISMISSED' } }));
check('...the same analyst cannot confirm their own proposal (409)', selfConfirm?.status === 409, selfConfirm?.body);
const confirm = alert && (await api('PATCH', `/api/v1/fraud/alerts/${alert.id}`, { token: analyst2.token, body: { status: 'DISMISSED', note: 'agreed' } }));
check('...a second analyst confirms and the alert is closed', confirm?.status === 200 && confirm.body.data.status === 'DISMISSED', confirm?.body);
const alertHistory = alert && (await api('GET', `/api/v1/fraud/alerts/${alert.id}/history`, { token: admin.token }));
check('alert triage is attributed to both analysts in the history', alertHistory?.body?.data?.some((e) => e.actorId === analyst.id) && alertHistory.body.data.some((e) => e.actorId === analyst2.id), alertHistory?.body);
check('KAFKA: the fraud alert reached the security team by email (via outbox)', Boolean(await waitForEmail('security-team@banksphere.local', /SECURITY ALERT/)));

// ---------------------------------------------------------------------------
section('Teller close-out & supervisor sign-off');
const cashMoved = 100000n - 20000n + 60000000n; // deposits in, withdrawals out of this drawer
const counted = OPENING_FLOAT + cashMoved - 500n; // the drawer is Rs 5 short
const close = await api('POST', '/api/v1/transactions/teller/sessions/close', { token: teller.token, body: { countedCashPaise: counted.toString() } });
check('BLIND COUNT: the teller closes without ever seeing the expected figure', close.status === 200 && close.body.data.status === 'CLOSED' && !('expectedClosing' in close.body.data) && !('discrepancy' in close.body.data), close.body);
check('a closed session handles no more cash (409)', (await api('POST', '/api/v1/transactions/deposit', { token: teller.token, headers: idem(), body: { accountId: aliceAcc.id, amountInPaise: '100' } })).status === 409);
check('the teller cannot sign off their own session (403)', (await api('POST', `/api/v1/transactions/teller/sessions/${open.body.data.id}/sign-off`, { token: teller.token, body: { countedCashPaise: counted.toString() } })).status === 403);
const recount = await api('POST', `/api/v1/transactions/teller/sessions/${open.body.data.id}/sign-off`, { token: admin.token, body: { countedCashPaise: (counted + 1000n).toString() } });
check("BLIND COUNT: the supervisor's own count must match the teller's (409 COUNT_MISMATCH)", recount.status === 409 && recount.body.error.code === 'COUNT_MISMATCH', recount.body);
const signOff = await api('POST', `/api/v1/transactions/teller/sessions/${open.body.data.id}/sign-off`, { token: admin.token, body: { countedCashPaise: counted.toString() } });
check('sign-off returns the cash to the vault and posts the Rs 5 shortage to suspense (RECONCILED)', signOff.status === 200 && signOff.body.data.status === 'RECONCILED' && signOff.body.data.expectedClosing === (OPENING_FLOAT + cashMoved).toString() && signOff.body.data.discrepancy === '-500', signOff.body);
check('the drawer is back to zero: a new float can be issued tomorrow', (await api('GET', '/api/v1/transactions/teller/sessions?status=RECONCILED', { token: admin.token })).body?.data?.some((x) => x.id === open.body.data.id));

// ---------------------------------------------------------------------------
section('Staff-only data, admin controls & internal API');
check('customer cannot read fraud alerts (403)', (await api('GET', '/api/v1/fraud/alerts', { token: alice.token })).status === 403);
check('customer cannot read notification logs (403)', (await api('GET', '/api/v1/notifications/logs', { token: alice.token })).status === 403);
const logsAsAdmin = await api('GET', `/api/v1/notifications/logs?recipient=${encodeURIComponent(alice.email)}`, { token: admin.token });
check('admin can audit notification logs', logsAsAdmin.status === 200 && logsAsAdmin.body.data.length >= 2, logsAsAdmin.body?.data?.length);
const selfDisable = await api('PATCH', `/api/v1/auth/admin/users/${admin.id}/status`, { token: admin.token, body: { isActive: false } });
check('an administrator cannot disable themselves (403)', selfDisable.status === 403, selfDisable.body);
const fraudFreeze = await api('PATCH', `/api/v1/accounts/${bobAcc.id}/status`, { token: admin.token, body: { status: 'FROZEN' } });
check('admin freezes a suspicious account', fraudFreeze.status === 200, fraudFreeze.body);
const selfUnfreeze = await api('PATCH', `/api/v1/accounts/${bobAcc.id}/status`, { token: admin.token, body: { status: 'ACTIVE' } });
check('DUAL CONTROL: the admin who froze it cannot unfreeze it (403)', selfUnfreeze.status === 403, selfUnfreeze.body);
check('...a different admin can', (await api('PATCH', `/api/v1/accounts/${bobAcc.id}/status`, { token: admin2.token, body: { status: 'ACTIVE' } })).status === 200);
const mfaReset = await api('POST', `/api/v1/auth/admin/users/${erin.id}/mfa/reset`, { token: admin.token });
check("removing a customer's MFA is only a four-eyes request (202)", mfaReset.status === 202 && mfaReset.body.data.status === 'PENDING', mfaReset.body);
const disable = await api('PATCH', `/api/v1/auth/admin/users/${bob.id}/status`, { token: admin.token, body: { isActive: false } });
check('admin can suspend a customer directly', disable.status === 200 && disable.body.data.isActive === false, disable.body);
check('REVOCATION: a disabled user is locked out immediately', (await api('GET', `/api/v1/accounts/${bobAcc.id}`, { token: bob.token })).status === 401);
check('disabled user cannot log in', (await api('POST', '/api/v1/auth/login', { body: { email: bob.email, password: PASSWORD } })).status === 401);
check('DUAL CONTROL: the admin who disabled a customer cannot re-enable them (403)', (await api('PATCH', `/api/v1/auth/admin/users/${bob.id}/status`, { token: admin.token, body: { isActive: true } })).status === 403);
check('...a different admin can', (await api('PATCH', `/api/v1/auth/admin/users/${bob.id}/status`, { token: admin2.token, body: { isActive: true } })).status === 200);
const disableTeller = await api('PATCH', `/api/v1/auth/admin/users/${teller.id}/status`, { token: admin.token, body: { isActive: false } });
check('disabling a STAFF account only creates a four-eyes request (202)', disableTeller.status === 202 && disableTeller.body.data.status === 'PENDING', disableTeller.body);
check('...the teller still works until it is approved', (await api('GET', '/api/v1/auth/me', { token: teller.token })).status === 200);
const approveDisable = await api('POST', `/api/v1/auth/admin/requests/${disableTeller.body.data?.requestId}/approve`, { token: admin2.token });
check('...a second administrator approves', approveDisable.status === 200, approveDisable.body);
check('REVOCATION: the disabled teller is locked out immediately', (await api('GET', '/api/v1/auth/me', { token: teller.token })).status === 401);
check('internal API is not reachable through the gateway (404)', (await api('POST', '/internal/v1/ledger-accounts', { body: {} })).status === 404);
const health = await api('GET', '/health');
check('public gateway health does not reveal the internal service map', health.status === 200 && !JSON.stringify(health.body).includes('service-'), health.body);
check('gateway liveness endpoint', (await api('GET', '/health/live')).status === 200);
if (LEDGER_DIRECT !== 'skip') {
  check('internal API rejects calls without the service token (401)', (await api('PATCH', `/internal/v1/ledger-accounts/${aliceAcc.id}`, { base: LEDGER_DIRECT, body: { dailyLimitPaise: '999999999999', version: 999 } })).status === 401);
}

section('Global');
check('no request in the whole run returned a 5xx', serverErrors.length === 0, serverErrors);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
