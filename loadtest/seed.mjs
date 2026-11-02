#!/usr/bin/env node
/**
 * Seeds verified, funded customers for the k6 load tests (loadtest/k6). Everything goes through the public API
 * the way customers and staff really use it, so every control in the stack still applies: no database writes,
 * no internal endpoints, no relaxed rules.
 *
 *   node loadtest/seed.mjs --users 50 --admin-state frontend/e2e/.state/state.json
 *   SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... SEED_ADMIN_TOTP_SECRET=... \
 *   SEED_ADMIN2_EMAIL=... SEED_ADMIN2_PASSWORD=... SEED_ADMIN2_TOTP_SECRET=... node loadtest/seed.mjs --users 50
 *
 * Per customer (lt.<prefix>.<i>@loadtest.test, i = 1..N): register -> verify from the Mailpit email -> sign in ->
 * profile -> KYC VERIFIED by a KYC officer -> SAVINGS and CURRENT accounts -> a teller cash deposit that brings
 * SAVINGS + CURRENT up to the target balance.
 *
 * Staff are onboarded the production way (four-eyes: one administrator requests, the other approves; the staff
 * member activates from the email and enrols an authenticator). The KYC officer is reused across runs. A teller
 * handles at most TELLER_DAILY_LIMIT_PAISE of cash and one session per (IST) business day, so the seed opens a
 * session per teller, onboards another teller when the day's limit would be exceeded, and always closes the
 * drawer with the exact cash count and an administrator's sign-off, leaving the books reconciled.
 *
 * Idempotent: re-running reuses existing customers (topping up only what is missing), creates the rest, and
 * recovers customers left registered-but-unverified and a teller session left open by an interrupted run.
 * New customers are registered rather than probed with a sign-in, so seeding never looks like credential
 * stuffing (failed sign-ins across many accounts get the source address banned at the edge).
 *
 * Writes (git-ignored, mode 0600):
 *   loadtest/.data/users.json       [{ email, password, userId, accounts: [{ id, accountNumber, accountType }] }]
 *   loadtest/.data/seed-state.json  staff this script created (with their TOTP secrets) and used TOTP time steps
 *
 * Options (flag or environment variable):
 *   --users N           SEED_USERS              customers to ensure (default 20)
 *   --prefix P          SEED_PREFIX             email prefix, so several pools can coexist (default "u")
 *   --balance-paise B   SEED_BALANCE_PAISE      target SAVINGS + CURRENT balance per customer (default 1000000 = Rs 10,000)
 *   --concurrency C     SEED_CONCURRENCY        customers prepared in parallel (default 4)
 *   --admin-state FILE  SEED_ADMIN_STATE        both administrators from a journey state file
 *                       ({ admins: [{ email, password }], secrets: { <email>: <TOTP secret> } }), otherwise
 *                       SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_TOTP_SECRET and the same for SEED_ADMIN2_*
 *   BASE_URL (default http://localhost:8080), MAILPIT_URL (default http://localhost:8025), SEED_PASSWORD,
 *   SEED_STAFF_DOMAIN (default banksphere.local, must match STAFF_EMAIL_DOMAIN), TELLER_DAILY_LIMIT_PAISE
 *   (default 100000000), CASH_SINGLE_APPROVAL_LIMIT_PAISE (default 20000000), SEED_DATA_DIR (default loadtest/.data),
 *   SEED_ALLOW_REMOTE=true to seed a non-local test environment (never production).
 *
 * Development and test stacks only: it reads emails from Mailpit. Passwords, TOTP secrets and tokens are never logged.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let flags;
try {
  ({ values: flags } = parseArgs({
    options: {
      users: { type: 'string' },
      prefix: { type: 'string' },
      'balance-paise': { type: 'string' },
      concurrency: { type: 'string' },
      'admin-state': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  }));
} catch (err) {
  usage(err.message);
}
if (flags.help) usage();

function usage(problem) {
  if (problem) {
    console.error(`${problem}\nRun with --help for the options.`);
    process.exit(2);
  }
  const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
  console.log(header.replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

function intOption(label, raw, fallback, min, max) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) usage(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}

function paiseOption(label, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d{0,17}$/.test(String(raw))) usage(`${label} must be a positive whole number of paise`);
  return BigInt(raw);
}

const CONFIG = {
  baseUrl: (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  mailpit: (process.env.MAILPIT_URL || 'http://localhost:8025').replace(/\/+$/, ''),
  users: intOption('--users', flags.users ?? process.env.SEED_USERS, 20, 1, 100_000),
  prefix: flags.prefix ?? process.env.SEED_PREFIX ?? 'u',
  balance: paiseOption('--balance-paise', flags['balance-paise'] ?? process.env.SEED_BALANCE_PAISE, 1_000_000n),
  concurrency: intOption('--concurrency', flags.concurrency ?? process.env.SEED_CONCURRENCY, 4, 1, 32),
  password: process.env.SEED_PASSWORD || 'LoadTest-Passw0rd-2026',
  staffDomain: process.env.SEED_STAFF_DOMAIN || 'banksphere.local',
  tellerDailyLimit: paiseOption('TELLER_DAILY_LIMIT_PAISE', process.env.TELLER_DAILY_LIMIT_PAISE, 100_000_000n),
  singleApprovalLimit: paiseOption('CASH_SINGLE_APPROVAL_LIMIT_PAISE', process.env.CASH_SINGLE_APPROVAL_LIMIT_PAISE, 20_000_000n),
  dataDir: path.resolve(process.env.SEED_DATA_DIR || path.join(HERE, '.data')),
};
if (!/^[a-z0-9]{1,16}$/.test(CONFIG.prefix)) usage('--prefix must be 1-16 lower-case letters or digits');
// Same rules as auth-service (passwordSchema): a weak SEED_PASSWORD would fail every registration
if (CONFIG.password.length < 10 || !/[A-Z]/.test(CONFIG.password) || !/[a-z]/.test(CONFIG.password) || !/\d/.test(CONFIG.password)) {
  usage('SEED_PASSWORD must be at least 10 characters with upper-case, lower-case and a digit');
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'web', 'host.docker.internal']);
const baseHost = new URL(CONFIG.baseUrl).hostname;
if (!LOCAL_HOSTS.has(baseHost) && !baseHost.endsWith('.localhost') && !baseHost.endsWith('.test') && process.env.SEED_ALLOW_REMOTE !== 'true') {
  usage(`BASE_URL host ${baseHost} is not local; set SEED_ALLOW_REMOTE=true only for a disposable test environment`);
}

const USERS_FILE = path.join(CONFIG.dataDir, 'users.json');
const STATE_FILE = path.join(CONFIG.dataDir, 'seed-state.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ------------------------------------------------------------------------------------------------------------
// Local files (0600: they hold test passwords and staff authenticator secrets)

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
}

function writeJsonPrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic: an interrupted run never leaves a half-written file
}

const state = { kycOfficer: null, tellers: [], openSession: null, usedSteps: {}, ...readJson(STATE_FILE, {}) };
const saveState = () => writeJsonPrivate(STATE_FILE, state);
const previousUsers = new Map(readJson(USERS_FILE, []).map((u) => [u.email, u]));

// ------------------------------------------------------------------------------------------------------------
// HTTP

class ApiError extends Error {
  constructor(what, res) {
    const code = res.body?.error?.code;
    super(`${what}: HTTP ${res.status}${code ? ` ${code}` : ''}${res.body?.error?.message ? ` (${res.body.error.message})` : ''}`);
    this.status = res.status;
    this.code = code;
  }
}

/**
 * JSON API call through the public entry point. 429s are waited out (Retry-After, at most a minute); network
 * errors and 5xx are retried only when repeating the request is safe (GET, an Idempotency-Key, or a call the
 * caller marks repeatable, such as a sign-in: a repeat at worst opens one more session).
 */
async function api(method, urlPath, { token, body, headers = {}, retries = 4, repeatable = false } = {}) {
  const idempotent = repeatable || method === 'GET' || Boolean(headers['Idempotency-Key']);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${CONFIG.baseUrl}${urlPath}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (idempotent && attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new Error(`${method} ${urlPath}: ${err.cause?.code || err.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt;
      if (waitSeconds <= 60) {
        log(`  rate limited on ${method} ${urlPath.split('?')[0]}, waiting ${waitSeconds}s`);
        await sleep(waitSeconds * 1000 + Math.random() * 250);
        continue;
      }
    }
    if (res.status >= 500 && idempotent && attempt < retries) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    return { status: res.status, body: json };
  }
}

// ------------------------------------------------------------------------------------------------------------
// Mailpit (development SMTP capture)

async function mailFor(to) {
  const res = await fetch(`${CONFIG.mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=200`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Mailpit search failed: HTTP ${res.status} (is MAILPIT_URL right?)`);
  return (await res.json()).messages ?? [];
}

const seenIds = async (to) => new Set((await mailFor(to)).map((m) => m.ID));

/** The newest message to `to` matching `subject` that is not in `seen`, with its text body; null on timeout */
async function waitForNewEmail(to, subject, seen, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await mailFor(to)).find((m) => !seen.has(m.ID) && subject.test(m.Subject));
    if (match) {
      const full = await (await fetch(`${CONFIG.mailpit}/api/v1/message/${match.ID}`, { signal: AbortSignal.timeout(10_000) })).json();
      return { subject: match.Subject, text: full.Text ?? '' };
    }
    await sleep(750);
  }
  return null;
}

const tokenFrom = (text) => decodeURIComponent(/#token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? '');

// ------------------------------------------------------------------------------------------------------------
// TOTP (RFC 6238). Codes are single-use per time step server-side, so every code comes from a step this
// script has not used yet (remembered in seed-state.json by a fingerprint, never by the secret itself).

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of input.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
}

const fingerprint = (secret) => sha256(`totp:${secret}`).slice(0, 16);
const externalUsedSteps = new Map(); // steps other tools (the journey state file) already used

async function freshTotp(secret) {
  const fp = fingerprint(secret);
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    // Check and claim without an await in between, so concurrent callers never get the same step
    if (step > Math.max(state.usedSteps[fp] ?? -1, externalUsedSteps.get(fp) ?? -1)) {
      state.usedSteps[fp] = step;
      saveState();
      return totp(secret, step);
    }
    await sleep(1000);
  }
}

// ------------------------------------------------------------------------------------------------------------
// Sessions: sign in once, refresh before the access token expires, one refresh in flight per session

class Session {
  constructor(label, email, password, totpSecret) {
    Object.assign(this, { label, email, password, totpSecret, userId: null, refreshing: null });
  }

  adopt(tokens) {
    this.accessToken = tokens.accessToken;
    if (tokens.refreshToken) this.refreshToken = tokens.refreshToken;
    this.expiresAt = Date.now() + (tokens.expiresInSeconds ?? 900) * 1000;
  }

  async login() {
    for (let attempt = 1; ; attempt++) {
      const res = await api('POST', '/api/v1/auth/login', { body: { email: this.email, password: this.password }, repeatable: true });
      if (res.status !== 200) throw new ApiError(`sign-in as ${this.label}`, res);
      let data = res.body.data;
      if (data.mfaRequired) {
        if (!this.totpSecret) throw new Error(`${this.label} has an authenticator enrolled but no TOTP secret is known`);
        const mfa = await api('POST', '/api/v1/auth/login/mfa', {
          body: { challengeToken: data.challengeToken, code: await freshTotp(this.totpSecret) },
        });
        // Another client may have used this time step already: the next step's code will do
        if ((mfa.status === 400 || mfa.status === 401) && attempt < 3) {
          log(`  ${this.label}: authenticator code refused, retrying with the next one`);
          continue;
        }
        if (mfa.status !== 200) throw new ApiError(`authenticator sign-in as ${this.label}`, mfa);
        data = mfa.body.data;
      }
      this.adopt(data.tokens);
      this.userId = data.user.id;
      return this;
    }
  }

  async token() {
    if (Date.now() < this.expiresAt - 60_000) return this.accessToken;
    this.refreshing ??= (async () => {
      const res = this.refreshToken ? await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: this.refreshToken } }) : null;
      if (res?.status === 200) this.adopt(res.body.data);
      else await this.login();
    })().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    return this.accessToken;
  }

  async call(method, urlPath, options = {}) {
    return api(method, urlPath, { ...options, token: await this.token() });
  }
}

// ------------------------------------------------------------------------------------------------------------
// Staff

function loadAdmins() {
  const stateFile = flags['admin-state'] ?? process.env.SEED_ADMIN_STATE;
  if (stateFile) {
    const journeyState = readJson(path.resolve(stateFile), null);
    if (!journeyState) usage(`--admin-state ${stateFile} does not exist`);
    const admins = journeyState.admins ?? [];
    if (admins.length < 2) usage(`${stateFile} must list two administrators (staff administration is four-eyes)`);
    return admins.slice(0, 2).map((a, n) => {
      const secret = journeyState.secrets?.[a.email];
      if (!a.email || !a.password || !secret) usage(`${stateFile}: administrator ${n + 1} needs an email, password and authenticator secret`);
      if (Number.isInteger(journeyState.usedSteps?.[secret])) externalUsedSteps.set(fingerprint(secret), journeyState.usedSteps[secret]);
      return { email: a.email, password: a.password, secret };
    });
  }
  return ['SEED_ADMIN', 'SEED_ADMIN2'].map((prefix) => {
    const admin = { email: process.env[`${prefix}_EMAIL`], password: process.env[`${prefix}_PASSWORD`], secret: process.env[`${prefix}_TOTP_SECRET`] };
    if (!admin.email || !admin.password || !admin.secret) {
      usage(`Two administrators are needed: pass --admin-state FILE, or set ${prefix}_EMAIL, ${prefix}_PASSWORD and ${prefix}_TOTP_SECRET`);
    }
    return admin;
  });
}

const randomPassword = () => `Lt-${crypto.randomBytes(18).toString('base64url')}-9a`;
const runTag = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}${crypto.randomBytes(3).toString('hex')}`;
let staffSerial = 0;

/** Four-eyes onboarding: requested by one administrator, approved by the other, activated and enrolled from email */
async function onboardStaff(admin, admin2, role, label) {
  const email = `lt.${role.toLowerCase().replace('_', '')}.${runTag}${++staffSerial}@${CONFIG.staffDomain}`;
  const password = randomPassword();
  log(`  onboarding ${label} ${email} (requested by one administrator, approved by the other)`);
  const request = await admin.call('POST', '/api/v1/auth/admin/users', { body: { email, role } });
  if (request.status !== 202) throw new ApiError(`request ${role}`, request);
  const approve = await admin2.call('POST', `/api/v1/auth/admin/requests/${request.body.data.requestId}/approve`);
  if (approve.status !== 200) throw new ApiError(`approve ${role}`, approve);
  const mail = await waitForNewEmail(email, /Activate your BankSphere staff account/, new Set());
  if (!mail) throw new Error(`no activation email for ${email} in Mailpit`);
  const activate = await api('POST', '/api/v1/auth/staff/activate', { body: { token: tokenFrom(mail.text), password } });
  if (activate.status !== 200) throw new ApiError(`activate ${role}`, activate);
  const { enrolmentToken, tokens } = activate.body.data;
  const setup = await api('POST', '/api/v1/auth/mfa/setup', { token: tokens.accessToken, body: { password, enrolmentToken } });
  if (setup.status !== 200) throw new ApiError(`authenticator setup for ${role}`, setup);
  const secret = setup.body.data.secret;
  const enable = await api('POST', '/api/v1/auth/mfa/enable', {
    token: tokens.accessToken,
    body: { code: await freshTotp(secret), enrolmentToken },
  });
  if (enable.status !== 200) throw new ApiError(`authenticator enrolment for ${role}`, enable);
  const record = { role, email, password, secret, userId: approve.body.data.outcome.userId, createdAt: new Date().toISOString() };
  const session = new Session(label, email, password, secret);
  session.adopt(enable.body.data.tokens);
  session.userId = record.userId;
  return { record, session };
}

// ------------------------------------------------------------------------------------------------------------
// Customers

/** 1 -> A, 26 -> Z, 27 -> AA: profile names may only contain letters */
function alpha(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const phoneFor = (i) => `+9197${String(parseInt(sha256(CONFIG.prefix).slice(0, 6), 16) % 100).padStart(2, '0')}${String(i).padStart(6, '0')}`;

async function verifyFrom(mail, email) {
  const res = await api('POST', '/api/v1/auth/email/verify', { body: { token: tokenFrom(mail.text) } });
  if (res.status !== 200) throw new ApiError(`verify ${email}`, res);
}

/** Registers (or recovers) the customer without ever probing with a failed sign-in */
async function registerOrRecover(session) {
  const { email } = session;
  const seen = await seenIds(email);
  const reg = await api('POST', '/api/v1/auth/register', { body: { email, password: CONFIG.password } });
  if (reg.status !== 202) throw new ApiError(`register ${email}`, reg);
  const mail = await waitForNewEmail(email, /Verify your BankSphere email|Sign-up attempt/, seen, 30_000);
  if (mail && /Verify/.test(mail.subject)) {
    await verifyFrom(mail, email);
    await session.login();
    return 'created';
  }
  // The address already has an account (the sign-up-attempt notice is rate-limited, so no email is fine too)
  return signInOrFinishVerification(session);
}

async function signInOrFinishVerification(session) {
  const { email } = session;
  try {
    await session.login();
    return 'reused';
  } catch (err) {
    if (err.code !== 'EMAIL_NOT_VERIFIED') {
      throw Object.assign(new Error(`${email} exists but SEED_PASSWORD does not sign in (${err.message})`), { signInFailed: true });
    }
  }
  const seen = await seenIds(email);
  const resend = await api('POST', '/api/v1/auth/email/resend-verification', { body: { email } });
  if (resend.status !== 202) throw new ApiError(`resend verification for ${email}`, resend);
  const mail = await waitForNewEmail(email, /Verify your BankSphere email/, seen);
  if (!mail) throw new Error(`no verification email for ${email} in Mailpit`);
  await verifyFrom(mail, email);
  await session.login();
  return 'verified';
}

async function prepareCustomer(i) {
  const email = `lt.${CONFIG.prefix}.${i}@loadtest.test`;
  const session = new Session(email, email, CONFIG.password);
  let outcome;
  if (previousUsers.has(email)) {
    try {
      outcome = await signInOrFinishVerification(session);
    } catch (err) {
      if (!err.signInFailed) throw err;
      outcome = await registerOrRecover(session); // listed in users.json but gone (e.g. a reset stack)
    }
  } else {
    outcome = await registerOrRecover(session);
  }

  let me = await session.call('GET', '/api/v1/customers/me');
  if (me.status === 404) {
    me = await session.call('POST', '/api/v1/customers/me', { body: { fullName: `Load Tester ${alpha(i)}`, phoneNumber: phoneFor(i) } });
    if (me.status !== 201) throw new ApiError(`create profile for ${email}`, me);
  } else if (me.status !== 200) {
    throw new ApiError(`read profile of ${email}`, me);
  }
  const kycStatus = me.body.data.kycStatus;
  if (kycStatus === 'REJECTED') throw new Error(`${email}: KYC was REJECTED; use another --prefix`);
  return { i, email, session, outcome, kycStatus };
}

async function verifyKyc(officer, customer) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const profile = await officer.call('GET', `/api/v1/customers/${customer.session.userId}`);
    if (profile.status !== 200) throw new ApiError(`read profile of ${customer.email} as KYC officer`, profile);
    if (profile.body.data.kycStatus === 'VERIFIED') return;
    const decision = await officer.call('PATCH', `/api/v1/customers/${customer.session.userId}/kyc`, {
      body: { kycStatus: 'VERIFIED', expectedVersion: profile.body.data.version },
    });
    if (decision.status === 200) return;
    if (decision.status !== 409) throw new ApiError(`KYC decision for ${customer.email}`, decision);
  }
  throw new Error(`KYC decision for ${customer.email} kept conflicting with profile changes`);
}

async function ensureAccounts(customer) {
  const list = await customer.session.call('GET', '/api/v1/accounts');
  if (list.status !== 200) throw new ApiError(`list accounts of ${customer.email}`, list);
  const accounts = [];
  let opened = 0;
  for (const accountType of ['SAVINGS', 'CURRENT']) {
    let account = list.body.data.find((a) => a.accountType === accountType && a.status === 'ACTIVE');
    if (!account) {
      const created = await customer.session.call('POST', '/api/v1/accounts', { body: { accountType } });
      if (created.status !== 201) throw new ApiError(`open ${accountType} for ${customer.email}`, created);
      account = created.body.data;
      opened++;
    }
    const balance = await customer.session.call('GET', `/api/v1/transactions/accounts/${account.id}/balance`);
    if (balance.status !== 200) throw new ApiError(`balance of ${customer.email} ${accountType}`, balance);
    accounts.push({ id: account.id, accountNumber: account.accountNumber, accountType, balance: BigInt(balance.body.data.balanceInPaise) });
  }
  customer.accounts = accounts;
  return opened;
}

// ------------------------------------------------------------------------------------------------------------
// Teller cash

/** Closes the drawer with the exact cash it took in and has an administrator sign it off (blind count) */
async function closeDrawer(admin, drawer) {
  const counted = drawer.cash.toString();
  const close = await drawer.teller.call('POST', '/api/v1/transactions/teller/sessions/close', { body: { countedCashPaise: counted } });
  if (close.status !== 200) throw new ApiError('close teller session', close);
  const signOff = await admin.call('POST', `/api/v1/transactions/teller/sessions/${drawer.sessionId}/sign-off`, { body: { countedCashPaise: counted } });
  if (signOff.status !== 200) throw new ApiError('sign off teller session', signOff);
  const discrepancy = signOff.body.data?.discrepancy ?? '0';
  log(`  teller session closed and signed off: ${formatRupees(drawer.cash)} counted, discrepancy ${discrepancy}`);
  state.openSession = null;
  saveState();
}

/** A drawer left open by an interrupted run is closed with the cash this script recorded, so tomorrow's float can be issued */
async function recoverOpenDrawer(admin) {
  const open = state.openSession;
  if (!open) return;
  const record = state.tellers.find((t) => t.email === open.tellerEmail);
  log(`Recovering the teller session left open by an earlier run (${open.tellerEmail})`);
  if (!record) {
    log('  the teller is not in seed-state.json; close that session from the teller desk');
    state.openSession = null;
    saveState();
    return;
  }
  const teller = await new Session('teller', record.email, record.password, record.secret).login();
  const current = await teller.call('GET', '/api/v1/transactions/teller/sessions/current');
  const session = current.body?.data;
  const drawer = { teller, sessionId: open.sessionId, cash: BigInt(open.cashPaise) };
  if (session?.id === open.sessionId && session.status === 'OPEN') {
    await closeDrawer(admin, drawer);
  } else if (session?.id === open.sessionId && session.status === 'CLOSED') {
    const signOff = await admin.call('POST', `/api/v1/transactions/teller/sessions/${open.sessionId}/sign-off`, { body: { countedCashPaise: open.cashPaise } });
    if (signOff.status !== 200) throw new ApiError('sign off the recovered teller session', signOff);
    state.openSession = null;
    saveState();
  } else {
    state.openSession = null;
    saveState();
  }
}

async function openDrawer(admin, admin2) {
  // Reuse the latest teller if it has not had a session this business day; otherwise onboard a new one
  const latest = state.tellers.at(-1);
  if (latest) {
    try {
      const teller = await new Session('teller', latest.email, latest.password, latest.secret).login();
      const drawer = await issueAndAccept(admin, teller, latest);
      if (drawer) return drawer;
    } catch (err) {
      log(`  stored teller unusable (${err.message}); onboarding a new one`);
    }
  }
  const { record, session } = await onboardStaff(admin, admin2, 'TELLER', 'teller');
  state.tellers.push(record);
  saveState();
  const drawer = await issueAndAccept(admin, session, record);
  if (!drawer) throw new Error(`a float could not be issued to the new teller ${record.email}`);
  return drawer;
}

async function issueAndAccept(admin, teller, record) {
  // A zero float: the drawer only ever holds the deposits, so the close-out count is exactly their sum
  const issued = await admin.call('POST', '/api/v1/transactions/teller/sessions', { body: { tellerId: record.userId, openingFloatPaise: '0' } });
  if (issued.status === 409) return null; // already had a session this business day
  if (issued.status !== 201) throw new ApiError('issue teller float', issued);
  const accepted = await teller.call('POST', '/api/v1/transactions/teller/sessions/accept', { body: { countedFloatPaise: '0' } });
  if (accepted.status !== 200) throw new ApiError('accept teller float', accepted);
  const drawer = { teller, record, sessionId: accepted.body.data.id, cash: 0n };
  state.openSession = { tellerEmail: record.email, sessionId: drawer.sessionId, cashPaise: '0' };
  saveState();
  log(`  teller session opened for ${record.email}`);
  return drawer;
}

async function deposit(admin, drawer, item) {
  // Deterministic key: a retried or re-run deposit into the same session is executed once
  const key = `seed-${sha256(`${drawer.sessionId}:${item.accountId}:${item.chunk}`).slice(0, 40)}`;
  const res = await drawer.teller.call('POST', '/api/v1/transactions/deposit', {
    headers: { 'Idempotency-Key': key },
    body: { accountId: item.accountId, amountInPaise: item.amount.toString(), description: 'Load-test seed deposit' },
  });
  if (res.status === 202 && res.body.data?.status === 'PENDING_APPROVAL') {
    // Over the teller's limits after all: a supervisor approves it (maker-checker), as at a real branch
    const approve = await admin.call('POST', `/api/v1/transactions/cash-operations/${res.body.data.cashOperationId}/approve`, {
      headers: { 'Idempotency-Key': `${key}-ok` },
    });
    if (approve.status !== 201) throw new ApiError(`approve deposit for ${item.customer.email}`, approve);
  } else if (res.status !== 201) {
    throw new ApiError(`deposit for ${item.customer.email}`, res);
  }
  drawer.cash += item.amount;
  state.openSession.cashPaise = drawer.cash.toString();
  saveState();
}

// ------------------------------------------------------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const errors = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try {
          results[index] = await fn(items[index], index);
        } catch (err) {
          errors.push(err);
          next = items.length; // stop handing out work; let in-flight items finish
        }
      }
    })
  );
  if (errors.length) throw errors[0];
  return results;
}

function formatRupees(paise) {
  const rupees = paise / 100n;
  const rest = (paise % 100n).toString().padStart(2, '0');
  return `Rs ${rupees.toLocaleString('en-IN')}.${rest}`;
}

async function preflight() {
  const health = await api('GET', '/health/live', { retries: 1 }).catch((err) => ({ status: 0, error: err }));
  if (health.status !== 200) throw new Error(`the API at ${CONFIG.baseUrl} is not reachable (GET /health/live -> ${health.status || health.error.message})`);
  try {
    await mailFor('nobody@loadtest.test');
  } catch (err) {
    throw new Error(`Mailpit at ${CONFIG.mailpit} is not reachable: the seed only runs against stacks that capture email (${err.message})`);
  }
}

async function main() {
  const started = Date.now();
  log(`Seeding ${CONFIG.users} customers (lt.${CONFIG.prefix}.1..${CONFIG.users}@loadtest.test) on ${CONFIG.baseUrl}, target balance ${formatRupees(CONFIG.balance)}`);
  const adminCreds = loadAdmins();
  await preflight();

  log('Signing in both administrators (authenticator codes)');
  const admin = await new Session('administrator 1', adminCreds[0].email, adminCreds[0].password, adminCreds[0].secret).login();
  const admin2 = await new Session('administrator 2', adminCreds[1].email, adminCreds[1].password, adminCreds[1].secret).login();
  await recoverOpenDrawer(admin);

  const indexes = Array.from({ length: CONFIG.users }, (_, n) => n + 1);
  // A users.json from a stack that has since been reset would cost one failed sign-in per customer, which the
  // edge treats as credential stuffing: probe one listed customer first and forget the file if it is stale
  const probe = indexes.map((i) => `lt.${CONFIG.prefix}.${i}@loadtest.test`).find((email) => previousUsers.has(email));
  if (probe) {
    try {
      await new Session(probe, probe, CONFIG.password).login();
    } catch (err) {
      if (err.status === 401) {
        log(`users.json does not match this stack (${probe} cannot sign in); registering from scratch`);
        previousUsers.clear();
      }
    }
  }

  log(`Customers: register, verify, sign in, profile (${CONFIG.concurrency} at a time)`);
  let done = 0;
  const customers = await mapLimit(indexes, CONFIG.concurrency, async (i) => {
    const customer = await prepareCustomer(i);
    log(`  [${String(++done).padStart(String(CONFIG.users).length)}/${CONFIG.users}] ${customer.email} ${customer.outcome}, KYC ${customer.kycStatus}`);
    return customer;
  });

  const pendingKyc = customers.filter((c) => c.kycStatus !== 'VERIFIED');
  if (pendingKyc.length) {
    log(`KYC: ${pendingKyc.length} customer${pendingKyc.length === 1 ? '' : 's'} to verify`);
    let officer = null;
    if (state.kycOfficer) {
      try {
        officer = await new Session('KYC officer', state.kycOfficer.email, state.kycOfficer.password, state.kycOfficer.secret).login();
      } catch (err) {
        log(`  stored KYC officer unusable (${err.message}); onboarding a new one`);
      }
    }
    if (!officer) {
      const onboarded = await onboardStaff(admin, admin2, 'KYC_OFFICER', 'KYC officer');
      state.kycOfficer = onboarded.record;
      saveState();
      officer = onboarded.session;
    }
    await mapLimit(pendingKyc, CONFIG.concurrency, (c) => verifyKyc(officer, c));
  }

  log('Accounts: SAVINGS and CURRENT for everyone');
  const opened = (await mapLimit(customers, CONFIG.concurrency, ensureAccounts)).reduce((a, b) => a + b, 0);

  // Deposits are split so no single one needs a supervisor's approval
  const deposits = [];
  for (const c of customers) {
    const total = c.accounts.reduce((sum, a) => sum + a.balance, 0n);
    let missing = CONFIG.balance > total ? CONFIG.balance - total : 0n;
    const savings = c.accounts.find((a) => a.accountType === 'SAVINGS');
    for (let chunk = 0; missing > 0n; chunk++) {
      const amount = missing < CONFIG.singleApprovalLimit ? missing : CONFIG.singleApprovalLimit;
      deposits.push({ customer: c, accountId: savings.id, amount, chunk });
      missing -= amount;
    }
  }
  const depositTotal = deposits.reduce((sum, d) => sum + d.amount, 0n);
  if (deposits.length) {
    log(`Cash: ${deposits.length} deposits, ${formatRupees(depositTotal)} in total`);
    const queue = [...deposits];
    while (queue.length) {
      // One teller session takes at most the teller's daily cash limit
      const batch = [];
      let sum = 0n;
      while (queue.length && sum + queue[0].amount <= CONFIG.tellerDailyLimit) {
        sum += queue[0].amount;
        batch.push(queue.shift());
      }
      if (!batch.length) throw new Error('a single deposit exceeds TELLER_DAILY_LIMIT_PAISE');
      const drawer = await openDrawer(admin, admin2);
      try {
        await mapLimit(batch, CONFIG.concurrency, async (item) => {
          await deposit(admin, drawer, item);
          item.customer.accounts.find((a) => a.id === item.accountId).balance += item.amount;
        });
      } finally {
        // Even after a failure the drawer is closed with what it really took in, so the books stay balanced
        await closeDrawer(admin, drawer);
      }
    }
  } else {
    log('Cash: every customer already holds the target balance');
  }

  const users = customers
    .sort((a, b) => a.i - b.i)
    .map((c) => ({
      email: c.email,
      password: CONFIG.password,
      userId: c.session.userId,
      accounts: c.accounts.map(({ id, accountNumber, accountType }) => ({ id, accountNumber, accountType })),
    }));
  writeJsonPrivate(USERS_FILE, users);

  const count = (outcome) => customers.filter((c) => c.outcome === outcome).length;
  log(
    `Done in ${Math.round((Date.now() - started) / 1000)}s: ${count('created')} created, ${count('verified')} verified, ${count('reused')} reused; ` +
      `${pendingKyc.length} KYC approvals, ${opened} accounts opened, ${deposits.length} deposits (${formatRupees(depositTotal)}).`
  );
  log(`Users file: ${path.relative(process.cwd(), USERS_FILE) || USERS_FILE}`);
}

main().catch((err) => {
  console.error(`\nSeeding failed: ${err.message}`);
  process.exit(1);
});
