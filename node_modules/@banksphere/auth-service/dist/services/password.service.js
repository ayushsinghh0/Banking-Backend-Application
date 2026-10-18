"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PasswordService = void 0;
const argon2_1 = __importDefault(require("argon2"));
class PasswordService {
    /**
     * Hashes a password using Argon2id with recommended OWASP memory and time limits
     */
    static async hash(password) {
        return argon2_1.default.hash(password, {
            type: argon2_1.default.argon2id,
            memoryCost: 2 ** 16, // 64 MB memory
            timeCost: 3, // 3 iterations
            parallelism: 1,
        });
    }
    /**
     * Verifies a plain text password against an Argon2id hash
     */
    static async verify(hash, plain) {
        try {
            return await argon2_1.default.verify(hash, plain);
        }
        catch {
            return false;
        }
    }
}
exports.PasswordService = PasswordService;
