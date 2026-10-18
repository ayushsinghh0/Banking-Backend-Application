"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerController = void 0;
const zod_1 = require("zod");
const common_1 = require("@banksphere/common");
const createProfileSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2).max(100),
    phoneNumber: zod_1.z.string().regex(/^\+?[1-9]\d{7,14}$/, { message: 'Invalid phone number format' }),
    address: zod_1.z.string().max(255).optional(),
    dateOfBirth: zod_1.z
        .string()
        .datetime()
        .optional()
        .transform((val) => (val ? new Date(val) : undefined)),
});
const updateProfileSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2).max(100).optional(),
    phoneNumber: zod_1.z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
    address: zod_1.z.string().max(255).optional(),
    dateOfBirth: zod_1.z
        .string()
        .datetime()
        .optional()
        .transform((val) => (val ? new Date(val) : undefined)),
});
class CustomerController {
    customerService;
    constructor(customerService) {
        this.customerService = customerService;
    }
    /**
     * Helper to resolve authenticated user identity passed from Gateway
     */
    getAuthenticatedUserId(req) {
        const userId = req.headers['x-user-id'] || req.user?.id;
        if (!userId) {
            throw new common_1.UnauthorizedError('Authentication required: Missing user identification headers');
        }
        return userId;
    }
    getMe = async (req, res, next) => {
        try {
            const userId = this.getAuthenticatedUserId(req);
            const { profile, fromCache } = await this.customerService.getProfileByUserId(userId);
            res.setHeader('X-Cache-Lookup', fromCache ? 'HIT' : 'MISS');
            res.status(200).json({
                success: true,
                data: profile,
            });
        }
        catch (error) {
            next(error);
        }
    };
    createMe = async (req, res, next) => {
        try {
            const userId = this.getAuthenticatedUserId(req);
            const validated = createProfileSchema.parse(req.body);
            const profile = await this.customerService.createProfile({
                userId,
                fullName: validated.fullName,
                phoneNumber: validated.phoneNumber,
                address: validated.address,
                dateOfBirth: validated.dateOfBirth,
            });
            res.status(201).json({
                success: true,
                data: profile,
            });
        }
        catch (error) {
            next(error);
        }
    };
    updateMe = async (req, res, next) => {
        try {
            const userId = this.getAuthenticatedUserId(req);
            const validated = updateProfileSchema.parse(req.body);
            const updated = await this.customerService.updateProfile(userId, validated);
            res.status(200).json({
                success: true,
                data: updated,
            });
        }
        catch (error) {
            next(error);
        }
    };
}
exports.CustomerController = CustomerController;
