import { Hono } from 'hono';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import {
    configActions,
    getAllModels,
    getCurrentModel,
} from '../../store/vanilla.js';
import { BadRequestError } from '../error.js';

const logger = createLogger(LogCategory.SERVICE);

export const ModelsRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const models = getAllModels();
      const current = getCurrentModel();
      
      return c.json({
        configured: models,
        current,
      });
    } catch (error) {
      logger.error('[ModelsRoutes] Failed to get models:', error);
      return c.json({ configured: [], current: null });
    }
  });

  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const { provider, name, model, baseUrl, apiKey } = body;

      if (!model) {
        throw new BadRequestError('model is required');
      }

      const modelConfig = await configActions().addModel({
        provider: provider || 'openai-compatible',
        name: name || model,
        model,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
      });

      return c.json({ success: true, model: modelConfig });
    } catch (error) {
      logger.error('[ModelsRoutes] Failed to add model:', error);
      throw error;
    }
  });

  app.put('/:modelId', async (c) => {
    try {
      const modelId = c.req.param('modelId');
      const body = await c.req.json();
      const { baseUrl, apiKey, model } = body;

      await configActions().updateModel(modelId, {
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        model: model || undefined,
      });
      return c.json({ success: true });
    } catch (error) {
      logger.error('[ModelsRoutes] Failed to update model:', error);
      throw error;
    }
  });

  app.delete('/:modelId', async (c) => {
    try {
      const modelId = c.req.param('modelId');
      await configActions().removeModel(modelId);
      return c.json({ success: true });
    } catch (error) {
      logger.error('[ModelsRoutes] Failed to delete model:', error);
      throw error;
    }
  });

  return app;
};
