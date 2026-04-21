import { Hono } from 'hono';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getModelsForProvider, getProviders } from '../../services/ModelsDevService.js';

const logger = createLogger(LogCategory.SERVICE);

export const ProviderRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const apiProviders = await getProviders();
      return c.json(apiProviders);
    } catch (error) {
      logger.error('[ProviderRoutes] Failed to list providers:', error);
      return c.json([]);
    }
  });

  app.get('/:providerId/models', async (c) => {
    const providerId = c.req.param('providerId');

    try {
      const models = await getModelsForProvider(providerId);
      return c.json(models);
    } catch (error) {
      logger.error('[ProviderRoutes] Failed to list models:', error);
      return c.json([]);
    }
  });

  return app;
};
