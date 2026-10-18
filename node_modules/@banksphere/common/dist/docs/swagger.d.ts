import { Express } from 'express';
export interface SwaggerDocOptions {
    title: string;
    version: string;
    description: string;
    paths: Record<string, any>;
    components?: Record<string, any>;
}
export declare function setupSwagger(app: Express, options: SwaggerDocOptions, endpoint?: string): void;
//# sourceMappingURL=swagger.d.ts.map