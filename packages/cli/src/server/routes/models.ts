import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai';
import { Hono } from 'hono';
import { resolveWorkspaceAgentResources } from '../../agent/resources/WorkspaceAgentResources.js';
import { resolveWorkspaceModelResources } from '../../agent/resources/WorkspaceModelResources.js';
import type { ModelConfig, ModelProviderConfig } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import {
  BUILTIN_COMMUNICATION_STYLE_CATALOG,
  type CommunicationStyleSummary,
} from '../../services/communicationStyle.js';
import { getPiModelCatalog } from '../../services/pi/PiModelCatalog.js';
import { getSupportedResponseVerbosities } from '../../services/pi/responseVerbosity.js';
import { getSupportedServiceTiers } from '../../services/pi/serviceTier.js';
import { configActions, getConfig, getModelById } from '../../store/vanilla.js';
import { getCwd } from '../../utils/cwd.js';
import { BadRequestError, InternalServerError } from '../error.js';

const logger = createLogger(LogCategory.SERVICE);

export function projectModelConfig(
  config: ModelConfig,
  runtimeModel: Model<Api>,
  communicationStyles: CommunicationStyleSummary[] = BUILTIN_COMMUNICATION_STYLE_CATALOG.list()
) {
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
    supportedReasoningEfforts: getSupportedThinkingLevels(runtimeModel),
    supportedServiceTiers: getSupportedServiceTiers(runtimeModel),
    supportedResponseVerbosities: getSupportedResponseVerbosities(runtimeModel),
    communicationStyles,
    input: runtimeModel.input,
  };
}

export function createModelUpdates(body: {
  displayName?: string;
  overrides?: ModelConfig['overrides'];
  model?: string;
}): Partial<Omit<ModelConfig, 'id'>> {
  validateModelOverrides(body.overrides);
  const updates: Partial<Omit<ModelConfig, 'id'>> = {
    displayName: body.displayName || undefined,
    overrides: body.overrides || undefined,
  };
  if (body.model) {
    updates.model = body.model;
  }
  return updates;
}

function validateModelOverrides(overrides?: ModelConfig['overrides']): void {
  const streamIdleTimeout = overrides?.streamIdleTimeout;
  if (
    streamIdleTimeout !== undefined &&
    (!Number.isFinite(streamIdleTimeout) || streamIdleTimeout < 1_000)
  ) {
    throw new BadRequestError('streamIdleTimeout must be at least 1000ms');
  }
}

export const ModelsRoutes = () => {
  const app = new Hono<{ Variables: { directory: string } }>();

  app.get('/', async (c) => {
    try {
      const startupConfig = getConfig();
      if (!startupConfig) throw new Error('Config not initialized');
      const workspaceRoot = c.get('directory') || getCwd();
      const [resources, agentResources] = await Promise.all([
        resolveWorkspaceModelResources(workspaceRoot, startupConfig),
        resolveWorkspaceAgentResources(workspaceRoot),
      ]);
      const models = resources.config.models;
      const current =
        models.find((model) => model.id === resources.config.currentModelId) ??
        models[0];
      const catalog = resources.catalog;
      const communicationStyles = agentResources.communicationStyles.list();
      const describe = (config: (typeof models)[number]) =>
        projectModelConfig(config, catalog.resolveConfig(config), communicationStyles);

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
    const catalog = getPiModelCatalog();
    let credentialProviderId: string | undefined;
    let registeredProviderId: string | undefined;
    try {
      const body = await c.req.json();
      const { provider, displayName, model, overrides, apiKey, modelProvider } =
        body as {
          provider?: string;
          displayName?: string;
          model?: string;
          overrides?: ModelConfig['overrides'];
          apiKey?: string;
          modelProvider?: ModelProviderConfig & { id?: string };
        };

      if (!provider || !model) {
        throw new BadRequestError('provider and model are required');
      }
      validateModelOverrides(overrides);
      let providerConfig: ModelProviderConfig | undefined;
      if (modelProvider) {
        if (modelProvider.id !== provider) {
          throw new BadRequestError('modelProvider.id must match the model provider');
        }
        if (getConfig()?.modelProviders[provider]) {
          throw new BadRequestError(`model provider already exists: ${provider}`);
        }
        providerConfig = {
          name: modelProvider.name,
          baseUrl: modelProvider.baseUrl,
          wireApi: modelProvider.wireApi,
          ...(modelProvider.apiKeyEnv ? { apiKeyEnv: modelProvider.apiKeyEnv } : {}),
        };
        try {
          catalog.registerModelProvider(provider, providerConfig, [model]);
          registeredProviderId = provider;
        } catch (error) {
          throw new BadRequestError(
            error instanceof Error ? error.message : 'Invalid model provider'
          );
        }
      } else {
        catalog.getModel(provider, model);
      }
      if (apiKey?.trim()) {
        await catalog.setApiKey(provider, apiKey.trim());
        if (providerConfig) credentialProviderId = provider;
      }

      const input = {
        provider,
        displayName: displayName || undefined,
        model,
        overrides: overrides || undefined,
      };
      const modelConfig = providerConfig
        ? await configActions().addModelWithProvider(input, providerConfig)
        : await configActions().addModel(input);

      return c.json({ success: true, model: modelConfig });
    } catch (error) {
      if (credentialProviderId) {
        await catalog.credentials.delete(credentialProviderId);
      }
      if (registeredProviderId) {
        const config = getConfig();
        catalog.configureModelProviders(
          config?.modelProviders ?? {},
          config?.models ?? []
        );
      }
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
