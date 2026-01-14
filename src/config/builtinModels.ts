/**
 * 内置模型配置
 *
 * 提供开箱即用的免费模型，让用户无需配置即可体验 Blade
 * 当前支持：
 * - 智谱 GLM-4.7 (由 Blade 团队提供免费额度)
 * - Claude Sonnet 4 (由 Blade 团队提供免费额度)
 */

import type { ModelConfig, ProviderType } from './types.js';

interface BuiltinModelDefinition {
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
const BUILTIN_GLM_MODEL_ID = 'blade-builtin-glm47';
const BUILTIN_CLAUDE_MODEL_ID = 'blade-builtin-claude';

const BUILTIN_MODELS: BuiltinModelDefinition[] = [
  {
    name: '✨ GLM-4.7 (内置免费)',
    provider: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-4.7',
    apiKey: BUILTIN_API_KEY,
    description: '智谱 GLM-4.7 Thinking - 由 Blade 提供免费额度',
    maxContextTokens: 204800,
    maxOutputTokens: 16384,
    supportsThinking: true,
  },
  {
    name: '✨ Claude Opus 4.5 (内置免费)',
    provider: 'blade-claude',
    baseUrl: '', // 由私有包处理
    model: 'claude-opus-4-5',
    apiKey: BUILTIN_API_KEY,
    description: 'Claude Opus 4.5 - 由 Blade 提供免费额度',
    maxContextTokens: 200000,
    maxOutputTokens: 16384,
    supportsThinking: false,
  },
];

export function getBuiltinModelId(): string {
  return BUILTIN_GLM_MODEL_ID;
}

export function getBuiltinClaudeModelId(): string {
  return BUILTIN_CLAUDE_MODEL_ID;
}

export function isBuiltinApiKey(apiKey: string): boolean {
  return apiKey === BUILTIN_API_KEY;
}

export function isBuiltinModel(model: ModelConfig): boolean {
  return isBuiltinApiKey(model.apiKey);
}

export function isBuiltinClaudeModel(model: ModelConfig): boolean {
  return model.provider === 'blade-claude' && isBuiltinApiKey(model.apiKey);
}

function createBuiltinModelConfig(
  definition: BuiltinModelDefinition,
  id: string
): ModelConfig {
  return {
    id,
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
  return createBuiltinModelConfig(BUILTIN_MODELS[0], BUILTIN_GLM_MODEL_ID);
}

export function getAllBuiltinModels(): ModelConfig[] {
  return [
    createBuiltinModelConfig(BUILTIN_MODELS[0], BUILTIN_GLM_MODEL_ID),
    createBuiltinModelConfig(BUILTIN_MODELS[1], BUILTIN_CLAUDE_MODEL_ID),
  ];
}
