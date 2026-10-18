"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FraudController = void 0;
const zod_1 = require("zod");
const evaluateSchema = zod_1.z.object({
    transactionId: zod_1.z.string().uuid(),
    accountId: zod_1.z.string().uuid(),
    amountInPaise: zod_1.z.string().regex(/^\d+$/),
});
class FraudController {
    fraudService;
    constructor(fraudService) {
        this.fraudService = fraudService;
    }
    evaluate = async (req, res, next) => {
        try {
            const validated = evaluateSchema.parse(req.body);
            const result = await this.fraudService.evaluateTransaction({
                transactionId: validated.transactionId,
                accountId: validated.accountId,
                amountInPaise: BigInt(validated.amountInPaise),
                timestamp: new Date(),
            });
            res.status(200).json({
                success: true,
                data: result,
            });
        }
        catch (error) {
            next(error);
        }
    };
    getAlerts = async (req, res, next) => {
        try {
            const status = req.query.status;
            const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
            const alerts = await this.fraudService.getAlerts(status, limit);
            res.status(200).json({
                success: true,
                data: alerts,
            });
        }
        catch (error) {
            next(error);
        }
    };
}
exports.FraudController = FraudController;
