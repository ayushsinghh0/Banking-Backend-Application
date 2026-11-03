import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

export const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
const here = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = path.resolve(here, '..', '.state');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const RUN_ID = process.env.E2E_RUN_ID || crypto.randomBytes(3).toString('hex');

// --- persistent state (TOTP secrets and last used steps survive runs; codes are single-use server-side) ---

interface State {
  secrets: Record<string, string>;
  usedSteps: Record<string, number>;
  [key: string]: unknown;
}

export function readState(): State {
  try {
    return { secrets: {}, usedSteps: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } as State;
  } catch {
    return { secrets: {}, usedSteps: {} };
  }
}

export function writeState(patch: Partial<State>): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const current = readState();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...current, ...patch }, null, 2), { mode: 0o600 });
}

export function rememberSecret(email: string, secret: string): void {
  const state = readState();
  writeState({ secrets: { ...state.secrets, [email]: secret } });
}

// --- RFC 6238 TOTP, as authenticator apps compute it ---

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of input.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
}

/** A code for a time step this secret has not used yet (waits for the next 30 s window if needed) */
/** The API suites (backend/scripts) sign in as the same administrators; a code is single-use, so honour their steps too */
const API_SUITE_STATE = path.resolve(here, '..', '..', '..', 'backend', 'scripts', '.e2e-state.json');
function apiSuiteStep(secret: string): number {
  try {
    return (JSON.parse(fs.readFileSync(API_SUITE_STATE, 'utf8')) as { usedSteps?: Record<string, number> }).usedSteps?.[secret] ?? -1;
  } catch {
    return -1;
  }
}

export async function freshTotp(secret: string): Promise<string> {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    const state = readState();
    if (Math.max(state.usedSteps[secret] ?? -1, apiSuiteStep(secret)) < step) {
      writeState({ usedSteps: { ...state.usedSteps, [secret]: step } });
      return totpAt(secret, step);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- Mailpit ---

interface MailSummary {
  ID: string;
  Subject: string;
}

export async function waitForEmail(to: string, subject: RegExp, timeoutMs = 60_000): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
    if (res.ok) {
      const { messages = [] } = (await res.json()) as { messages?: MailSummary[] };
      const match = messages.find((m) => subject.test(m.Subject));
      if (match) {
        const full = (await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json()) as { Text: string; Subject: string };
        return { subject: full.Subject, text: full.Text };
      }
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`No email to ${to} matching ${subject} within ${timeoutMs} ms`);
}

/** The path + fragment of the link in an email (e.g. /verify-email#token=…), to open on the app origin */
export function linkFrom(text: string, pathname: string): string {
  const match = new RegExp(`https?://[^\\s"']+(${pathname.replace(/\//g, '\\/')}#token=[A-Za-z0-9_%-]+)`).exec(text);
  if (!match?.[1]) throw new Error(`No ${pathname} link in email`);
  return decodeURIComponent(match[1]);
}

// --- UI steps shared by journeys ---

export const PASSWORD = 'Journey-Pass-2026';

export async function signIn(page: Page, email: string, password = PASSWORD, secret?: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (secret) {
    await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
    await page.getByLabel('Authenticator code').fill(await freshTotp(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}

/** Completes authenticator setup on the current page and returns the secret */
export async function enrolAuthenticator(page: Page, password = PASSWORD): Promise<string> {
  await page.getByLabel('Your password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  const key = (await page.locator('code').first().textContent())?.replace(/\s+/g, '') ?? '';
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel('6-digit code from the app').fill(await freshTotp(key));
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
  return key;
}

/** Rupees for a MoneyInput */
export const rupees = (value: string) => value;
