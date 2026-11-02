import { UserRole } from '@banksphere/common';

/** Starter prompts for the signed-in role (GET /meta). Staff prompts are procedures: staff get search_help only. */
export const SUGGESTIONS: Record<UserRole, readonly string[]> = {
  CUSTOMER: [
    'What’s my balance?',
    'Show my last 5 transactions',
    'How much did I spend this month?',
    'Did my last top-up go through?',
    'What are my limits?',
    'Draft a transfer of ₹500',
    'How do I add money?',
  ],
  SUPPORT: [
    'How can a customer freeze their account?',
    'How do top-up refunds work?',
    'How do sessions and devices work?',
    'What scams should customers watch for?',
  ],
  TELLER: ['How do I close my teller day?', 'How do withdrawal codes work?', 'How do four-eyes approvals work?'],
  KYC_OFFICER: ['How do I review a KYC application?', 'How does KYC verification work for customers?', 'How do I set up my authenticator?'],
  FRAUD_ANALYST: ['How do I triage a fraud alert?', 'How can an account be frozen?', 'What scams should customers watch for?'],
  BANK_ADMIN: ['How do four-eyes approvals work?', 'How do I refund a top-up?', 'How do I sign off a teller session?', 'How do I triage a fraud alert?'],
};

export function suggestionsFor(role: UserRole): string[] {
  return [...(SUGGESTIONS[role] ?? SUGGESTIONS.CUSTOMER)];
}
