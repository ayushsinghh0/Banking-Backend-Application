"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFraudRouter = createFraudRouter;
const express_1 = require("express");
function createFraudRouter(controller) {
    const router = (0, express_1.Router)();
    router.post('/evaluate', controller.evaluate);
    router.get('/alerts', controller.getAlerts);
    return router;
}
