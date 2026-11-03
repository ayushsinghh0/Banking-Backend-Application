import crypto from 'crypto';

/**
 * Generates an authoritative 12-digit bank account number with Luhn algorithm checksum validation.
 * Structure: [1-digit Bank Prefix] + [10-digit Random Sequence] + [1-digit Checksum]
 *
 * 10 random digits give 10^10 numbers, so collisions stay rare for the life of the bank (the earlier
 * '1001' + 7 digits allowed only 9 million). Numbers issued in that format remain valid: validation is
 * length + Luhn only, and the new prefix '2' can never produce one of them.
 */
export class AccountNumberGenerator {
  private static readonly BANK_PREFIX = '2';
  private static readonly SEQUENCE_SPACE = 10_000_000_000; // 10 digits

  /**
   * Generates a 12-digit valid bank account number
   */
  public static generate(): string {
    // CSPRNG so numbers aren't predictable; zero-padded so every sequence has exactly 10 digits
    const sequence = crypto.randomInt(0, this.SEQUENCE_SPACE).toString().padStart(10, '0');
    const payload = `${this.BANK_PREFIX}${sequence}`;
    const checkDigit = this.calculateLuhnCheckDigit(payload);
    return `${payload}${checkDigit}`;
  }

  /**
   * Validates if an account number has valid length and Luhn checksum
   */
  public static validate(accountNumber: string): boolean {
    if (!/^\d{12}$/.test(accountNumber)) {
      return false;
    }
    const payload = accountNumber.slice(0, 11);
    const checkDigit = parseInt(accountNumber.slice(11), 10);
    return this.calculateLuhnCheckDigit(payload) === checkDigit;
  }

  private static calculateLuhnCheckDigit(digits: string): number {
    let sum = 0;
    let alternate = true;

    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits.charAt(i), 10);
      if (alternate) {
        n *= 2;
        if (n > 9) {
          n -= 9;
        }
      }
      sum += n;
      alternate = !alternate;
    }

    return (10 - (sum % 10)) % 10;
  }
}
