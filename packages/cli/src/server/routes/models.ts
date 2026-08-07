import type { Api, Model } from '@earendil-works/pi-ai';
import { Hono } from 'hono';
import type { ModelConfig } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getPiModelCatalog } from '../../services/pi/PiModelCatalog.js';
import {
  configActions,
  getAllModels,
  getCurrentModel,
  getModelById,
} from '../../store/vanilla.js';
import { BadRequestError, InternalServerError } from '../error.js';

const logger = createLogger(LogCategory.SERVICE);

export function projectModelConfig(config: ModelConfig, runtimeModel: Model<Api>) {
  return {
    id: config.id,
    displayName: config.displayName,
    provider: config.provider,
    model: config.model,
    overrides: config.overrides,
    fallbackModels: config.fallbackModels,
    contextWindow: runtimeModel.contextWindow,
    maxTokens: runtimeModel.maxTokens,
    reasoning: runtimeModel.reasoning,
    input: runtimeModel.input,
  };
}

export function createModelUpdates(body: {
  displayName?: string;
  overrides?: ModelConfig['overrides'];
  model?: string;
}): Partial<Omit<ModelConfig, 'id'>> {
  const updates: Partial<Omit<ModelConfig, 'id'>> = {
    displayName: body.displayName || undefined,
    overrides: body.overrides || undefined,
  };
  if (body.model) {
    updates.model = body.model;
  }
  return updates;
}

export const ModelsRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const models = getAllModels();
      const current = getCurrentModel();
      const catalog = getPiModelCatalog();
      const describe = (config: (typeof models)[number]) =>
        projectModelConfig(config, catalog.resolveConfig(config));

      return c.json({
        configured: models.map(describe),
        current: current ? describe(current) : null,
      });
    } catch (error) {
      logger.error('[ModelsRoutes] Failed to get models:', error);
      const failure = new InternalServerError('Failed to get models');
      return c.json(failure.toObject(), 500);
    }
  });

  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const { provider, displayName, model, overrides, apiKey } = body;

      if (!provider || !model) {
        throw new BadRequestError('provider and model are required');
      }
      getPiModelCatalog().getModel(provider, model);
      if (apiKey?.trim()) {
        await getPiModelCatalog().setApiKey(provider, apiKey.trim());
      }

      const modelConfig = await configActions().addModel({
        provider,
        displayName: displayName || undefined,
        model,
        overrides: overrides || undefined,
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
      const { displayName, overrides, model } = body;
      const existing = getModelById(modelId);
      if (!existing) throw new BadRequestError('model config not found');
      if (model) {
        getPiModelCatalog().getModel(existing.provider, model);
      }

      await configActions().updateModel(
        modelId,
        createModelUpdates({ displayName, overrides, model })
      );
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
