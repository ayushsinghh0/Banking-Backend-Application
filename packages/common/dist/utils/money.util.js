"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MoneyUtil = void 0;
/**
 * Money utilities enforcing integer minor units (Paise) to eliminate floating-point arithmetic errors.
 * 1 Rupee = 100 Paise.
 */
class MoneyUtil {
    /**
     * Converts a Rupee decimal string (e.g. "125.50") into BigInt paise (12550n)
     */
    static rupeesToPaise(rupees) {
        const str = typeof rupees === 'number' ? rupees.toFixed(2) : rupees.trim();
        const parts = str.split('.');
        const whole = parts[0] || '0';
        let fraction = parts[1] || '00';
        if (fraction.length === 1) {
            fraction += '0';
        }
        else if (fraction.length > 2) {
            fraction = fraction.substring(0, 2);
        }
        const totalPaiseStr = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
        return BigInt(totalPaiseStr || '0');
    }
    /**
     * Converts BigInt paise (e.g. 12550n) into human-readable Rupee string ("125.50")
     */
    static paiseToRupees(paise) {
        const str = paise.toString().padStart(3, '0');
        const whole = str.slice(0, -2) || '0';
        const fraction = str.slice(-2);
        return `${whole}.${fraction}`;
    }
    /**
     * Formats paise into Indian Rupee locale currency: "₹1,25,000.50"
     */
    static formatINR(paise) {
        const rupees = Number(this.paiseToRupees(paise));
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
        }).format(rupees);
    }
}
exports.MoneyUtil = MoneyUtil;
//# sourceMappingURL=money.util.js.map