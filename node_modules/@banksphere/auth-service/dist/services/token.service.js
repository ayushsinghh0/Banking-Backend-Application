"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const common_1 = require("@banksphere/common");
class TokenService {
    accessSecret;
    accessExpiration;
    constructor() {
        this.accessSecret =
            process.env.JWT_ACCESS_SECRET || 'banksphere_super_secret_access_jwt_key_2026_x99!';
        this.accessExpiration = process.env.JWT_ACCESS_EXPIRATION || '15m';
    }
    /**
     * Generates a signed JWT access token containing identity claims
     */
    generateAccessToken(payload) {
        return jsonwebtoken_1.default.sign(payload, this.accessSecret, {
            expiresIn: this.accessExpiration,
        });
    }
    /**
     * Generates a cryptographically random refresh token
     */
    generateRawRefreshToken() {
        return crypto_1.default.randomBytes(40).toString('hex');
    }
    /**
     * Hashes a raw refresh token using SHA-256 for secure database storage
     */
    hashRefreshToken(token) {
        return crypto_1.default.createHash('sha256').update(token).digest('hex');
    }
    /**
     * Verifies and decodes an access token
     */
    verifyAccessToken(token) {
        try {
            return jsonwebtoken_1.default.verify(token, this.accessSecret);
        }
        catch {
            throw new common_1.UnauthorizedError('Invalid or expired access token');
        }
    }
}
exports.TokenService = TokenService;
