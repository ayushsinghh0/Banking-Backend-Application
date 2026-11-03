/**
 * Shared helpers for the end-to-end suites (scripts/e2e.mjs, scripts/e2e-platform.mjs): HTTP through the
 * gateway, Mailpit, RFC 6238 TOTP with single-use steps remembered across runs, and the production ways of
 * creating customers and staff (verification email, four-eyes approval, MFA enrolment).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export function createKit({ gateway, mailpit, stateFile }) {
  let passed = 0;
  let failed = 0;
  const serverErrors = [];

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

  async function api(method, p, { token, body, headers = {}, base = gateway } = {}) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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
      const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
      if (!res.ok) return null;
      const { messages = [] } = await res.json();
      const match = messages.find((m) => subjectPattern.test(m.Subject));
      if (!match) return null;
      const full = await (await fetch(`${mailpit}/api/v1/message/${match.ID}`)).json();
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
   * used step is remembered across runs (the state file) — re-running within 30s waits for the next window.
   */
  const readState = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {});
  const state = readState();
  const usedSteps = new Map(Object.entries(state.usedSteps ?? {}));
  function saveState(extra = {}) {
    const current = readState();
    fs.writeFileSync(stateFile, JSON.stringify({ ...current, ...extra, usedSteps: Object.fromEntries(usedSteps) }, null, 2), { mode: 0o600 });
  }
  // The browser journeys (frontend/e2e) sign in as the same administrators; a code is single-use, so honour their steps too
  const browserStateFile = new URL('../../../frontend/e2e/.state/state.json', import.meta.url);
  const browserStep = (secret) => {
    try {
      return JSON.parse(fs.readFileSync(browserStateFile, 'utf8')).usedSteps?.[secret] ?? -1;
    } catch {
      return -1;
    }
  };
  async function freshTotp(secret) {
    for (;;) {
      const step = Math.floor(Date.now() / 30000);
      if (Math.max(usedSteps.get(secret) ?? -1, browserStep(secret)) < step) {
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
    // Names are letters only (digits are refused by profile validation)
    const first = user.email.split('.')[0].replace(/[^A-Za-z]/g, '') || 'Customer';
    await api('POST', '/api/v1/customers/me', { token: user.token, body: { fullName: `Test ${first}`, phoneNumber: '+919876543210' } });
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
    return { token: res.body.data.tokens.accessToken, refreshToken: res.body.data.tokens.refreshToken, id: res.body.data.user.id, email, secret };
  }

  /**
   * Staff onboarding the production way: requested by one administrator, approved by another, activated by
   * the staff member from the email link (choosing their own password), then MFA enrolment.
   */
  async function onboardStaff(admin, admin2, role, name) {
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

  /** Prints the totals and returns the process exit code */
  function summary() {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    return failed ? 1 : 0;
  }

  return {
    check, section, sleep, api, waitFor, waitForEmail, totp, freshTotp, saveState, usedSteps, state, serverErrors,
    tokenFrom, key, runId, PASSWORD, idem, login, enrolMfa, registerVerified, decideKyc, kycVerified, balance,
    bootstrapAdmin, onboardStaff, summary,
  };
}
