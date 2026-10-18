/**
 * Money utilities enforcing integer minor units (paise) to eliminate floating-point arithmetic errors.
 * 1 Rupee = 100 Paise. All conversions are exact: no Number/float is ever involved.
 */
export class MoneyUtil {
  /**
   * Converts a non-negative Rupee decimal string (e.g. "125.50") into BigInt paise (12550n).
   * Rejects negatives, more than 2 decimal places and anything that isn't a plain decimal.
   */
  public static rupeesToPaise(rupees: string): bigint {
    const str = rupees.trim();
    const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(str);
    if (!match) {
      throw new Error(`Invalid rupee amount '${rupees}': expected digits with at most 2 decimal places`);
    }
    return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  }

  /**
   * Converts BigInt paise (e.g. 12550n) into a Rupee string ("125.50").
   */
  public static paiseToRupees(paise: bigint | string): string {
    const value = BigInt(paise);
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const whole = abs / 100n;
    const fraction = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
  }

  /**
   * Formats paise as Indian Rupees with Indian digit grouping, exactly: "₹1,25,000.50".
   */
  public static formatINR(paise: bigint | string): string {
    const [rupees, fraction] = MoneyUtil.paiseToRupees(paise).split('.');
    const negative = rupees.startsWith('-');
    const digits = negative ? rupees.slice(1) : rupees;
    const lastThree = digits.slice(-3);
    const rest = digits.slice(0, -3);
    const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
    return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
  }
}
