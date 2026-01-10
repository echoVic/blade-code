/**
 * 内置模型配置
 *
 * 提供开箱即用的免费模型，让用户无需配置即可体验 Blade
 * 当前支持：智谱 GLM-4 (由 Blade 团队提供免费额度)
 */

import type { ModelConfig, ProviderType } from './types.js';

export interface BuiltinModelDefinition {
  name: string;
  provider: ProviderType;
  baseUrl: string;
  model: string;
  apiKey: string;
  description: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
}

const BUILTIN_API_KEY = 'blade-free-tier';
const BUILTIN_MODEL_ID = 'blade-builtin-glm47';

export const BUILTIN_MODELS: BuiltinModelDefinition[] = [
  {
    name: '✨ GLM-4.7 (内置免费)',
    provider: 'openai-compatible',
    baseUrl: 'https://blade-api-proxy.137844255.workers.dev/v1',
    model: 'glm-4.7',
    apiKey: BUILTIN_API_KEY,
    description: '智谱 GLM-4.7 Thinking - 由 Blade 提供免费额度',
    maxContextTokens: 204800,
    maxOutputTokens: 16384,
    supportsThinking: true,
  },
];

export function getBuiltinModelId(): string {
  return BUILTIN_MODEL_ID;
}

export function isBuiltinApiKey(apiKey: string): boolean {
  return apiKey === BUILTIN_API_KEY;
}

export function isBuiltinModel(model: ModelConfig): boolean {
  return isBuiltinApiKey(model.apiKey);
}

export function createBuiltinModelConfig(
  definition: BuiltinModelDefinition
): ModelConfig {
  return {
    id: BUILTIN_MODEL_ID,
    name: definition.name,
    provider: definition.provider,
    baseUrl: definition.baseUrl,
    model: definition.model,
    apiKey: definition.apiKey,
    maxContextTokens: definition.maxContextTokens,
    maxOutputTokens: definition.maxOutputTokens,
    supportsThinking: definition.supportsThinking,
  };
}

export function getDefaultBuiltinModel(): ModelConfig {
  return createBuiltinModelConfig(BUILTIN_MODELS[0]);
}

export function getAllBuiltinModels(): ModelConfig[] {
  return BUILTIN_MODELS.map(createBuiltinModelConfig);
}
