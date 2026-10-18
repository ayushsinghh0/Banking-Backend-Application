"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAccountRouter = createAccountRouter;
const express_1 = require("express");
function createAccountRouter(controller) {
    const router = (0, express_1.Router)();
    router.post('/', controller.create);
    router.get('/', controller.list);
    router.get('/:accountId', controller.getById);
    router.patch('/:accountId/status', controller.updateStatus);
    return router;
}
