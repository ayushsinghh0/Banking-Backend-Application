"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const client_1 = require("../generated/client");
const common_1 = require("@banksphere/common");
const account_number_generator_1 = require("../utils/account-number.generator");
class AccountService {
    prisma;
    kafkaPublisher;
    constructor(prisma, kafkaPublisher) {
        this.prisma = prisma;
        this.kafkaPublisher = kafkaPublisher;
    }
    /**
     * Provisions a new bank account and publishes 'account.created.v1' to Kafka
     */
    async createAccount(dto) {
        // Generate a unique 12-digit account number with collision retry safeguard
        let accountNumber = '';
        let isUnique = false;
        let attempts = 0;
        while (!isUnique && attempts < 5) {
            accountNumber = account_number_generator_1.AccountNumberGenerator.generate();
            const existing = await this.prisma.bankAccount.findUnique({
                where: { accountNumber },
            });
            if (!existing) {
                isUnique = true;
            }
            attempts++;
        }
        if (!isUnique) {
            throw new common_1.ConflictError('Failed to allocate unique account number. Please retry.');
        }
        const account = await this.prisma.bankAccount.create({
            data: {
                accountNumber,
                customerId: dto.customerId,
                accountType: dto.accountType || client_1.AccountType.SAVINGS,
                currency: dto.currency || 'INR',
                dailyLimit: dto.dailyLimitPaise || 10000000n, // ₹1,00,000.00 default daily limit
                status: client_1.AccountStatus.ACTIVE,
            },
        });
        // Publish account.created.v1 event to Kafka for downstream services (Ledger, Notification)
        if (this.kafkaPublisher) {
            const eventPayload = {
                eventId: crypto_1.default.randomUUID(),
                eventType: 'account.created.v1',
                timestamp: new Date().toISOString(),
                accountId: account.id,
                accountNumber: account.accountNumber,
                customerId: account.customerId,
                accountType: account.accountType,
                currency: account.currency,
                status: account.status,
            };
            try {
                await this.kafkaPublisher.publish('account.created.v1', account.id, eventPayload);
            }
            catch (err) {
                console.error('[AccountService] Failed to publish account.created.v1 event to Kafka', err);
            }
        }
        return account;
    }
    /**
     * Retrieves account details with strict ownership verification
     */
    async getAccountById(accountId, requestingCustomerId, isAdmin = false) {
        const account = await this.prisma.bankAccount.findUnique({
            where: { id: accountId },
        });
        if (!account) {
            throw new common_1.NotFoundError(`Bank account '${accountId}' not found`);
        }
        // OWNERSHIP CHECK: Prevent User A from viewing User B's account
        if (!isAdmin && account.customerId !== requestingCustomerId) {
            throw new common_1.ForbiddenError('You do not have permission to view or manage this account');
        }
        return account;
    }
    /**
     * Lists all bank accounts owned by a specific customer
     */
    async getAccountsByCustomerId(customerId) {
        return this.prisma.bankAccount.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
        });
    }
    /**
     * Updates an account's operational lifecycle status (e.g. ACTIVE -> FROZEN -> CLOSED)
     */
    async updateAccountStatus(accountId, status, requestingCustomerId, isAdmin = false) {
        const account = await this.getAccountById(accountId, requestingCustomerId, isAdmin);
        if (account.status === client_1.AccountStatus.CLOSED) {
            throw new common_1.ConflictError('Cannot alter status of an already permanently closed account');
        }
        return this.prisma.bankAccount.update({
            where: { id: accountId },
            data: { status },
        });
    }
}
exports.AccountService = AccountService;
