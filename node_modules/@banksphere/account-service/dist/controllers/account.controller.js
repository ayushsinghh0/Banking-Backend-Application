"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountController = void 0;
const zod_1 = require("zod");
const common_1 = require("@banksphere/common");
const createAccountSchema = zod_1.z.object({
    accountType: zod_1.z.enum(['SAVINGS', 'CURRENT']).optional(),
    currency: zod_1.z.string().length(3).default('INR'),
    dailyLimitPaise: zod_1.z
        .string()
        .regex(/^\d+$/)
        .optional()
        .transform((val) => (val ? BigInt(val) : undefined)),
});
const updateStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(['ACTIVE', 'FROZEN', 'CLOSED']),
});
class AccountController {
    accountService;
    constructor(accountService) {
        this.accountService = accountService;
    }
    getAuthContext(req) {
        const userId = req.headers['x-user-id'] || req.user?.id;
        const role = (req.headers['x-user-role'] || req.user?.role || 'CUSTOMER').toUpperCase();
        if (!userId) {
            throw new common_1.UnauthorizedError('Authentication required: Missing user identification headers');
        }
        return {
            userId,
            role,
            isAdmin: role === 'BANK_ADMIN' || role === 'ADMIN',
        };
    }
    create = async (req, res, next) => {
        try {
            const { userId } = this.getAuthContext(req);
            const validated = createAccountSchema.parse(req.body);
            const account = await this.accountService.createAccount({
                customerId: userId,
                accountType: validated.accountType,
                currency: validated.currency,
                dailyLimitPaise: validated.dailyLimitPaise,
            });
            res.status(201).json({
                success: true,
                data: {
                    ...account,
                    dailyLimitPaise: account.dailyLimit.toString(),
                },
            });
        }
        catch (error) {
            next(error);
        }
    };
    list = async (req, res, next) => {
        try {
            const { userId } = this.getAuthContext(req);
            const accounts = await this.accountService.getAccountsByCustomerId(userId);
            res.status(200).json({
                success: true,
                data: accounts.map((a) => ({
                    ...a,
                    dailyLimitPaise: a.dailyLimit.toString(),
                })),
            });
        }
        catch (error) {
            next(error);
        }
    };
    getById = async (req, res, next) => {
        try {
            const { userId, isAdmin } = this.getAuthContext(req);
            const accountId = req.params.accountId;
            const account = await this.accountService.getAccountById(accountId, userId, isAdmin);
            res.status(200).json({
                success: true,
                data: {
                    ...account,
                    dailyLimitPaise: account.dailyLimit.toString(),
                },
            });
        }
        catch (error) {
            next(error);
        }
    };
    updateStatus = async (req, res, next) => {
        try {
            const { userId, isAdmin } = this.getAuthContext(req);
            const accountId = req.params.accountId;
            const validated = updateStatusSchema.parse(req.body);
            const updated = await this.accountService.updateAccountStatus(accountId, validated.status, userId, isAdmin);
            res.status(200).json({
                success: true,
                data: {
                    ...updated,
                    dailyLimitPaise: updated.dailyLimit.toString(),
                },
            });
        }
        catch (error) {
            next(error);
        }
    };
}
exports.AccountController = AccountController;
