import type { Model } from '@earendil-works/pi-ai';
import type { BladeConfig, ModelConfig } from '../../config/types.js';
import type { ChatConfig } from '../ChatServiceInterface.js';
import { getPiModelCatalog } from './PiModelCatalog.js';

export interface ResolvedModelConfig {
  config: ModelConfig;
  model: Model<string>;
  displayName: string;
  chat: ChatConfig;
}

export function resolveModelConfig(
  config: ModelConfig,
  appConfig: Pick<BladeConfig, 'temperature' | 'timeout'>,
  reasoningEnabled: boolean
): ResolvedModelConfig {
  const model = getPiModelCatalog().resolveConfig(config);
  const overrides = config.overrides;
  return {
    config,
    model,
    displayName: config.displayName ?? model.name,
    chat: {
      provider: config.provider,
      model: config.model,
      apiKey: process.env.BLADE_API_KEY,
      baseUrl: process.env.BLADE_BASE_URL ?? overrides?.baseUrl,
      temperature: overrides?.temperature ?? appConfig.temperature,
      maxContextTokens: model.contextWindow,
      maxOutputTokens: overrides?.maxOutputTokens,
      timeout: overrides?.timeout ?? appConfig.timeout,
      reasoningEnabled: model.reasoning && reasoningEnabled,
      fallbackModels: config.fallbackModels,
      enablePromptCaching: overrides?.enablePromptCaching,
      customHeaders: overrides?.customHeaders,
      apiVersion: overrides?.apiVersion,
      maxRetries: overrides?.maxRetries,
    },
  };
}

export function getModelDisplayName(config: ModelConfig): string {
  try {
    return (
      config.displayName ??
      getPiModelCatalog().getModel(config.provider, config.model).name
    );
  } catch {
    return config.displayName ?? config.model;
  }
}
