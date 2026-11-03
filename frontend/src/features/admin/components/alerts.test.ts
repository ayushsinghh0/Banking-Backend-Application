import { describe, expect, it } from 'vitest';
import { describeAlertReason, severityTone } from './alerts';

describe('describeAlertReason', () => {
  it('reads the direction prefix as a label and humanises an amount over the limit', () => {
    expect(describeAlertReason('[INBOUND] Transaction amount ₹6,00,000.00 exceeds threshold limit of ₹2,00,000.00')).toEqual({
      direction: 'Incoming',
      title: 'Large amount',
      reasons: ['₹6,00,000.00 is over the ₹2,00,000.00 limit'],
    });
  });

  it('splits several reasons and names both signals in the title', () => {
    expect(
      describeAlertReason(
        '[INBOUND] Transaction amount ₹2,50,000.00 exceeds threshold limit of ₹2,00,000.00 | Excessive transaction frequency: 4 transactions recorded within 60s'
      )
    ).toEqual({
      direction: 'Incoming',
      title: 'Large amount and rapid transactions',
      reasons: ['₹2,50,000.00 is over the ₹2,00,000.00 limit', '4 transactions within 1 minute'],
    });
  });

  it('describes transaction bursts in minutes or seconds', () => {
    expect(describeAlertReason('[OUTBOUND] Excessive transaction frequency: 5 transactions recorded within 60s')).toEqual({
      direction: 'Outgoing',
      title: 'Rapid transactions',
      reasons: ['5 transactions within 1 minute'],
    });
    expect(describeAlertReason('Excessive transaction frequency: 3 transactions recorded within 45s').reasons).toEqual([
      '3 transactions within 45 seconds',
    ]);
    expect(describeAlertReason('Excessive transaction frequency: 3 transactions recorded within 300s').reasons).toEqual([
      '3 transactions within 5 minutes',
    ]);
  });

  it('recognises cash structuring, turning paise into rupees', () => {
    const near = describeAlertReason('[INBOUND] 4 cash operations just below the approval limit by the same initiator within 24h');
    expect(near.title).toBe('Possible structuring');
    expect(near.reasons).toEqual(['4 cash operations just under the approval limit by one teller in 24 hours']);

    expect(
      describeAlertReason('3 cash operations by the same initiator on one account total 24000000 paise within 24h, above the single-approval limit')
        .reasons
    ).toEqual(['3 cash operations by one teller on this account, ₹2,40,000.00 in 24 hours, above the single-approval limit']);

    expect(describeAlertReason('3 cash operations just below the approval limit on one account within 24h').reasons).toEqual([
      '3 cash operations just under the approval limit on this account in 24 hours',
    ]);

    expect(
      describeAlertReason('5 cash operations on one account total 31000000 paise within 24h, above the single-approval limit').reasons
    ).toEqual(['5 cash operations on this account, ₹3,10,000.00 in 24 hours, above the single-approval limit']);
  });

  it('keeps the same title once when two reasons share it', () => {
    const both = describeAlertReason(
      '3 cash operations just below the approval limit on one account within 24h | 5 cash operations on one account total 31000000 paise within 24h, above the single-approval limit'
    );
    expect(both.title).toBe('Possible structuring');
    expect(both.reasons).toHaveLength(2);
  });

  it('summarises three or more signals', () => {
    const many = describeAlertReason(
      'Transaction amount ₹6,00,000.00 exceeds threshold limit of ₹2,00,000.00 | Excessive transaction frequency: 4 transactions recorded within 60s | 3 cash operations just below the approval limit on one account within 24h'
    );
    expect(many.title).toBe('Large amount and 2 other signals');
    expect(many.reasons).toHaveLength(3);
  });

  it('falls back to the service’s own words for anything it does not recognise', () => {
    expect(describeAlertReason('[OUTBOUND] Multiple risk anomalies detected')).toEqual({
      direction: 'Outgoing',
      title: 'Several risk signals',
      reasons: [],
    });
    expect(describeAlertReason('Amount ₹2,50,000.00 exceeds the high-value threshold')).toEqual({
      direction: null,
      title: 'Amount ₹2,50,000.00 exceeds the high-value threshold',
      reasons: [],
    });
    expect(describeAlertReason('new rule fired | Excessive transaction frequency: 4 transactions recorded within 60s')).toEqual({
      direction: null,
      title: 'New rule fired and rapid transactions',
      reasons: ['New rule fired', '4 transactions within 1 minute'],
    });
    expect(describeAlertReason('   ')).toEqual({ direction: null, title: 'Unusual activity', reasons: [] });
  });
});

describe('severityTone', () => {
  it('keeps red for critical risk only', () => {
    expect(severityTone('CRITICAL')).toBe('danger');
    expect(severityTone('HIGH')).toBe('warning');
    expect(severityTone('MEDIUM')).toBe('neutral');
    expect(severityTone('LOW')).toBe('neutral');
  });
});
