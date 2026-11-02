import { loadPolicy } from '../src/config';
import { buildArticles } from '../src/knowledge/articles';
import { CONFIDENT_SCORE, searchHelp } from '../src/knowledge/search';

const articles = buildArticles(loadPolicy({}));
const top = (query: string, audience: 'customer' | 'staff' = 'customer') => searchHelp(articles, query, audience)[0];

describe('help knowledge base', () => {
  it('covers every required topic, for customers and staff', () => {
    const ids = articles.map((a) => a.id);
    for (const id of ['add-money', 'transfers', 'step-up', 'withdrawal-codes', 'limits', 'freeze', 'kyc', 'sessions', 'security-tips', 'support']) {
      expect(ids).toContain(id);
    }
    for (const id of ['teller-day-close', 'kyc-review', 'fraud-triage', 'four-eyes', 'refunds']) {
      expect(articles.find((a) => a.id === id)?.audience).toBe('staff');
    }
    for (const article of articles) {
      expect(article.steps.length).toBeGreaterThan(0);
      expect(article.keywords.every((k) => k === k.toLowerCase())).toBe(true);
    }
  });

  it('quotes the limits the ledger enforces, from the same settings', () => {
    const custom = buildArticles(loadPolicy({ BENEFICIARY_COOLING_MINUTES: '30', NEW_BENEFICIARY_LIMIT_PAISE: '2500000' }));
    const transfers = custom.find((a) => a.id === 'transfers')!.steps.join(' ');
    expect(transfers).toContain('30-minute cooling-off');
    expect(transfers).toContain('₹25,000');
    expect(articles.find((a) => a.id === 'limits')!.steps.join(' ')).toContain('₹5,00,000 a day');
  });
});

describe('searchHelp', () => {
  it.each([
    ['How do I add money?', 'add-money'],
    ['top up with UPI', 'add-money'],
    ['why is my new payee not active, cooling off?', 'transfers'],
    ['set up authenticator for step-up', 'step-up'],
    ['withdrawal codes at the branch', 'withdrawal-codes'],
    ['what is the daily limit', 'limits'],
    ['my phone was stolen, freeze account', 'freeze'],
    ['kyc pending', 'kyc'],
    ['sign out other devices', 'sessions'],
    ['is this a scam? phishing', 'security-tips'],
    ['contact customer care', 'support'],
    ['account freeze kaise kare', 'freeze'],
    ['paise kaise bheje', 'transfers'],
  ])('customer: "%s" -> %s', (query, id) => {
    const match = top(query);
    expect(match?.article.id).toBe(id);
    expect(match!.score).toBeGreaterThanOrEqual(CONFIDENT_SCORE);
  });

  it.each([
    ['how do I close my teller day', 'teller-day-close'],
    ['how to review a kyc application', 'kyc-review'],
    ['triage a fraud alert', 'fraud-triage'],
    ['four-eyes approval for cash operations', 'four-eyes'],
    ['refund a top-up', 'refunds'],
    ['set up authenticator', 'step-up'],
  ])('staff: "%s" -> %s', (query, id) => {
    expect(top(query, 'staff')?.article.id).toBe(id);
  });

  it('never returns staff procedures to customers', () => {
    for (const query of ['teller day close cash count', 'fraud alert triage', 'four-eyes approval', 'refund a top-up', 'kyc review queue']) {
      for (const match of searchHelp(articles, query, 'customer', 10)) expect(match.article.audience).not.toBe('staff');
    }
  });

  it('is deterministic and returns nothing for unrelated text', () => {
    expect(searchHelp(articles, 'add money', 'customer')).toEqual(searchHelp(articles, 'add money', 'customer'));
    expect(searchHelp(articles, 'zebra quantum', 'customer')).toEqual([]);
    expect(searchHelp(articles, '???', 'customer')).toEqual([]);
  });
});
