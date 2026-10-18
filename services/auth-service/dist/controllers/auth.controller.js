"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const zod_1 = require("zod");
const registerSchema = zod_1.z.object({
    email: zod_1.z.string().email({ message: 'Invalid email address format' }),
    password: zod_1.z
        .string()
        .min(8, { message: 'Password must be at least 8 characters long' })
        .regex(/[A-Z]/, { message: 'Password must contain at least one uppercase letter' })
        .regex(/[a-z]/, { message: 'Password must contain at least one lowercase letter' })
        .regex(/[0-9]/, { message: 'Password must contain at least one number' }),
    role: zod_1.z.enum(['CUSTOMER', 'BANK_ADMIN', 'SUPPORT']).optional(),
});
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(1),
});
const refreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(1, { message: 'refreshToken is required' }),
});
class AuthController {
    authService;
    constructor(authService) {
        this.authService = authService;
    }
    register = async (req, res, next) => {
        try {
            const validated = registerSchema.parse(req.body);
            const result = await this.authService.register(validated);
            res.status(201).json({
                success: true,
                data: result,
            });
        }
        catch (error) {
            next(error);
        }
    };
    login = async (req, res, next) => {
        try {
            const validated = loginSchema.parse(req.body);
            const result = await this.authService.login(validated);
            res.status(200).json({
                success: true,
                data: result,
            });
        }
        catch (error) {
            next(error);
        }
    };
    refresh = async (req, res, next) => {
        try {
            const validated = refreshSchema.parse(req.body);
            const tokens = await this.authService.refreshToken(validated.refreshToken);
            res.status(200).json({
                success: true,
                data: tokens,
            });
        }
        catch (error) {
            next(error);
        }
    };
    logout = async (req, res, next) => {
        try {
            const validated = refreshSchema.parse(req.body);
            await this.authService.logout(validated.refreshToken);
            res.status(200).json({
                success: true,
                message: 'Successfully logged out and session revoked',
            });
        }
        catch (error) {
            next(error);
        }
    };
}
exports.AuthController = AuthController;
