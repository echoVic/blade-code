import { Hono } from 'hono';
import type { ModelProviderConfig } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getModelsForProvider, getProviders } from '../../services/PiCatalogService.js';
import { probeModelProvider } from '../../services/ProviderHealthService.js';
import { getPiModelCatalog } from '../../services/pi/PiModelCatalog.js';
import { configActions, getConfig } from '../../store/vanilla.js';
import { BadRequestError, ConflictError, NotFoundError } from '../error.js';

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

  app.put('/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const config = getConfig();
    const existing = config?.modelProviders[providerId];
    if (!config || !existing) {
      throw new NotFoundError('Model provider', providerId);
    }
    const body = (await c.req.json()) as Partial<ModelProviderConfig> & {
      apiKey?: string;
      apiKeyEnv?: string | null;
    };
    if (!body.name || !body.baseUrl || !body.wireApi) {
      throw new BadRequestError('name, baseUrl and wireApi are required');
    }
    const apiKeyEnv = 'apiKeyEnv' in body ? body.apiKeyEnv?.trim() : existing.apiKeyEnv;
    const next: ModelProviderConfig = {
      name: body.name,
      baseUrl: body.baseUrl,
      wireApi: body.wireApi,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    };

    const catalog = getPiModelCatalog();
    const previousCredential = body.apiKey?.trim()
      ? await catalog.credentials.read(providerId)
      : undefined;
    if (body.apiKey?.trim()) {
      await catalog.setApiKey(providerId, body.apiKey.trim());
    }
    try {
      await configActions().updateModelProvider(providerId, next);
      return c.json({ success: true });
    } catch (error) {
      if (body.apiKey?.trim()) {
        if (previousCredential) {
          await catalog.credentials.modify(providerId, async () => previousCredential);
        } else {
          await catalog.credentials.delete(providerId);
        }
      }
      if (
        error instanceof Error &&
        (error.message.includes('modelProviders.') ||
          error.message.includes('built-in provider'))
      ) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }
  });

  app.delete('/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const config = getConfig();
    if (!config?.modelProviders[providerId]) {
      throw new NotFoundError('Model provider', providerId);
    }
    const removeModelsValue = c.req.query('removeModels');
    if (
      removeModelsValue !== undefined &&
      removeModelsValue !== 'true' &&
      removeModelsValue !== 'false'
    ) {
      throw new BadRequestError('removeModels must be true or false');
    }
    try {
      const result = await configActions().removeModelProvider(providerId, {
        removeModels: removeModelsValue === 'true',
      });
      return c.json({ success: true, ...result });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('still referenced') ||
          error.message.includes('owns the only model'))
      ) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  });

  app.post('/:provider/probe', async (c) => {
    const providerId = c.req.param('provider');
    const config = getConfig();
    if (!config?.modelProviders[providerId]) {
      throw new NotFoundError('Model provider', providerId);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      modelId?: string;
    };
    const providerModels = config.models.filter(
      (model) => model.provider === providerId
    );
    const model = body.modelId
      ? providerModels.find((candidate) => candidate.id === body.modelId)
      : providerModels[0];
    if (!model) {
      throw new BadRequestError(
        body.modelId
          ? 'modelId does not reference this provider'
          : 'Model provider has no configured model to probe'
      );
    }
    return c.json(await probeModelProvider(model, config));
  });

  return app;
};
