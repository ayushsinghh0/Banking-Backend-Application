import { MailMessage, renderEmail } from '@banksphere/common';

/**
 * Links put the one-time token in the URL fragment (#token=...), which browsers never send to
 * servers, so it can't leak through web-server logs, proxies or the Referer header.
 */
function link(appBaseUrl: string, path: string, token: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}${path}#token=${encodeURIComponent(token)}`;
}

export function verificationEmail(to: string, appBaseUrl: string, token: string, ttlHours: number): MailMessage {
  const body = renderEmail({
    greeting: 'Welcome to BankSphere,',
    paragraphs: [
      'Please confirm your email address to activate your account.',
      `This link expires in ${ttlHours} hours and can only be used once.`,
    ],
    action: { label: 'Verify email address', url: link(appBaseUrl, '/verify-email', token) },
    footer: 'If you did not create a BankSphere account, you can ignore this email.',
  });
  return { to, subject: 'Verify your BankSphere email address', ...body };
}

export function existingAccountEmail(to: string, appBaseUrl: string): MailMessage {
  const body = renderEmail({
    paragraphs: [
      'Someone tried to create a new BankSphere account with this email address, but you already have an account.',
      'If this was you, sign in instead. If you forgot your password, you can reset it from the sign-in page.',
    ],
    action: { label: 'Go to sign in', url: `${appBaseUrl.replace(/\/+$/, '')}/login` },
    footer: 'If this was not you, no action is needed: your account has not been changed.',
  });
  return { to, subject: 'Sign-up attempt with your BankSphere email', ...body };
}

export function passwordResetEmail(to: string, appBaseUrl: string, token: string, ttlMinutes: number): MailMessage {
  const body = renderEmail({
    paragraphs: [
      'We received a request to reset the password for your BankSphere account.',
      `This link expires in ${ttlMinutes} minutes and can only be used once. Resetting your password signs you out of every device.`,
    ],
    action: { label: 'Reset password', url: link(appBaseUrl, '/reset-password', token) },
    footer:
      'If you did not request a password reset, ignore this email: your password will not change. BankSphere will never ask for your password.',
  });
  return { to, subject: 'Reset your BankSphere password', ...body };
}

export function passwordChangedEmail(to: string, when: Date): MailMessage {
  const body = renderEmail({
    paragraphs: [
      `The password for your BankSphere account was changed on ${when.toUTCString()}.`,
      'For your security, you have been signed out of all devices.',
    ],
    footer: 'If you did not make this change, contact BankSphere support immediately to secure your account.',
  });
  return { to, subject: 'Your BankSphere password was changed', ...body };
}
