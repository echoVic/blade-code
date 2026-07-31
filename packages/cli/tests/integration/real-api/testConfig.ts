import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export type ModelId = 'deepseek' | 'claude' | 'gpt' | 'domestic';

export interface TestModelConfig {
  id: ModelId;
  name: string;
  provider: 'deepseek' | 'anthropic' | 'openai-compatible';
  model: string;
  apiKey: string;
  baseURL?: string;
  createModel: () => LanguageModel;
}

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
      `Set it in your shell or create a .env file before running real API tests.`
    );
  }
  return value;
}

function getOptionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function getApiKey(key: string): string {
  return process.env[key] ?? '';
}

const deepseekConfig: TestModelConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  provider: 'deepseek',
  model: getOptionalEnv('DEEPSEEK_MODEL', 'deepseek-chat'),
  apiKey: getApiKey('DEEPSEEK_API_KEY'),
  baseURL: getOptionalEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
  createModel: () => {
    const apiKey = getRequiredEnv('DEEPSEEK_API_KEY');
    const baseURL = getOptionalEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1');
    const model = getOptionalEnv('DEEPSEEK_MODEL', 'deepseek-chat');
    const deepseek = createDeepSeek({ apiKey, baseURL });
    return deepseek(model);
  },
};

const claudeConfig: TestModelConfig = {
  id: 'claude',
  name: 'Claude (via NewAPI)',
  provider: 'anthropic',
  model: getOptionalEnv('CLAUDE_MODEL', 'claude-3.5-sonnet'),
  apiKey: getApiKey('CLAUDE_API_KEY'),
  baseURL: getOptionalEnv('CLAUDE_BASE_URL', 'https://callapi8.com'),
  createModel: () => {
    const apiKey = getRequiredEnv('CLAUDE_API_KEY');
    const baseURL = getOptionalEnv('CLAUDE_BASE_URL', 'https://callapi8.com');
    const model = getOptionalEnv('CLAUDE_MODEL', 'claude-3.5-sonnet');
    const anthropic = createAnthropic({ apiKey, baseURL });
    return anthropic(model);
  },
};

const gptConfig: TestModelConfig = {
  id: 'gpt',
  name: 'GPT (via NewAPI)',
  provider: 'openai-compatible',
  model: getOptionalEnv('GPT_MODEL', 'gpt-4o'),
  apiKey: getApiKey('GPT_API_KEY'),
  baseURL: getOptionalEnv('GPT_BASE_URL', 'https://callapi8.com'),
  createModel: () => {
    const apiKey = getRequiredEnv('GPT_API_KEY');
    const baseURL = getOptionalEnv('GPT_BASE_URL', 'https://callapi8.com');
    const model = getOptionalEnv('GPT_MODEL', 'gpt-4o');
    const compatible = createOpenAICompatible({ name: 'gpt', apiKey, baseURL });
    return compatible(model);
  },
};

const domesticConfig: TestModelConfig = {
  id: 'domestic',
  name: 'Domestic (via NewAPI)',
  provider: 'openai-compatible',
  model: getOptionalEnv('DOMESTIC_MODEL', 'qwen-plus'),
  apiKey: getApiKey('DOMESTIC_API_KEY'),
  baseURL: getOptionalEnv('DOMESTIC_BASE_URL', 'https://callapi8.com'),
  createModel: () => {
    const apiKey = getRequiredEnv('DOMESTIC_API_KEY');
    const baseURL = getOptionalEnv('DOMESTIC_BASE_URL', 'https://callapi8.com');
    const model = getOptionalEnv('DOMESTIC_MODEL', 'qwen-plus');
    const compatible = createOpenAICompatible({ name: 'domestic', apiKey, baseURL });
    return compatible(model);
  },
};

export const ALL_MODEL_CONFIGS: TestModelConfig[] = [
  deepseekConfig,
  claudeConfig,
  gptConfig,
  domesticConfig,
];

export function getModelConfig(id: ModelId): TestModelConfig {
  const config = ALL_MODEL_CONFIGS.find((c) => c.id === id);
  if (!config) {
    throw new Error(`Unknown model: ${id}`);
  }
  return config;
}

export function getEnabledModelConfigs(): TestModelConfig[] {
  return ALL_MODEL_CONFIGS.filter((c) => {
    switch (c.id) {
      case 'deepseek':
        return !!process.env.DEEPSEEK_API_KEY;
      case 'claude':
        return !!process.env.CLAUDE_API_KEY;
      case 'gpt':
        return !!process.env.GPT_API_KEY;
      case 'domestic':
        return !!process.env.DOMESTIC_API_KEY;
      default:
        return false;
    }
  });
}

export function isRealApiTestEnabled(): boolean {
  return process.env.REAL_API_TEST === '1';
}
