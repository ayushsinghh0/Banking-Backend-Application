/**
 * Money utilities enforcing integer minor units (Paise) to eliminate floating-point arithmetic errors.
 * 1 Rupee = 100 Paise.
 */
export declare class MoneyUtil {
    /**
     * Converts a Rupee decimal string (e.g. "125.50") into BigInt paise (12550n)
     */
    static rupeesToPaise(rupees: string | number): bigint;
    /**
     * Converts BigInt paise (e.g. 12550n) into human-readable Rupee string ("125.50")
     */
    static paiseToRupees(paise: bigint | string): string;
    /**
     * Formats paise into Indian Rupee locale currency: "₹1,25,000.50"
     */
    static formatINR(paise: bigint | string): string;
}
//# sourceMappingURL=money.util.d.ts.map