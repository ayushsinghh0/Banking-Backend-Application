import { describe, expect, it } from 'vitest';
import {
  describeAlertReason,
  describeValue,
  detailEntries,
  formatListTime,
  humanizeKey,
  kycActionLabel,
  maskPhone,
  shortId,
  splitReason,
  waitingTime,
} from './format';

describe('staff formatting', () => {
  it('shortens identifiers', () => {
    expect(shortId('11111111-1111-4111-8111-111111111111')).toBe('11111111');
    expect(shortId(null)).toBe('—');
  });

  it('masks phone numbers down to the last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91 ••••• 3210');
    expect(maskPhone('98765 43210')).toBe('••••• 3210');
    expect(maskPhone('123')).toBe('123');
  });

  it('escalates the waiting time after one and three days', () => {
    const now = Date.parse('2026-10-27T09:30:00.000Z');
    expect(waitingTime('2026-10-27T09:29:50.000Z', now)).toEqual({ label: 'Just now', tone: 'neutral' });
    expect(waitingTime('2026-10-27T05:30:00.000Z', now)).toEqual({ label: '4 hours', tone: 'neutral' });
    expect(waitingTime('2026-10-25T09:30:00.000Z', now)).toEqual({ label: '2 days', tone: 'warning' });
    expect(waitingTime('2026-10-20T09:30:00.000Z', now)).toEqual({ label: '7 days', tone: 'danger' });
  });

  it('turns audit details into readable text without interpreting it', () => {
    expect(humanizeKey('reviewedVersion')).toBe('Reviewed version');
    expect(humanizeKey('date_of_birth')).toBe('Date of birth');
    expect(describeValue({ from: 'Asha', to: 'Asha Rao' })).toBe('Asha → Asha Rao');
    expect(describeValue({ from: null, to: '12 MG Road' })).toBe('— → 12 MG Road');
    expect(describeValue(3)).toBe('3');
    expect(describeValue(['a', 1])).toBe('["a",1]');
    expect(describeValue('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    expect(describeValue('x'.repeat(600))).toHaveLength(501);
    expect(detailEntries({ reviewedVersion: 2 })).toEqual([{ key: 'reviewedVersion', label: 'Reviewed version', value: '2' }]);
    expect(detailEntries(null)).toEqual([]);
  });

  it('labels KYC actions and fraud reasons', () => {
    expect(kycActionLabel('KYC_DECISION')).toBe('KYC decision');
    expect(kycActionLabel('SOMETHING_NEW')).toBe('Something new');
    expect(splitReason('[OUTBOUND] Amount too high')).toEqual({ direction: 'Outgoing', text: 'Amount too high' });
    expect(splitReason('[INBOUND] Velocity')).toEqual({ direction: 'Incoming', text: 'Velocity' });
    expect(splitReason('Plain reason')).toEqual({ direction: null, text: 'Plain reason' });
  });

  describe('describeAlertReason', () => {
    it('names a threshold alert and pulls out the transaction amount', () => {
      expect(describeAlertReason('[INBOUND] Transaction amount ₹2,50,000.00 exceeds threshold limit of ₹2,00,000.00')).toEqual({
        direction: 'Incoming',
        headline: 'Large transaction',
        known: true,
        amount: '₹2,50,000.00',
        reasons: [
          {
            title: 'Large transaction',
            detail: '₹2,50,000.00, over the ₹2,00,000.00 threshold',
            text: 'Transaction amount ₹2,50,000.00 exceeds threshold limit of ₹2,00,000.00',
          },
        ],
      });
    });

    it('turns a velocity window into words', () => {
      const one = describeAlertReason('[OUTBOUND] Excessive transaction frequency: 4 transactions recorded within 60s');
      expect(one.direction).toBe('Outgoing');
      expect(one.amount).toBeNull();
      expect(one.reasons[0]).toMatchObject({ title: 'Rapid transactions', detail: '4 transactions in 1 minute' });
      expect(describeAlertReason('Excessive transaction frequency: 3 transactions recorded within 300s').reasons[0]!.detail).toBe(
        '3 transactions in 5 minutes'
      );
      expect(describeAlertReason('Excessive transaction frequency: 3 transactions recorded within 45s').reasons[0]!.detail).toBe(
        '3 transactions in 45 seconds'
      );
      expect(describeAlertReason('Excessive transaction frequency: 9 transactions recorded within 3600s').reasons[0]!.detail).toBe(
        '9 transactions in 1 hour'
      );
    });

    it('splits several reasons into separate lines and names the alert after them', () => {
      const described = describeAlertReason(
        '[INBOUND] Transaction amount ₹2,50,000.00 exceeds threshold limit of ₹2,00,000.00 | Excessive transaction frequency: 6 transactions recorded within 60s'
      );
      expect(described.headline).toBe('Large transaction and rapid transactions');
      expect(described.reasons.map((r) => r.detail)).toEqual(['₹2,50,000.00, over the ₹2,00,000.00 threshold', '6 transactions in 1 minute']);
      expect(described.amount).toBe('₹2,50,000.00');
      expect(described.known).toBe(true);
    });

    it('explains cash structuring in plain words, with paise as rupees', () => {
      expect(
        describeAlertReason('[INBOUND] 3 cash operations just below the approval limit by the same initiator within 24h').reasons[0]
      ).toMatchObject({ title: 'Cash structuring', detail: '3 cash operations just below the approval limit by the same staff member in 24 hours' });
      expect(describeAlertReason('3 cash operations just below the approval limit on one account within 24h').reasons[0]).toMatchObject({
        title: 'Cash structuring',
        detail: '3 cash operations just below the approval limit on this account in 24 hours',
      });
      expect(
        describeAlertReason(
          '2 cash operations by the same initiator on one account total 24000000 paise within 24h, above the single-approval limit'
        ).reasons[0]
      ).toMatchObject({
        title: 'Split cash operations',
        detail: '2 cash operations by the same staff member totalling ₹2,40,000.00 in 24 hours, above the single-approval limit',
      });
      expect(
        describeAlertReason('4 cash operations on one account total 30000000 paise within 24h, above the single-approval limit').reasons[0]
      ).toMatchObject({
        title: 'Split cash operations',
        detail: '4 cash operations on this account totalling ₹3,00,000.00 in 24 hours, above the single-approval limit',
      });
    });

    it('names three or more signals by the first and a count', () => {
      const described = describeAlertReason(
        'Transaction amount ₹5,00,000.00 exceeds threshold limit of ₹2,00,000.00 | Excessive transaction frequency: 4 transactions recorded within 60s | 3 cash operations just below the approval limit on one account within 24h'
      );
      expect(described.headline).toBe('Large transaction and 2 other signals');
    });

    it('keeps text it does not recognise, untouched and unnamed', () => {
      expect(describeAlertReason('[OUTBOUND] Amount ₹2,50,000.00 exceeds the high-value threshold')).toEqual({
        direction: 'Outgoing',
        headline: 'Amount ₹2,50,000.00 exceeds the high-value threshold',
        known: false,
        amount: null,
        reasons: [
          {
            title: 'Amount ₹2,50,000.00 exceeds the high-value threshold',
            detail: null,
            text: 'Amount ₹2,50,000.00 exceeds the high-value threshold',
          },
        ],
      });
      expect(describeAlertReason('Multiple risk anomalies detected')).toMatchObject({ headline: 'Several risk signals', known: true });
      expect(describeAlertReason('')).toMatchObject({ headline: 'Risk alert', known: false, reasons: [] });
    });
  });

  describe('formatListTime', () => {
    // 27 Oct 2026, 15:00 in India
    const now = new Date('2026-10-27T09:30:00.000Z').getTime();

    it('shows the time for today, "Yesterday" for yesterday, the date otherwise', () => {
      expect(formatListTime('2026-10-27T03:14:00.000Z', now, 'Asia/Kolkata')).toBe('8:44 am');
      expect(formatListTime('2026-10-26T15:40:00.000Z', now, 'Asia/Kolkata')).toBe('Yesterday, 9:10 pm');
      expect(formatListTime('2026-10-20T09:30:00.000Z', now, 'Asia/Kolkata')).toBe('20 Oct');
      expect(formatListTime('2025-12-31T09:30:00.000Z', now, 'Asia/Kolkata')).toBe('31 Dec 2025');
    });

    it('copes with a missing or broken timestamp', () => {
      expect(formatListTime(null, now)).toBe('—');
      expect(formatListTime('not a date', now)).toBe('—');
    });
  });
});
