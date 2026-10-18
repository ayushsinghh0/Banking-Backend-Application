"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const client_1 = require("../generated/client");
const common_1 = require("@banksphere/common");
const password_service_1 = require("./password.service");
class AuthService {
    prisma;
    tokenService;
    constructor(prisma, tokenService) {
        this.prisma = prisma;
        this.tokenService = tokenService;
    }
    /**
     * Registers a new user with Argon2id password hash
     */
    async register(dto) {
        const existing = await this.prisma.user.findUnique({
            where: { email: dto.email.toLowerCase() },
        });
        if (existing) {
            throw new common_1.ConflictError(`An account with email '${dto.email}' already exists`);
        }
        const passwordHash = await password_service_1.PasswordService.hash(dto.password);
        const user = await this.prisma.user.create({
            data: {
                email: dto.email.toLowerCase(),
                passwordHash,
                role: dto.role || client_1.Role.CUSTOMER,
            },
        });
        // Issue initial tokens
        const tokens = await this.issueTokenPair(user.id, user.email, user.role);
        return {
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
            },
            tokens,
        };
    }
    /**
     * Authenticates user credentials and starts a new token family
     */
    async login(dto) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email.toLowerCase() },
        });
        if (!user || !user.isActive) {
            throw new common_1.UnauthorizedError('Invalid email or password');
        }
        const isPasswordValid = await password_service_1.PasswordService.verify(user.passwordHash, dto.password);
        if (!isPasswordValid) {
            throw new common_1.UnauthorizedError('Invalid email or password');
        }
        const tokens = await this.issueTokenPair(user.id, user.email, user.role);
        return {
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
            },
            tokens,
        };
    }
    /**
     * Rotates refresh token with REUSE DETECTION to defend against token theft
     */
    async refreshToken(rawRefreshToken) {
        const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
        const record = await this.prisma.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        });
        if (!record) {
            throw new common_1.UnauthorizedError('Invalid refresh token');
        }
        // TOKEN REUSE ATTACK DETECTION:
        // If an already-revoked refresh token is presented again, someone stole it!
        if (record.isRevoked) {
            // Invalidate the entire token family tree to lock out the attacker
            await this.prisma.refreshToken.updateMany({
                where: { familyId: record.familyId },
                data: { isRevoked: true },
            });
            throw new common_1.UnauthorizedError('Security Alert: Compromised refresh token detected. All active sessions have been terminated. Please log in again.');
        }
        if (new Date() > record.expiresAt) {
            throw new common_1.UnauthorizedError('Refresh token has expired. Please log in again.');
        }
        // Revoke the presented refresh token (single-use rotation)
        await this.prisma.refreshToken.update({
            where: { id: record.id },
            data: { isRevoked: true },
        });
        // Issue new pair within the SAME family ID
        const newAccessToken = this.tokenService.generateAccessToken({
            userId: record.user.id,
            email: record.user.email,
            role: record.user.role,
        });
        const newRawRefreshToken = this.tokenService.generateRawRefreshToken();
        const newTokenHash = this.tokenService.hashRefreshToken(newRawRefreshToken);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await this.prisma.refreshToken.create({
            data: {
                userId: record.user.id,
                familyId: record.familyId,
                tokenHash: newTokenHash,
                expiresAt,
            },
        });
        return {
            accessToken: newAccessToken,
            refreshToken: newRawRefreshToken,
            expiresInSeconds: 15 * 60,
        };
    }
    /**
     * Logs out user by revoking the refresh token family
     */
    async logout(rawRefreshToken) {
        const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
        const record = await this.prisma.refreshToken.findUnique({
            where: { tokenHash },
        });
        if (record) {
            await this.prisma.refreshToken.updateMany({
                where: { familyId: record.familyId },
                data: { isRevoked: true },
            });
        }
    }
    /**
     * Helper to create a new token pair and token family
     */
    async issueTokenPair(userId, email, role) {
        const familyId = crypto_1.default.randomUUID();
        const accessToken = this.tokenService.generateAccessToken({ userId, email, role });
        const rawRefreshToken = this.tokenService.generateRawRefreshToken();
        const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await this.prisma.refreshToken.create({
            data: {
                userId,
                familyId,
                tokenHash,
                expiresAt,
            },
        });
        return {
            accessToken,
            refreshToken: rawRefreshToken,
            expiresInSeconds: 15 * 60,
        };
    }
}
exports.AuthService = AuthService;
