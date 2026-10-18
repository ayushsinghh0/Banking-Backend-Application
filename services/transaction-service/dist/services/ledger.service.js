"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LedgerService = void 0;
const client_1 = require("../generated/client");
const types_1 = require("../types");
const errors_1 = require("../errors");
class LedgerService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    /**
     * Helper to generate a human-readable unique reference ID
     */
    generateReferenceId(prefix) {
        const timestamp = Date.now();
        const randomHex = Math.random().toString(16).substring(2, 8).toUpperCase();
        return `${prefix}-${timestamp}-${randomHex}`;
    }
    /**
     * Executes a transfer between two accounts using strict double-entry ledgering,
     * deterministic row-level locking, and transactional outbox event insertion.
     */
    async executeTransfer(dto) {
        const { sourceAccountId, destinationAccountId, amountInPaise, description } = dto;
        if (amountInPaise <= 0n) {
            throw new errors_1.InvalidAmountError();
        }
        if (sourceAccountId === destinationAccountId) {
            throw new errors_1.SameAccountTransferError();
        }
        const referenceId = dto.referenceId || this.generateReferenceId('TXN-TRF');
        // Run within a single atomic PostgreSQL transaction
        const result = await this.prisma.$transaction(async (tx) => {
            // DEADLOCK PREVENTION: Sort account IDs lexicographically before acquiring row locks
            const [firstId, secondId] = [sourceAccountId, destinationAccountId].sort();
            // Acquire pessimistic row-level exclusive locks in deterministic order
            const accounts = await tx.$queryRaw `
          SELECT id, balance, is_active, account_number 
          FROM ledger_accounts 
          WHERE id IN (${firstId}, ${secondId})
          ORDER BY id ASC
          FOR UPDATE
        `;
            if (accounts.length < 2) {
                throw new errors_1.NotFoundError('One or both specified accounts do not exist in the ledger');
            }
            const sourceAccount = accounts.find((a) => a.id === sourceAccountId);
            const destAccount = accounts.find((a) => a.id === destinationAccountId);
            // Inactive account validation
            if (!sourceAccount.is_active || !destAccount.is_active) {
                throw new errors_1.AccountInactiveError();
            }
            // Authoritative balance check within the locked row boundary
            if (sourceAccount.balance < amountInPaise) {
                throw new errors_1.InsufficientFundsError(`Insufficient balance. Available: ${sourceAccount.balance.toString()} paise, Requested: ${amountInPaise.toString()} paise`);
            }
            // 1. Create the Transaction record
            const transaction = await tx.transaction.create({
                data: {
                    referenceId,
                    type: types_1.TransactionType.TRANSFER,
                    status: types_1.TransactionStatus.COMPLETED,
                    amount: amountInPaise,
                    sourceAccountId,
                    destinationAccountId,
                    description: description || `Transfer to account ${destAccount.account_number}`,
                },
            });
            const newSourceBalance = sourceAccount.balance - amountInPaise;
            const newDestBalance = destAccount.balance + amountInPaise;
            // 2. DOUBLE-ENTRY BOOKKEEPING:
            // Source Account is DEBITED (decrease in bank's liability to account holder)
            await tx.ledgerEntry.create({
                data: {
                    transactionId: transaction.id,
                    accountId: sourceAccountId,
                    entryType: types_1.EntryType.DEBIT,
                    amount: amountInPaise,
                    balanceAfter: newSourceBalance,
                },
            });
            // Destination Account is CREDITED (increase in bank's liability to account holder)
            await tx.ledgerEntry.create({
                data: {
                    transactionId: transaction.id,
                    accountId: destinationAccountId,
                    entryType: types_1.EntryType.CREDIT,
                    amount: amountInPaise,
                    balanceAfter: newDestBalance,
                },
            });
            // 3. Atomically update operational account balances
            await tx.ledgerAccount.update({
                where: { id: sourceAccountId },
                data: { balance: newSourceBalance },
            });
            await tx.ledgerAccount.update({
                where: { id: destinationAccountId },
                data: { balance: newDestBalance },
            });
            // 4. TRANSACTIONAL OUTBOX:
            // Stage the event inside the exact same database transaction
            const outboxPayload = {
                eventId: crypto.randomUUID(),
                eventType: 'transaction.completed.v1',
                timestamp: new Date().toISOString(),
                transactionId: transaction.id,
                referenceId: transaction.referenceId,
                type: transaction.type,
                amountInPaise: amountInPaise.toString(),
                sourceAccountId,
                destinationAccountId,
            };
            await tx.outboxEvent.create({
                data: {
                    aggregateType: 'TRANSACTION',
                    aggregateId: transaction.id,
                    eventType: 'transaction.completed.v1',
                    payload: outboxPayload,
                    status: 'PENDING',
                },
            });
            return transaction;
        }, {
            isolationLevel: client_1.Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 10000, // 10s maximum database transaction window
        });
        return {
            transactionId: result.id,
            referenceId: result.referenceId,
            type: result.type,
            status: result.status,
            amountInPaise: result.amount.toString(),
            sourceAccountId: result.sourceAccountId,
            destinationAccountId: result.destinationAccountId,
            createdAt: result.createdAt,
        };
    }
    /**
     * Executes a deposit into an account
     */
    async executeDeposit(dto) {
        const { accountId, amountInPaise, description } = dto;
        if (amountInPaise <= 0n) {
            throw new errors_1.InvalidAmountError();
        }
        const referenceId = dto.referenceId || this.generateReferenceId('TXN-DEP');
        const result = await this.prisma.$transaction(async (tx) => {
            // Row lock on target account
            const [account] = await tx.$queryRaw `
        SELECT id, balance, is_active, account_number 
        FROM ledger_accounts 
        WHERE id = ${accountId}
        FOR UPDATE
      `;
            if (!account) {
                throw new errors_1.NotFoundError(`Account '${accountId}' not found in the ledger`);
            }
            if (!account.is_active) {
                throw new errors_1.AccountInactiveError();
            }
            const transaction = await tx.transaction.create({
                data: {
                    referenceId,
                    type: types_1.TransactionType.DEPOSIT,
                    status: types_1.TransactionStatus.COMPLETED,
                    amount: amountInPaise,
                    destinationAccountId: accountId,
                    description: description || 'Account cash/credit deposit',
                },
            });
            const newBalance = account.balance + amountInPaise;
            // Credit entry in ledger
            await tx.ledgerEntry.create({
                data: {
                    transactionId: transaction.id,
                    accountId,
                    entryType: types_1.EntryType.CREDIT,
                    amount: amountInPaise,
                    balanceAfter: newBalance,
                },
            });
            // Update account balance
            await tx.ledgerAccount.update({
                where: { id: accountId },
                data: { balance: newBalance },
            });
            // Transactional outbox
            await tx.outboxEvent.create({
                data: {
                    aggregateType: 'TRANSACTION',
                    aggregateId: transaction.id,
                    eventType: 'transaction.completed.v1',
                    payload: {
                        eventId: crypto.randomUUID(),
                        eventType: 'transaction.completed.v1',
                        timestamp: new Date().toISOString(),
                        transactionId: transaction.id,
                        referenceId: transaction.referenceId,
                        type: transaction.type,
                        amountInPaise: amountInPaise.toString(),
                        destinationAccountId: accountId,
                    },
                    status: 'PENDING',
                },
            });
            return transaction;
        });
        return {
            transactionId: result.id,
            referenceId: result.referenceId,
            type: result.type,
            status: result.status,
            amountInPaise: result.amount.toString(),
            destinationAccountId: result.destinationAccountId,
            createdAt: result.createdAt,
        };
    }
    /**
     * Executes a withdrawal from an account
     */
    async executeWithdrawal(dto) {
        const { accountId, amountInPaise, description } = dto;
        if (amountInPaise <= 0n) {
            throw new errors_1.InvalidAmountError();
        }
        const referenceId = dto.referenceId || this.generateReferenceId('TXN-WTH');
        const result = await this.prisma.$transaction(async (tx) => {
            // Row lock on target account
            const [account] = await tx.$queryRaw `
        SELECT id, balance, is_active, account_number 
        FROM ledger_accounts 
        WHERE id = ${accountId}
        FOR UPDATE
      `;
            if (!account) {
                throw new errors_1.NotFoundError(`Account '${accountId}' not found in the ledger`);
            }
            if (!account.is_active) {
                throw new errors_1.AccountInactiveError();
            }
            if (account.balance < amountInPaise) {
                throw new errors_1.InsufficientFundsError(`Insufficient balance. Available: ${account.balance.toString()} paise, Requested: ${amountInPaise.toString()} paise`);
            }
            const transaction = await tx.transaction.create({
                data: {
                    referenceId,
                    type: types_1.TransactionType.WITHDRAWAL,
                    status: types_1.TransactionStatus.COMPLETED,
                    amount: amountInPaise,
                    sourceAccountId: accountId,
                    description: description || 'Account cash withdrawal',
                },
            });
            const newBalance = account.balance - amountInPaise;
            // Debit entry in ledger
            await tx.ledgerEntry.create({
                data: {
                    transactionId: transaction.id,
                    accountId,
                    entryType: types_1.EntryType.DEBIT,
                    amount: amountInPaise,
                    balanceAfter: newBalance,
                },
            });
            // Update account balance
            await tx.ledgerAccount.update({
                where: { id: accountId },
                data: { balance: newBalance },
            });
            // Transactional outbox
            await tx.outboxEvent.create({
                data: {
                    aggregateType: 'TRANSACTION',
                    aggregateId: transaction.id,
                    eventType: 'transaction.completed.v1',
                    payload: {
                        eventId: crypto.randomUUID(),
                        eventType: 'transaction.completed.v1',
                        timestamp: new Date().toISOString(),
                        transactionId: transaction.id,
                        referenceId: transaction.referenceId,
                        type: transaction.type,
                        amountInPaise: amountInPaise.toString(),
                        sourceAccountId: accountId,
                    },
                    status: 'PENDING',
                },
            });
            return transaction;
        });
        return {
            transactionId: result.id,
            referenceId: result.referenceId,
            type: result.type,
            status: result.status,
            amountInPaise: result.amount.toString(),
            sourceAccountId: result.sourceAccountId,
            createdAt: result.createdAt,
        };
    }
    /**
     * Retrieves an account balance authoritatively from the ledger
     */
    async getAccountBalance(accountId) {
        const account = await this.prisma.ledgerAccount.findUnique({
            where: { id: accountId },
            select: { balance: true, currency: true },
        });
        if (!account) {
            throw new errors_1.NotFoundError(`Account '${accountId}' not found`);
        }
        return {
            balanceInPaise: account.balance.toString(),
            currency: account.currency,
        };
    }
    /**
     * Returns paginated transaction history for an account
     */
    async getTransactionHistory(accountId, limit = 20, offset = 0) {
        const entries = await this.prisma.ledgerEntry.findMany({
            where: { accountId },
            include: { transaction: true },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
        });
        return entries.map((entry) => ({
            entryId: entry.id,
            transactionId: entry.transactionId,
            referenceId: entry.transaction.referenceId,
            type: entry.transaction.type,
            entryType: entry.entryType,
            amountInPaise: entry.amount.toString(),
            balanceAfterInPaise: entry.balanceAfter.toString(),
            createdAt: entry.createdAt,
        }));
    }
}
exports.LedgerService = LedgerService;
