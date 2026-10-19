import { Express } from 'express';
import swaggerUi from 'swagger-ui-express';

export interface SwaggerDocOptions {
  title: string;
  version: string;
  description: string;
  paths: Record<string, any>;
  components?: Record<string, any>;
}

export function setupSwagger(app: Express, options: SwaggerDocOptions, endpoint = '/docs'): void {
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

  app.use(endpoint, swaggerUi.serve, swaggerUi.setup(swaggerDoc));
}
