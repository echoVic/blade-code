import { Hono } from 'hono';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getModelsForProvider, getProviders } from '../../services/PiCatalogService.js';
import { getPiModelCatalog } from '../../services/pi/PiModelCatalog.js';
import { BadRequestError } from '../error.js';

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

  app.get('/:provider/models', async (c) => {
    const provider = c.req.param('provider');

    try {
      const models = await getModelsForProvider(provider);
      return c.json(models);
    } catch (error) {
      logger.error('[ProviderRoutes] Failed to list models:', error);
      return c.json([]);
    }
  });

  app.put('/:provider/credential', async (c) => {
    const provider = c.req.param('provider');
    const body = (await c.req.json()) as { apiKey?: string };
    if (!body.apiKey?.trim()) {
      throw new BadRequestError('apiKey is required');
    }
    await getPiModelCatalog().setApiKey(provider, body.apiKey.trim());
    return c.json({ success: true });
  });

  app.delete('/:provider/credential', async (c) => {
    await getPiModelCatalog().clearCredential(c.req.param('provider'));
    return c.json({ success: true });
  });

  return app;
};
