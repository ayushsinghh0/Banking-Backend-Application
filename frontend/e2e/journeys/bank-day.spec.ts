/**
 * A full day at the bank, driven through the browser against the real stack:
 * administrators onboard staff (four-eyes) → a customer signs up, verifies email, completes KYC → accounts →
 * teller float, deposit, code-authorised withdrawal → transfer → supervisor approval → fraud triage →
 * blind close-out and sign-off → security settings → add money, Sphere, sessions and the operations consoles.
 * Screenshots for the docs are taken along the way.
 */
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { enrolAuthenticator, freshTotp, linkFrom, PASSWORD, readState, rememberSecret, RUN_ID, signIn, signOut, waitForEmail } from '../support/helpers';
import { darkShot, shot } from '../support/shots';

test.describe.configure({ mode: 'serial' });

const letters = RUN_ID.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!);
const customer = { email: `asha.${RUN_ID}@e2e.test`, name: `Asha ${letters.charAt(0).toUpperCase()}${letters.slice(1)}` };
const STAFF = [
  { key: 'teller', role: 'Teller', email: `teller.${RUN_ID}@banksphere.local`, home: '/teller' },
  { key: 'kyc', role: 'KYC officer', email: `kyc.${RUN_ID}@banksphere.local`, home: '/kyc' },
  { key: 'fraud', role: 'Fraud analyst', email: `fraud.${RUN_ID}@banksphere.local`, home: '/fraud' },
] as const;

const pages: Record<string, Page> = {};
let browserRef: Browser;
let savings = { id: '', number: '' };
let current = { id: '', number: '' };

async function persona(name: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browserRef.newContext({
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8080',
    viewport,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const page = await context.newPage();
  pages[name] = page;
  return page;
}

const dialogOf = (page: Page): Locator => page.getByRole('dialog').or(page.getByRole('alertdialog'));

async function findAccountAtDesk(teller: Page, accountNumber: string): Promise<void> {
  await teller.getByLabel('Account number').fill(accountNumber);
  await teller.getByRole('button', { name: 'Find account' }).click();
  await expect(teller.getByText(customer.name)).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  browserRef = browser;
});

test.afterAll(async () => {
  await Promise.all(Object.values(pages).map((p) => p.context().close()));
});

test('administrators sign in with their authenticator codes', async () => {
  const state = readState() as ReturnType<typeof readState> & { admins?: Array<{ email: string; password: string }> };
  expect(state.admins, 'run e2e/bootstrap.mjs first').toHaveLength(2);
  const [lead, second] = state.admins!;
  const leadPage = await persona('lead');
  await leadPage.goto('/login');
  await expect(leadPage.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await shot(leadPage, '01-sign-in');
  await darkShot(leadPage, '01-sign-in-dark');
  const mobile = await persona('mobile-signin', { width: 390, height: 844 });
  await mobile.goto('/login');
  await shot(mobile, '01-sign-in-mobile');

  await signIn(leadPage, lead!.email, lead!.password, state.secrets[lead!.email]);
  await expect(leadPage).toHaveURL(/\/overview$/);
  const secondPage = await persona('second');
  await signIn(secondPage, second!.email, second!.password, state.secrets[second!.email]);
  await expect(secondPage).toHaveURL(/\/overview$/);
});

test('four-eyes staff onboarding: request, second approval, self-activation, authenticator', async () => {
  test.setTimeout(420_000);
  const lead = pages.lead!;
  for (const staff of STAFF) {
    await lead.goto('/approvals');
    await lead.getByRole('button', { name: 'Request new staff member' }).click();
    const dialog = lead.getByRole('dialog', { name: 'Request a new staff member' });
    await dialog.getByLabel('Corporate email').fill(staff.email);
    await dialog.getByRole('radio', { name: new RegExp(`^${staff.role}`, 'i') }).click();
    if (staff.key === 'teller') await shot(lead, '05a-request-staff');
    await dialog.getByRole('button', { name: 'Send for approval' }).click();
    await dialog.getByRole('button', { name: 'Done' }).click();
  }

  const second = pages.second!;
  await second.goto('/approvals');
  for (const staff of STAFF) await expect(second.getByRole('article').filter({ hasText: staff.email })).toBeVisible();
  await shot(second, '05-approvals');
  for (const staff of STAFF) {
    await second.getByRole('article').filter({ hasText: staff.email }).getByRole('button', { name: /^approve/i }).click();
    await dialogOf(second).getByRole('button', { name: 'Approve and send invite' }).click();
    await expect(second.getByRole('article').filter({ hasText: staff.email })).toHaveCount(0);
  }

  for (const staff of STAFF) {
    const mail = await waitForEmail(staff.email, /Activate your BankSphere staff account/);
    const page = await persona(staff.key);
    await page.goto(linkFrom(mail.text, '/staff/activate'));
    await page.getByLabel('Choose a password').fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Activate account' }).click();
    await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
    if (staff.key === 'teller') {
      await page.getByLabel('Your password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('img', { name: /qr code/i })).toBeVisible();
      await shot(page, '03-staff-authenticator-enrolment', { mask: [page.getByRole('img', { name: /qr code/i }), page.locator('code')] });
      const key = ((await page.locator('code').first().textContent()) ?? '').replace(/\s+/g, '');
      await page.getByLabel('6-digit code from the app').fill(await freshTotp(key));
      await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
      rememberSecret(staff.email, key);
    } else {
      rememberSecret(staff.email, await enrolAuthenticator(page));
    }
    await expect(page).toHaveURL(new RegExp(`${staff.home}$`));
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();
  }
});

test('a customer signs up, verifies their email and completes their profile', async () => {
  const page = await persona('customer');
  await page.goto('/register');
  await page.getByLabel('Email').fill(customer.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await shot(page, '02-register');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const mail = await waitForEmail(customer.email, /Verify your BankSphere email/);
  await page.goto(linkFrom(mail.text, '/verify-email'));
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();

  await signIn(page, customer.email);
  await expect(page).toHaveURL(/\/dashboard$/);
  await shot(page, '06a-customer-onboarding');
  await page.getByRole('link', { name: /complete your profile/i }).first().click();
  await page.getByLabel('Full name').fill(customer.name);
  await page.getByLabel('Mobile number').fill('+91 98765 43210');
  await page.getByLabel('Date of birth').fill('1992-04-12');
  await page.getByLabel(/address/i).fill('12 MG Road, Pune');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByText('Verification in progress')).toBeVisible();
  await shot(page, '12-profile-kyc-pending');
});

test('a KYC officer finds the customer in the queue and verifies their identity', async () => {
  const kyc = pages.kyc!;
  await kyc.goto('/kyc');
  await kyc.getByLabel('Search').fill(customer.name);
  await expect(kyc.getByText(customer.name)).toBeVisible();
  await shot(kyc, '17-kyc-queue');
  await kyc.getByText(customer.name).click();
  await expect(kyc).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  await kyc.getByRole('button', { name: 'Verify identity' }).click();
  await dialogOf(kyc).getByRole('button', { name: 'Verify identity' }).click();
  await expect(kyc.getByText('KYC verified').first()).toBeVisible();
  await shot(kyc, '18-customer-360');
});

test('the verified customer opens a savings and a current account', async () => {
  const page = pages.customer!;
  for (const type of ['savings', 'current'] as const) {
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'Open account' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Open an account' });
    if (type === 'current') await dialog.getByRole('radio', { name: /current account/i }).click();
    else await shot(page, '06b-open-account');
    await dialog.getByRole('button', { name: `Open ${type} account` }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/);
    const id = page.url().split('/').pop()!;
    const formatted = await page.getByText(/^\d{4} \d{4} \d{4}$/).first().textContent();
    const account = { id, number: (formatted ?? '').replace(/\s/g, '') };
    expect(account.number).toMatch(/^\d{12}$/);
    if (type === 'savings') savings = account;
    else current = account;
  }
});

test('a supervisor issues a float; the teller counts it blind and takes a deposit', async () => {
  const lead = pages.lead!;
  await lead.goto('/teller-sessions');
  await lead.getByRole('button', { name: 'Issue opening float' }).click();
  const dialog = dialogOf(lead);
  await dialog.getByLabel('Teller').selectOption({ label: STAFF[0].email });
  await dialog.getByLabel('Opening float').fill('50,000');
  await dialog.getByRole('button', { name: 'Issue float' }).click();
  await expect(lead.getByText('Float issued').first()).toBeVisible();

  const teller = pages.teller!;
  await teller.goto('/teller');
  await expect(teller.getByRole('heading', { name: 'Count your opening float' })).toBeVisible();
  await expect(teller.getByText(/50,000/)).toHaveCount(0);
  await shot(teller, '14a-teller-blind-float');
  await teller.getByLabel('Total counted').fill('50,000');
  await teller.getByRole('button', { name: 'Accept float' }).click();
  await expect(teller.getByRole('tab', { name: 'Deposit' })).toBeVisible();

  await findAccountAtDesk(teller, savings.number);
  await teller.getByLabel('Amount').fill('25,000');
  await teller.getByLabel(/^Note/).fill('Salary credit');
  await teller.getByRole('button', { name: 'Review deposit' }).click();
  await shot(teller, '14-teller-desk');
  await teller.getByRole('button', { name: 'Confirm deposit' }).click();
  await expect(teller.getByRole('heading', { name: 'Deposit completed' })).toBeVisible();
});

test('the customer sees the money and moves some between their own accounts', async () => {
  const page = pages.customer!;
  await page.goto('/dashboard');
  await expect(page.getByText('₹25,000.00').first()).toBeVisible();
  await page.goto('/transfer');
  await page.getByLabel('From').selectOption(savings.id);
  // The radio is visually hidden inside its segmented-control label: click the label, as people do
  await page.locator('label').filter({ hasText: 'My accounts' }).click();
  await expect(page.getByRole('radio', { name: 'My accounts' })).toBeChecked();
  await page.getByLabel('To account').selectOption(current.id);
  await page.getByLabel('Amount').fill('2,500');
  await page.getByLabel(/note/i).fill('Monthly budget');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Review your transfer' })).toBeVisible();
  await shot(page, '08-transfer-review');
  await page.getByRole('button', { name: 'Send ₹2,500.00' }).click();
  await expect(page.getByRole('heading', { name: 'Money sent' })).toBeVisible();
  await shot(page, '09-transfer-receipt');
});

test('payees: an unusable account number gets the same answer as an unknown one', async () => {
  const page = pages.customer!;
  await page.goto('/payees');
  await page.getByRole('button', { name: 'Add payee' }).first().click();
  const dialog = dialogOf(page);
  await dialog.getByLabel('Account number').fill('2999 9999 9990');
  await dialog.getByLabel('Nickname').fill('Landlord');
  await dialog.getByRole('button', { name: 'Add payee' }).click();
  await expect(dialog.getByText(/can’t be added/i)).toBeVisible();
  await shot(page, '10a-add-payee');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await shot(page, '10-payees');
});

test('cash withdrawal with a one-time code from the customer', async () => {
  const page = pages.customer!;
  await page.goto('/cash-withdrawal');
  await page.getByLabel('Account', { exact: true }).selectOption(savings.id);
  await page.getByLabel('Amount').fill('1,000');
  await page.getByRole('button', { name: 'Create code' }).click();
  const card = page.getByRole('region', { name: 'Your withdrawal code' });
  const codeLocator = card.getByText(/^\d{4} \d{4}$/);
  const code = ((await codeLocator.textContent()) ?? '').replace(/\s/g, '');
  expect(code).toMatch(/^\d{8}$/);
  await shot(page, '11-cash-withdrawal-code', { mask: [codeLocator, card.getByText(/your code is/i)] });

  const teller = pages.teller!;
  await teller.goto('/teller');
  await teller.getByRole('tab', { name: 'Withdrawal' }).click();
  await findAccountAtDesk(teller, savings.number);
  await teller.getByLabel('Amount').fill('1,000');
  await teller.getByLabel(/withdrawal code/i).fill(code);
  await teller.getByRole('button', { name: 'Review withdrawal' }).click();
  await teller.getByRole('button', { name: 'Confirm withdrawal' }).click();
  await expect(teller.getByRole('heading', { name: 'Withdrawal completed' })).toBeVisible();
});

test('a large deposit needs a supervisor, and the fraud analyst triages the alert it raises', async () => {
  test.setTimeout(240_000);
  const teller = pages.teller!;
  await teller.goto('/teller');
  await findAccountAtDesk(teller, savings.number);
  await teller.getByLabel('Amount').fill('2,50,000');
  await teller.getByRole('button', { name: 'Review deposit' }).click();
  await teller.getByRole('button', { name: 'Confirm deposit' }).click();
  await expect(teller.getByRole('heading', { name: 'Sent to a supervisor for approval' })).toBeVisible();

  const lead = pages.lead!;
  await lead.goto('/cash-operations');
  await expect(lead.getByRole('button', { name: 'Approve deposit' }).first()).toBeVisible();
  await shot(lead, '16-cash-approvals');
  await lead.getByRole('button', { name: 'Approve deposit' }).first().click();
  await dialogOf(lead).getByRole('button', { name: 'Approve deposit' }).click();
  await expect(lead.getByText('Deposit approved').first()).toBeVisible();

  const analyst = pages.fraud!;
  await expect(async () => {
    await analyst.goto('/fraud');
    await expect(analyst.getByText(/threshold|high-value|2,50,000/i).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000, intervals: [3_000] });
  await shot(analyst, '19-fraud-alerts');
  await analyst.getByText(/threshold|high-value|2,50,000/i).first().click();
  await expect(analyst.getByRole('region', { name: 'Alert details' })).toBeVisible();
  await analyst.getByRole('button', { name: 'Start review' }).click();
  await expect(analyst.getByText(/under review/i).first()).toBeVisible();
  await shot(analyst, '20-fraud-alert-detail');
});

test('blind close-out: the teller declares, the supervisor counts independently and signs off', async () => {
  const teller = pages.teller!;
  await teller.goto('/teller');
  // 50,000 float + 25,000 + 2,50,000 deposits - 1,000 withdrawal
  await teller.getByLabel('Cash in drawer').fill('3,24,000');
  await teller.getByRole('button', { name: 'Close session' }).click();
  await dialogOf(teller).getByRole('button', { name: 'Declare and close' }).click();
  await expect(teller.getByRole('heading', { name: 'Waiting for supervisor sign-off' })).toBeVisible();

  const lead = pages.lead!;
  await lead.goto('/teller-sessions');
  await lead.getByRole('tab', { name: 'Awaiting sign-off' }).click();
  await lead.getByRole('button', { name: /count and sign off/i }).first().click();
  const dialog = dialogOf(lead);
  await expect(dialog.getByText(/3,24,000/)).toHaveCount(0);
  await dialog.getByLabel('Cash counted').fill('3,24,000');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByRole('button', { name: 'Sign off' }).click();
  await expect(dialog).toHaveCount(0);
  await lead.getByRole('tab', { name: /reconciled/i }).click();
  await expect(lead.getByText(STAFF[0].email).first()).toBeVisible();
  await shot(lead, '15-teller-sessions');
  await teller.goto('/teller');
  await expect(teller.getByText(/day closed and signed off/i)).toBeVisible();
});

test('security: a mistyped password keeps the session; authenticator setup; reload restores the session', async () => {
  test.setTimeout(180_000);
  const page = pages.customer!;
  await page.goto('/settings/security');
  const passwordCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Password' }) });
  await passwordCard.getByLabel('Current password').fill('Not-my-password-1');
  await passwordCard.getByLabel('New password', { exact: true }).fill('Another-Strong-Pass-9');
  await passwordCard.getByLabel('Confirm new password', { exact: true }).fill('Another-Strong-Pass-9');
  await passwordCard.getByRole('button', { name: 'Update password' }).click();
  await expect(passwordCard.getByText('The current password is incorrect')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/security$/);

  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  const secret = await enrolAuthenticator(page);
  rememberSecret(customer.email, secret);
  await expect(page.getByText('Authenticator app is on')).toBeVisible();
  await shot(page, '13-security');

  // The access token lives only in memory; a reload restores the session from the HttpOnly cookie
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();

  await signOut(page);
  await signIn(page, customer.email, PASSWORD, secret);
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('platform: add money through the test checkout, ask Sphere, review sessions, and the operations consoles', async () => {
  test.setTimeout(180_000);
  const page = pages.customer!;

  // Add money: Razorpay in simulator mode, so the checkout is the built-in test sheet
  await page.goto('/add-money');
  await expect(page.getByRole('heading', { name: 'Add money', level: 1 })).toBeVisible();
  await page.getByLabel('Amount', { exact: true }).fill('500');
  await shot(page, '23a-add-money');
  await page.getByRole('button', { name: 'Continue' }).click();
  const checkout = page.getByRole('dialog', { name: 'Test checkout' });
  await expect(checkout.getByText('Simulated payment — no real money moves')).toBeVisible();
  await shot(page, '23b-add-money-checkout');
  await checkout.getByRole('button', { name: 'Pay ₹500.00' }).click();
  await expect(page.getByRole('heading', { name: 'Money added' })).toBeVisible({ timeout: 30_000 });
  await shot(page, '23-add-money-receipt');

  // Sphere answers from the customer's own data (built-in engine when no LLM key is configured)
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Ask Sphere' }).click();
  const sphere = page.getByRole('dialog', { name: 'Sphere' });
  await sphere.getByLabel('Message Sphere').fill('What are my account balances?');
  await page.keyboard.press('Enter');
  const conversation = sphere.getByRole('list', { name: 'Conversation' });
  await expect(conversation).toContainText('What are my account balances?');
  await expect(sphere.getByRole('button', { name: 'Stop answering' })).toBeHidden({ timeout: 45_000 });
  await expect(conversation).toContainText(/Savings|Current/);
  await shot(page, '24-sphere', { fullPage: false });
  await page.keyboard.press('Escape');
  await expect(sphere).toBeHidden();

  // Sessions and devices: this browser is listed and marked as the current device
  await page.goto('/settings/security');
  const sessions = page.getByRole('list', { name: 'Signed-in devices' });
  await expect(sessions.getByText('This device')).toBeVisible();
  await page.getByRole('heading', { name: 'Sessions and devices' }).scrollIntoViewIfNeeded();
  await shot(page, '25-sessions', { fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/add-money');
  await expect(page.getByLabel('Amount', { exact: true })).toBeVisible();
  await shot(page, '23-add-money-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Payments console: the top-up above, newest first, with its status history
  const lead = pages.lead!;
  await lead.goto('/payments');
  await expect(lead.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  const row = lead.getByRole('button', { name: /^Open top-up: ₹500\.00/ }).first();
  await expect(row).toBeVisible();
  await shot(lead, '26-payments-console');
  await row.click();
  await expect(dialogOf(lead)).toBeVisible();
  await shot(lead, '26a-top-up-detail');
  await lead.keyboard.press('Escape');

  // Security centre: gateway IP rules, automatic bans and sign-in activity across the bank
  await lead.goto('/security-centre');
  await expect(lead.getByRole('heading', { name: 'Security centre', level: 1 })).toBeVisible();
  await shot(lead, '27-security-centre');
  await lead.getByRole('tab', { name: 'Security events' }).click();
  await expect(lead.getByRole('tab', { name: 'Security events' })).toHaveAttribute('aria-selected', 'true');
  await shot(lead, '27a-security-events');
});

test('documentation screenshots: dashboards, statements, staff consoles, dark mode and mobile', async () => {
  test.setTimeout(240_000);
  const customerPage = pages.customer!;
  await customerPage.goto('/dashboard');
  await expect(customerPage.getByRole('region', { name: 'Recent activity' })).toBeVisible();
  await shot(customerPage, '06-customer-dashboard');
  await darkShot(customerPage, '06-customer-dashboard-dark');
  await customerPage.goto(`/accounts/${savings.id}`);
  await expect(customerPage.getByText('Salary credit').first()).toBeVisible();
  await shot(customerPage, '07-account-statement');
  await customerPage.goto('/profile');
  await shot(customerPage, '12-profile-kyc-verified');
  await customerPage.goto('/accounts');
  await shot(customerPage, '06c-accounts');

  // Phones are first-class: the same customer on a 390 px screen, with the tab bar
  await customerPage.setViewportSize({ width: 390, height: 844 });
  await customerPage.goto('/dashboard');
  await expect(customerPage.getByRole('region', { name: 'Recent activity' })).toBeVisible();
  await shot(customerPage, '06-customer-dashboard-mobile');
  await darkShot(customerPage, '06-customer-dashboard-mobile-dark');
  await customerPage.goto('/accounts');
  await shot(customerPage, '06c-accounts-mobile');
  await customerPage.goto(`/accounts/${savings.id}`);
  await expect(customerPage.getByText('Salary credit').first()).toBeVisible();
  await shot(customerPage, '07-account-statement-mobile');
  await customerPage.goto('/transfer');
  await shot(customerPage, '08-transfer-mobile');
  await customerPage.goto('/payees');
  await shot(customerPage, '10-payees-mobile');
  await customerPage.goto('/settings/security');
  await shot(customerPage, '13-security-mobile');
  await customerPage.setViewportSize({ width: 1440, height: 900 });

  const lead = pages.lead!;
  await lead.goto('/overview');
  await expect(lead.getByRole('region', { name: 'Needs your attention' })).toBeVisible();
  await shot(lead, '04-admin-overview');
  await darkShot(lead, '04-admin-overview-dark');
  await lead.goto('/directory');
  await expect(lead.getByText(STAFF[0].email).first()).toBeVisible();
  await shot(lead, '21-directory');
  await lead.goto('/notifications');
  await shot(lead, '22-notifications');
  await lead.setViewportSize({ width: 390, height: 844 });
  await lead.goto('/overview');
  await expect(lead.getByRole('region', { name: 'Needs your attention' })).toBeVisible();
  await shot(lead, '04-admin-overview-mobile');
  await lead.setViewportSize({ width: 1440, height: 900 });

  const analyst = pages.fraud!;
  await analyst.setViewportSize({ width: 390, height: 844 });
  await analyst.goto('/fraud');
  await expect(analyst.getByText(/threshold|high-value|2,50,000/i).first()).toBeVisible();
  await shot(analyst, '19-fraud-alerts-mobile');
  await analyst.setViewportSize({ width: 1440, height: 900 });

  const kyc = pages.kyc!;
  await kyc.setViewportSize({ width: 390, height: 844 });
  await kyc.goto('/kyc');
  await shot(kyc, '17-kyc-queue-mobile');
  await kyc.setViewportSize({ width: 1440, height: 900 });

  const teller = pages.teller!;
  await teller.goto('/teller/operations');
  await shot(teller, '14b-teller-operations');
  await teller.setViewportSize({ width: 390, height: 844 });
  await teller.goto('/teller');
  await shot(teller, '14c-teller-desk-mobile');
});
