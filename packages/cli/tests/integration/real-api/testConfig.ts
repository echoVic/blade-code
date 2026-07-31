import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export type ModelId = 'deepseek' | 'claude' | 'gpt' | 'domestic';

/** Leaves room for reasoning models to emit both thinking and final content. */
export const REAL_API_OUTPUT_BUDGET = 1024;

export interface TestModelConfig {
  id: ModelId;
  name: string;
  provider: 'deepseek' | 'anthropic' | 'openai-compatible';
  model: string;
  apiKey: string;
  baseURL?: string;
  createModel: () => LanguageModel;
}

interface BladeModelConfig {
  id: string;
  name?: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

interface ResolvedModelSettings {
  apiKey: string;
  baseURL: string;
  model: string;
}

let cachedBladeModel: BladeModelConfig | null | undefined;

function getBladeCurrentModel(): BladeModelConfig | undefined {
  if (cachedBladeModel !== undefined) {
    return cachedBladeModel ?? undefined;
  }

  try {
    const configPath = path.join(os.homedir(), '.blade', 'config.json');
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      currentModelId?: string;
      models?: BladeModelConfig[];
    };
    cachedBladeModel =
      parsed.models?.find((model) => model.id === parsed.currentModelId) ?? null;
  } catch {
    cachedBladeModel = null;
  }

  return cachedBladeModel ?? undefined;
}

function matchesModel(id: ModelId, config: BladeModelConfig): boolean {
  const provider = config.provider.toLowerCase();
  const model = config.model.toLowerCase();

  switch (id) {
    case 'deepseek':
      return provider === 'deepseek';
    case 'claude':
      return provider === 'anthropic' || model.includes('claude');
    case 'gpt':
      return (
        provider === 'openai' ||
        (provider === 'openai-compatible' && /^(gpt|o[134])/.test(model))
      );
    case 'domestic':
      return provider === 'openai-compatible' && !/^(gpt|o[134])/.test(model);
  }
}

function resolveModelSettings(
  id: ModelId,
  envPrefix: string,
  defaultModel: string,
  defaultBaseURL: string
): ResolvedModelSettings {
  const bladeModel = getBladeCurrentModel();
  const matchingBladeModel =
    bladeModel && matchesModel(id, bladeModel) ? bladeModel : undefined;

  return {
    apiKey: process.env[`${envPrefix}_API_KEY`] ?? matchingBladeModel?.apiKey ?? '',
    baseURL:
      process.env[`${envPrefix}_BASE_URL`] ??
      matchingBladeModel?.baseUrl ??
      defaultBaseURL,
    model:
      process.env[`${envPrefix}_MODEL`] ?? matchingBladeModel?.model ?? defaultModel,
  };
}

function requireApiKey(id: ModelId, settings: ResolvedModelSettings): string {
  if (settings.apiKey) return settings.apiKey;
  throw new Error(
    `Missing API credentials for ${id}. Configure the current model in ` +
      '~/.blade/config.json or provide the corresponding environment variables.'
  );
}

const deepseekSettings = resolveModelSettings(
  'deepseek',
  'DEEPSEEK',
  'deepseek-chat',
  'https://api.deepseek.com'
);

const deepseekConfig: TestModelConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  provider: 'deepseek',
  model: deepseekSettings.model,
  apiKey: deepseekSettings.apiKey,
  baseURL: deepseekSettings.baseURL,
  createModel: () => {
    const apiKey = requireApiKey('deepseek', deepseekSettings);
    const deepseek = createDeepSeek({
      apiKey,
      baseURL: deepseekSettings.baseURL,
    });
    return deepseek(deepseekSettings.model);
  },
};

const claudeSettings = resolveModelSettings(
  'claude',
  'CLAUDE',
  'claude-3.5-sonnet',
  'https://callapi8.com'
);

const claudeConfig: TestModelConfig = {
  id: 'claude',
  name: 'Claude (via NewAPI)',
  provider: 'anthropic',
  model: claudeSettings.model,
  apiKey: claudeSettings.apiKey,
  baseURL: claudeSettings.baseURL,
  createModel: () => {
    const apiKey = requireApiKey('claude', claudeSettings);
    const anthropic = createAnthropic({ apiKey, baseURL: claudeSettings.baseURL });
    return anthropic(claudeSettings.model);
  },
};

const gptSettings = resolveModelSettings(
  'gpt',
  'GPT',
  'gpt-4o',
  'https://callapi8.com'
);

const gptConfig: TestModelConfig = {
  id: 'gpt',
  name: 'GPT (via NewAPI)',
  provider: 'openai-compatible',
  model: gptSettings.model,
  apiKey: gptSettings.apiKey,
  baseURL: gptSettings.baseURL,
  createModel: () => {
    const apiKey = requireApiKey('gpt', gptSettings);
    const compatible = createOpenAICompatible({
      name: 'gpt',
      apiKey,
      baseURL: gptSettings.baseURL,
    });
    return compatible(gptSettings.model);
  },
};

const domesticSettings = resolveModelSettings(
  'domestic',
  'DOMESTIC',
  'qwen-plus',
  'https://callapi8.com'
);

const domesticConfig: TestModelConfig = {
  id: 'domestic',
  name: 'Domestic (via NewAPI)',
  provider: 'openai-compatible',
  model: domesticSettings.model,
  apiKey: domesticSettings.apiKey,
  baseURL: domesticSettings.baseURL,
  createModel: () => {
    const apiKey = requireApiKey('domestic', domesticSettings);
    const compatible = createOpenAICompatible({
      name: 'domestic',
      apiKey,
      baseURL: domesticSettings.baseURL,
    });
    return compatible(domesticSettings.model);
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
  return ALL_MODEL_CONFIGS.filter((config) => Boolean(config.apiKey));
}

export function isRealApiTestEnabled(): boolean {
  return process.env.REAL_API_TEST === '1';
}

if (isRealApiTestEnabled() && getEnabledModelConfigs().length === 0) {
  throw new Error(
    'REAL_API_TEST=1 requires a configured model in ~/.blade/config.json ' +
      'or provider-specific API environment variables.'
  );
}
