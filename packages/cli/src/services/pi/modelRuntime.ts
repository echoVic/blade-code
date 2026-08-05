import type { Api, Model, MutableModels } from '@earendil-works/pi-ai';
import type { ModelRef } from '../../config/types.js';
import type { ChatConfig } from '../ChatServiceInterface.js';
import { getPiModelCatalog } from './PiModelCatalog.js';

export interface PiRuntime {
  models: MutableModels;
  model: Model<Api>;
}

function applyOverrides(model: Model<Api>, config: ChatConfig): Model<Api> {
  return {
    ...model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.maxOutputTokens ? { maxTokens: config.maxOutputTokens } : {}),
  };
}

export function createPiRuntime(config: ChatConfig): PiRuntime {
  const catalog = getPiModelCatalog();
  return {
    models: catalog.models,
    model: applyOverrides(catalog.getModel(config.provider, config.model), config),
  };
}

export function createFallbackModel(
  config: ChatConfig,
  fallback: ModelRef
): Model<Api> {
  const catalog = getPiModelCatalog();
  return applyOverrides(catalog.getModel(fallback.provider, fallback.model), config);
}
