import { Hono } from 'hono';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getModelsForProvider, getProviders } from '../../services/ModelsDevService.js';
import { OAUTH_PROVIDERS } from '../../ui/components/model-config/types.js';

const logger = createLogger(LogCategory.SERVICE);

export const ProviderRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const apiProviders = await getProviders();

      const oauthProviders = Object.entries(OAUTH_PROVIDERS).map(([id, config]) => ({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        icon: config.icon,
        description: config.description,
        isOAuth: true,
        envVars: [],
        bladeProvider: config.bladeProvider,
      }));

      return c.json([...apiProviders, ...oauthProviders]);
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
