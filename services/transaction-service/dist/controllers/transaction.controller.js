"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionController = void 0;
const zod_1 = require("zod");
const errors_1 = require("../errors");
const transferSchema = zod_1.z.object({
    sourceAccountId: zod_1.z.string().uuid({ message: 'sourceAccountId must be a valid UUID' }),
    destinationAccountId: zod_1.z.string().uuid({ message: 'destinationAccountId must be a valid UUID' }),
    amountInPaise: zod_1.z.string().regex(/^\d+$/, { message: 'amountInPaise must be a positive integer string' }),
    description: zod_1.z.string().max(255).optional(),
});
const depositWithdrawSchema = zod_1.z.object({
    accountId: zod_1.z.string().uuid({ message: 'accountId must be a valid UUID' }),
    amountInPaise: zod_1.z.string().regex(/^\d+$/, { message: 'amountInPaise must be a positive integer string' }),
    description: zod_1.z.string().max(255).optional(),
});
class TransactionController {
    ledgerService;
    idempotencyService;
    constructor(ledgerService, idempotencyService) {
        this.ledgerService = ledgerService;
        this.idempotencyService = idempotencyService;
    }
    transfer = async (req, res, next) => {
        const idempotencyKey = req.header('Idempotency-Key');
        if (!idempotencyKey) {
            res.status(400).json({
                error: {
                    code: 'MISSING_IDEMPOTENCY_KEY',
                    message: "Header 'Idempotency-Key' is required for financial write operations",
                },
            });
            return;
        }
        try {
            const validatedBody = transferSchema.parse(req.body);
            const requestHash = this.idempotencyService.generateRequestHash(validatedBody);
            // Check or lock the idempotency record
            const idempResult = await this.idempotencyService.acquireKey(idempotencyKey, req.originalUrl, requestHash);
            if (idempResult.isCached && idempResult.statusCode && idempResult.responseBody) {
                res.setHeader('X-Cache-Lookup', 'IDEMPOTENT_REPLAY');
                res.status(idempResult.statusCode).json(idempResult.responseBody);
                return;
            }
            // Execute transfer through authoritative double-entry engine
            const result = await this.ledgerService.executeTransfer({
                sourceAccountId: validatedBody.sourceAccountId,
                destinationAccountId: validatedBody.destinationAccountId,
                amountInPaise: BigInt(validatedBody.amountInPaise),
                description: validatedBody.description,
            });
            const responsePayload = {
                success: true,
                data: result,
            };
            // Mark idempotency key as completed with the response payload
            await this.idempotencyService.completeKey(idempotencyKey, 201, responsePayload);
            res.status(201).json(responsePayload);
        }
        catch (error) {
            if (idempotencyKey && !(error instanceof errors_1.AppError && error.statusCode === 409)) {
                await this.idempotencyService.failKey(idempotencyKey).catch(() => { });
            }
            next(error);
        }
    };
    deposit = async (req, res, next) => {
        const idempotencyKey = req.header('Idempotency-Key');
        if (!idempotencyKey) {
            res.status(400).json({
                error: {
                    code: 'MISSING_IDEMPOTENCY_KEY',
                    message: "Header 'Idempotency-Key' is required for deposit operations",
                },
            });
            return;
        }
        try {
            const validatedBody = depositWithdrawSchema.parse(req.body);
            const requestHash = this.idempotencyService.generateRequestHash(validatedBody);
            const idempResult = await this.idempotencyService.acquireKey(idempotencyKey, req.originalUrl, requestHash);
            if (idempResult.isCached && idempResult.statusCode && idempResult.responseBody) {
                res.setHeader('X-Cache-Lookup', 'IDEMPOTENT_REPLAY');
                res.status(idempResult.statusCode).json(idempResult.responseBody);
                return;
            }
            const result = await this.ledgerService.executeDeposit({
                accountId: validatedBody.accountId,
                amountInPaise: BigInt(validatedBody.amountInPaise),
                description: validatedBody.description,
            });
            const responsePayload = { success: true, data: result };
            await this.idempotencyService.completeKey(idempotencyKey, 201, responsePayload);
            res.status(201).json(responsePayload);
        }
        catch (error) {
            if (idempotencyKey && !(error instanceof errors_1.AppError && error.statusCode === 409)) {
                await this.idempotencyService.failKey(idempotencyKey).catch(() => { });
            }
            next(error);
        }
    };
    withdraw = async (req, res, next) => {
        const idempotencyKey = req.header('Idempotency-Key');
        if (!idempotencyKey) {
            res.status(400).json({
                error: {
                    code: 'MISSING_IDEMPOTENCY_KEY',
                    message: "Header 'Idempotency-Key' is required for withdrawal operations",
                },
            });
            return;
        }
        try {
            const validatedBody = depositWithdrawSchema.parse(req.body);
            const requestHash = this.idempotencyService.generateRequestHash(validatedBody);
            const idempResult = await this.idempotencyService.acquireKey(idempotencyKey, req.originalUrl, requestHash);
            if (idempResult.isCached && idempResult.statusCode && idempResult.responseBody) {
                res.setHeader('X-Cache-Lookup', 'IDEMPOTENT_REPLAY');
                res.status(idempResult.statusCode).json(idempResult.responseBody);
                return;
            }
            const result = await this.ledgerService.executeWithdrawal({
                accountId: validatedBody.accountId,
                amountInPaise: BigInt(validatedBody.amountInPaise),
                description: validatedBody.description,
            });
            const responsePayload = { success: true, data: result };
            await this.idempotencyService.completeKey(idempotencyKey, 201, responsePayload);
            res.status(201).json(responsePayload);
        }
        catch (error) {
            if (idempotencyKey && !(error instanceof errors_1.AppError && error.statusCode === 409)) {
                await this.idempotencyService.failKey(idempotencyKey).catch(() => { });
            }
            next(error);
        }
    };
    getBalance = async (req, res, next) => {
        try {
            const accountId = req.params.accountId;
            const balance = await this.ledgerService.getAccountBalance(accountId);
            res.json({ success: true, data: balance });
        }
        catch (error) {
            next(error);
        }
    };
    getHistory = async (req, res, next) => {
        try {
            const accountId = req.params.accountId;
            const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
            const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
            const history = await this.ledgerService.getTransactionHistory(accountId, limit, offset);
            res.json({ success: true, data: history });
        }
        catch (error) {
            next(error);
        }
    };
}
exports.TransactionController = TransactionController;
