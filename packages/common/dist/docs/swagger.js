"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSwagger = setupSwagger;
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
function setupSwagger(app, options, endpoint = '/docs') {
    const swaggerDoc = {
        openapi: '3.0.0',
        info: {
            title: options.title,
            version: options.version,
            description: options.description,
        },
        servers: [
            {
                url: '/',
                description: 'Current environment',
            },
        ],
        paths: options.paths,
        components: options.components || {},
    };
    app.use(endpoint, swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swaggerDoc));
}
//# sourceMappingURL=swagger.js.map