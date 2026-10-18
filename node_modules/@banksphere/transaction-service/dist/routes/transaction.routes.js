"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTransactionRouter = createTransactionRouter;
const express_1 = require("express");
function createTransactionRouter(controller) {
    const router = (0, express_1.Router)();
    // Financial write endpoints requiring Idempotency-Key
    router.post('/transfer', controller.transfer);
    router.post('/deposit', controller.deposit);
    router.post('/withdraw', controller.withdraw);
    // Read-only ledger queries
    router.get('/accounts/:accountId/balance', controller.getBalance);
    router.get('/accounts/:accountId/history', controller.getHistory);
    return router;
}
