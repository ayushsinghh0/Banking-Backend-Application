import { TransferPolicyConfig } from '../config';
import { formatInr } from '../util/money';

/**
 * Sphere's help knowledge base. It lives in code so it is reviewed like code, and the numbers in it come from the
 * same settings the ledger enforces, so an answer can’t quote a limit the bank no longer uses. Customer articles
 * describe the app; staff articles describe internal procedures and are only ever searched for staff.
 */
export type Audience = 'customer' | 'staff' | 'all';

export interface HelpArticle {
  id: string;
  audience: Audience;
  title: string;
  /** Words and phrases people use for this topic, English and Hinglish (lower case) */
  keywords: string[];
  steps: string[];
}

export function buildArticles(policy: TransferPolicyConfig): HelpArticle[] {
  const inr = (paise: bigint) => formatInr(paise).replace(/\.00$/, '');
  const factorWait =
    policy.mfaFactorMinAgeHours > 0
      ? `A newly set-up authenticator counts for these checks after ${policy.mfaFactorMinAgeHours} hours, in case someone else learned your password.`
      : 'A newly set-up authenticator can be used for these checks straight away.';

  return [
    {
      id: 'add-money',
      audience: 'customer',
      title: 'Add money with Razorpay',
      keywords: ['add money', 'top up', 'top-up', 'topup', 'razorpay', 'upi', 'card', 'net banking', 'netbanking', 'load money', 'recharge', 'paise add', 'paisa add', 'paise dalna', 'deposit online', 'fund'],
      steps: [
        'Open Add money from the dashboard or from an account, and choose the account to credit.',
        'Enter the amount. The screen shows the minimum, the maximum and how much of today’s top-up limit is left.',
        'Pay in Razorpay Checkout with UPI, a card or net banking. Your KYC must be verified to add money.',
        'The money is credited as soon as Razorpay confirms the payment, and the page updates by itself.',
        'If you were charged but the top-up still shows pending, give it a few minutes: we check with Razorpay automatically and either credit you or the payment is refunded.',
      ],
    },
    {
      id: 'transfers',
      audience: 'customer',
      title: 'Send money and manage payees',
      keywords: ['transfer', 'send money', 'send', 'pay', 'payee', 'payees', 'beneficiary', 'beneficiaries', 'cooling', 'cooling-off', 'cooling off', 'add payee', 'bhejna', 'bhejo', 'paise bhejo', 'paise kaise bheje'],
      steps: [
        'Transfers go between your own accounts or to a saved payee. Open Transfer, pick the account to pay from, the payee and the amount, then review and confirm.',
        'To add a payee, open Payees and enter their 12-digit BankSphere account number and a nickname. We email you whenever a payee is added.',
        policy.beneficiaryCoolingMinutes > 0
          ? `A new payee can be paid after a ${policy.beneficiaryCoolingMinutes}-minute cooling-off period, or straight away if you confirm with your authenticator app.`
          : 'A new payee can be paid straight away.',
        `In a payee’s first 24 hours you can send them up to ${inr(policy.newBeneficiaryLimitPaise)} in total.`,
        `Transfers of ${inr(policy.stepUpThresholdPaise)} or more ask for a code from your authenticator app.`,
        'Sphere can prepare a transfer for you to check, but only you can send it.',
      ],
    },
    {
      id: 'step-up',
      audience: 'all',
      title: 'Authenticator app and step-up checks',
      keywords: ['authenticator', '2fa', 'mfa', 'totp', 'otp', 'step-up', 'step up', 'stepup', 'google authenticator', 'verification code', 'two-factor', 'two factor', 'security code', '6-digit code'],
      steps: [
        'Open Security and set up an authenticator app (for example Google Authenticator or Microsoft Authenticator) by scanning the QR code.',
        'For sensitive actions such as large transfers, paying a new payee straight away or large withdrawal codes, you’ll be asked for the 6-digit code from the app. This is a step-up check.',
        factorWait,
        'Never share authenticator codes with anyone, including BankSphere staff.',
      ],
    },
    {
      id: 'withdrawal-codes',
      audience: 'customer',
      title: 'Cash withdrawal codes',
      keywords: ['withdraw', 'withdrawal', 'withdrawal code', 'cash', 'branch', 'teller', 'atm', 'nikalna', 'cash nikalna', 'paise nikalna'],
      steps: [
        'In the app, create a withdrawal code: choose the account and the amount.',
        'At a branch, give the 8-digit code to the teller. They pay out that amount once.',
        `Codes expire after ${policy.withdrawalCodeTtlMinutes} minutes and work only once. Codes of ${inr(policy.withdrawalCodeStepUpPaise)} or more need your authenticator code.`,
        'Share the code only with the teller serving you.',
      ],
    },
    {
      id: 'limits',
      audience: 'customer',
      title: 'Daily limits',
      keywords: ['limit', 'limits', 'daily limit', 'maximum', 'max', 'how much can i send', 'kitna bhej', 'seema', 'cap'],
      steps: [
        'Each account has its own daily transfer limit. You can lower it any time and raise it up to the limit the bank set.',
        `Across all your accounts you can send up to ${inr(policy.customerDailyOutflowPaise)} a day. Limits reset at midnight India time.`,
        `New payees: up to ${inr(policy.newBeneficiaryLimitPaise)} in their first 24 hours.`,
        'Adding money has its own daily limit, shown on the Add money screen.',
      ],
    },
    {
      id: 'freeze',
      audience: 'customer',
      title: 'Freeze your account',
      keywords: ['freeze', 'frozen', 'block', 'lost', 'stolen', 'suspicious', 'hacked', 'compromised', 'lock', 'unfreeze', 'band karo', 'block karo'],
      steps: [
        'If you suspect fraud, open the account and choose Freeze. Nothing can be sent from a frozen account.',
        'You can freeze an account yourself, instantly. Only the bank can unfreeze it, after checking with you.',
        'Then sign out your other devices under Security, change your password and contact support.',
      ],
    },
    {
      id: 'kyc',
      audience: 'customer',
      title: 'KYC verification',
      keywords: ['kyc', 'verify', 'verification', 'identity', 'documents', 'pan', 'aadhaar', 'aadhar', 'pending', 'rejected', 'profile'],
      steps: [
        'Complete your profile with your name, phone number, address and date of birth. Your KYC then shows as pending.',
        'A KYC officer reviews it, and your profile shows Verified or Rejected.',
        'You need verified KYC to open accounts and to add money.',
        'Changing your identity details sends your KYC back for review.',
      ],
    },
    {
      id: 'sessions',
      audience: 'all',
      title: 'Sessions and devices',
      keywords: ['session', 'sessions', 'device', 'devices', 'logged in', 'signed in', 'sign out', 'log out', 'logout', 'new device', 'login alert', 'sign-in', 'login history'],
      steps: [
        'Security lists every browser and device signed in to your account, with when it was last used and its network.',
        'Sign out any device you don’t recognise, or choose Sign out everywhere else.',
        'We email you when your account is used from a new device.',
        'Recent sign-in activity shows successful and failed sign-ins.',
      ],
    },
    {
      id: 'security-tips',
      audience: 'all',
      title: 'Staying safe',
      keywords: ['safe', 'safety', 'security', 'scam', 'phishing', 'fraud', 'password', 'tips', 'secure', 'suraksha', 'otp share'],
      steps: [
        'BankSphere will never ask for your password, authenticator codes or withdrawal codes, by phone, email or chat.',
        'Turn on an authenticator app and use a password you don’t use anywhere else.',
        'Check the payee and the amount before you confirm a transfer. Be wary of urgency and of requests to send a “test” amount.',
        'Review Sessions and devices now and then, and sign out anything unfamiliar.',
        'If something looks wrong, freeze your account and contact support.',
      ],
    },
    {
      id: 'support',
      audience: 'customer',
      title: 'Contact support',
      keywords: ['support', 'contact', 'help desk', 'helpdesk', 'complaint', 'customer care', 'call', 'email', 'human', 'agent', 'grievance', 'talk to someone'],
      steps: [
        'Reach the support team only through the contact details on the official BankSphere website or app, never through numbers sent to you in messages.',
        'Have the last 4 digits of the account and the date and amount of the transaction ready. Never share passwords or codes.',
        'For suspected fraud, freeze your account first: you can do that yourself, instantly.',
        'Support can check your top-ups and account status. Only a bank administrator can unfreeze an account or refund a top-up.',
      ],
    },
    {
      id: 'teller-day-close',
      audience: 'staff',
      title: 'Teller: closing your day',
      keywords: ['teller', 'close day', 'day close', 'closing', 'end of day', 'eod', 'cash count', 'count', 'drawer', 'float', 'close session', 'sign-off', 'sign off', 'vault', 'suspense'],
      steps: [
        'Resolve your pending cash operations first: a session can’t close while any of them await approval.',
        'Count the cash in your drawer and submit the count to close your session. The count is blind: you are not shown the expected figure. You can correct it by closing again until a supervisor signs off.',
        'A different administrator counts independently and signs the session off. The two counts must agree.',
        'The counted cash returns to the vault in the ledger; any difference is posted to cash suspense and alerted.',
        'Your next session starts when a supervisor issues a new float, which you count and accept.',
      ],
    },
    {
      id: 'kyc-review',
      audience: 'staff',
      title: 'KYC officer: reviewing a customer',
      keywords: ['kyc', 'review', 'kyc review', 'approve', 'reject', 'verify customer', 'queue', 'pending kyc', 'kyc officer'],
      steps: [
        'Open the customer list filtered to pending KYC; the oldest applications come first.',
        'Check the profile details against the customer’s documents. You can never decide your own KYC.',
        'Approve or reject. The decision names the profile version you reviewed: if the customer changed their details meanwhile, you’ll be asked to reload and review again.',
        'Every decision is recorded in the customer’s KYC history with your name.',
      ],
    },
    {
      id: 'fraud-triage',
      audience: 'staff',
      title: 'Fraud analyst: triaging an alert',
      keywords: ['fraud', 'alert', 'alerts', 'triage', 'suspicious', 'investigate', 'fraud queue', 'dismiss', 'resolve', 'under review'],
      steps: [
        'Open the fraud queue (new alerts appear live) and start with the highest severity.',
        'Move the alert to Under review while you investigate the account’s recent transactions and payees.',
        'If money is at risk, ask a bank administrator to freeze the account. Customers can also freeze their own account.',
        'Resolve the alert (confirmed and handled) or dismiss it (false positive) with a note. Every change is kept in the alert’s history.',
      ],
    },
    {
      id: 'four-eyes',
      audience: 'staff',
      title: 'Four-eyes approvals',
      keywords: ['four eyes', 'four-eyes', 'approval', 'approvals', 'approve', 'maker checker', 'maker-checker', 'dual control', 'second approver', 'pending approval', 'cash operation'],
      steps: [
        `Cash operations above ${inr(policy.cashSingleApprovalPaise)}, or once a teller’s single-approval total for the day passes ${inr(policy.tellerDailyLimitPaise)}, wait for a second administrator.`,
        'Approve or reject them under Cash operations. Nobody can approve their own request, and staff never operate on their own accounts.',
        `Requests not decided within ${policy.cashApprovalTtlHours} hours expire.`,
        'An account frozen by one administrator must be unfrozen by a different one, and teller sessions are signed off by someone other than the teller.',
      ],
    },
    {
      id: 'refunds',
      audience: 'staff',
      title: 'Refunding a top-up',
      keywords: ['refund', 'refunds', 'reverse', 'top-up refund', 'topup refund', 'razorpay refund', 'chargeback', 'money back'],
      steps: [
        'Bank administrators only: open the top-up in the payments console, choose Refund and give a reason of 10 to 300 characters.',
        'Confirm with your authenticator code (step-up).',
        'The customer’s account is debited and Razorpay refunds the payment. If Razorpay refuses, the debit is reversed automatically and the top-up returns to Credited.',
        'A top-up that was blocked from crediting (for example a frozen or closed account) is refunded without a debit.',
        'A refund that would overdraw the customer’s account is refused.',
      ],
    },
    {
      id: 'sphere',
      audience: 'all',
      title: 'What Sphere can do',
      keywords: ['sphere', 'assistant', 'what can you do', 'capabilities', 'features', 'help me'],
      steps: [
        'Customers can ask about balances, recent transactions, spending, payees, top-ups and limits, and get step-by-step help.',
        'Sphere can prepare a transfer for you to review, but it can never move money.',
        'Staff can ask about procedures such as day close, KYC review, fraud triage, approvals and refunds.',
        'Answers can be wrong: check important details in the app.',
      ],
    },
  ];
}
