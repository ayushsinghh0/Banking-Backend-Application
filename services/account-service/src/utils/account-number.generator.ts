import crypto from 'crypto';

/**
 * Generates an authoritative 12-digit bank account number with Luhn algorithm checksum validation.
 * Structure: [4-digit Bank Branch Identifier] + [7-digit Random Sequence] + [1-digit Checksum]
 */
export class AccountNumberGenerator {
  private static readonly BRANCH_PREFIX = '1001';

  /**
   * Generates a 12-digit valid bank account number
   */
  public static generate(): string {
    const sequence = crypto.randomInt(1000000, 10000000).toString(); // 7 digits, CSPRNG so numbers aren't predictable
    const payload = `${this.BRANCH_PREFIX}${sequence}`;
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
