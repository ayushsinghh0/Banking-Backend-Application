"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCustomerRouter = createCustomerRouter;
const express_1 = require("express");
function createCustomerRouter(controller) {
    const router = (0, express_1.Router)();
    // Profile endpoints
    router.get('/me', controller.getMe);
    router.post('/me', controller.createMe);
    router.patch('/me', controller.updateMe);
    return router;
}
