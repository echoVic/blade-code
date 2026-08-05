import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import type { BladeConfig } from '../../../src/config/types.js';
import { PiAIChatService } from '../../../src/services/PiAIChatService.js';

export type ModelId = 'deepseek' | 'claude' | 'gpt' | 'domestic';

/** Leaves room for reasoning models to emit both thinking and final content. */
export const REAL_API_OUTPUT_BUDGET = 1024;

export interface TestModelConfig {
  id: ModelId;
  qualificationId: string;
  name: string;
  provider: 'deepseek' | 'anthropic' | 'openai-compatible';
  model: string;
  apiKey: string;
  baseURL?: string;
}

export interface BladeModelConfig {
  id: string;
  name?: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ResolvedModelSettings {
  apiKey: string;
  baseURL: string;
  model: string;
}

export function normalizeNewApiBaseURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/^`|`$/g, '').replace(/\/+$/, '');
  return /\/v\d+$/i.test(normalized) ? normalized : `${normalized}/v1`;
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

const MODEL_ENV_PREFIXES = ['DEEPSEEK', 'CLAUDE', 'GPT', 'DOMESTIC'] as const;

function hasExplicitProviderCredentials(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return MODEL_ENV_PREFIXES.some((prefix) => Boolean(env[`${prefix}_API_KEY`]?.trim()));
}

export function resolveModelSettings(
  id: ModelId,
  envPrefix: string,
  defaultModel: string,
  defaultBaseURL: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  bladeModel?: BladeModelConfig | null
): ResolvedModelSettings {
  const fallbackModel = hasExplicitProviderCredentials(env)
    ? undefined
    : bladeModel === null
      ? undefined
      : (bladeModel ?? getBladeCurrentModel());
  const matchingBladeModel =
    fallbackModel && matchesModel(id, fallbackModel) ? fallbackModel : undefined;

  return {
    apiKey: env[`${envPrefix}_API_KEY`]?.trim() ?? matchingBladeModel?.apiKey ?? '',
    baseURL:
      env[`${envPrefix}_BASE_URL`]?.trim() ??
      matchingBladeModel?.baseUrl ??
      defaultBaseURL,
    model:
      env[`${envPrefix}_MODEL`]?.trim() ?? matchingBladeModel?.model ?? defaultModel,
  };
}

function resolveNewApiSettings(
  id: Exclude<ModelId, 'deepseek'>,
  envPrefix: string,
  defaultModel: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  bladeModel?: BladeModelConfig | null
): ResolvedModelSettings {
  const settings = resolveModelSettings(
    id,
    envPrefix,
    defaultModel,
    'https://callapi8.com/v1',
    env,
    bladeModel
  );
  return {
    ...settings,
    baseURL: normalizeNewApiBaseURL(settings.baseURL),
  };
}

function requireApiKey(config: TestModelConfig): string {
  if (config.apiKey) return config.apiKey;
  throw new Error(
    `Missing API credentials for ${config.id}. Configure the current model in ` +
      '~/.blade/config.json or provide the corresponding environment variables.'
  );
}

export function createTestChatService(config: TestModelConfig): PiAIChatService {
  return new PiAIChatService({
    provider: config.provider,
    model: config.model,
    apiKey: requireApiKey(config),
    baseUrl: config.baseURL ?? '',
    maxOutputTokens: REAL_API_OUTPUT_BUDGET,
    temperature: 0,
    timeout: 120_000,
    maxRetries: 0,
  });
}

function createDeepSeekTestConfig(
  model: string,
  settings: ResolvedModelSettings
): TestModelConfig {
  const modelSettings = { ...settings, model };
  return {
    id: 'deepseek',
    qualificationId: `deepseek:${model}`,
    name: 'DeepSeek',
    provider: 'deepseek',
    model,
    apiKey: modelSettings.apiKey,
    baseURL: modelSettings.baseURL,
  };
}

function parseModelList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
    ),
  ];
}

function createClaudeTestConfig(settings: ResolvedModelSettings): TestModelConfig {
  return {
    id: 'claude',
    qualificationId: `claude:${settings.model}`,
    name: 'Claude (via NewAPI)',
    provider: 'anthropic',
    model: settings.model,
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
  };
}

function createCompatibleTestConfig(
  id: 'gpt' | 'domestic',
  name: string,
  settings: ResolvedModelSettings
): TestModelConfig {
  return {
    id,
    qualificationId: `${id}:${settings.model}`,
    name,
    provider: 'openai-compatible',
    model: settings.model,
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
  };
}

export function resolveForkQualificationModels(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { requiredDeepSeek?: boolean } = {}
): TestModelConfig[] {
  const allowBladeFallback = env === process.env;
  const bladeModel =
    allowBladeFallback && !hasExplicitProviderCredentials(env)
      ? getBladeCurrentModel()
      : null;
  const deepseekSettings = resolveModelSettings(
    'deepseek',
    'DEEPSEEK',
    'deepseek-chat',
    'https://api.deepseek.com',
    env,
    bladeModel
  );
  const configuredDeepSeekModels = Object.hasOwn(env, 'DEEPSEEK_MODELS')
    ? parseModelList(env.DEEPSEEK_MODELS ?? '')
    : [deepseekSettings.model];

  if (options.requiredDeepSeek) {
    if (!deepseekSettings.apiKey) {
      throw new Error(
        'DeepSeek API key is required for fork qualification; set DEEPSEEK_API_KEY.'
      );
    }
    if (!configuredDeepSeekModels.includes('deepseek-v4-flash')) {
      throw new Error(
        'DeepSeek Flash is required for fork qualification; include exact model deepseek-v4-flash in DEEPSEEK_MODELS.'
      );
    }
    if (!configuredDeepSeekModels.includes('deepseek-v4-pro')) {
      throw new Error(
        'DeepSeek Pro is required for fork qualification; include exact model deepseek-v4-pro in DEEPSEEK_MODELS.'
      );
    }
  }

  const configs: TestModelConfig[] = deepseekSettings.apiKey
    ? configuredDeepSeekModels.map((model) =>
        createDeepSeekTestConfig(model, deepseekSettings)
      )
    : [];
  const claudeSettings = resolveNewApiSettings(
    'claude',
    'CLAUDE',
    'claude-opus-4-8',
    env,
    bladeModel
  );
  if (claudeSettings.apiKey) {
    configs.push(createClaudeTestConfig(claudeSettings));
  }
  const gptSettings = resolveNewApiSettings('gpt', 'GPT', 'gpt-5.5', env, bladeModel);
  if (gptSettings.apiKey) {
    configs.push(createCompatibleTestConfig('gpt', 'GPT (via NewAPI)', gptSettings));
  }
  const domesticSettings = resolveNewApiSettings(
    'domestic',
    'DOMESTIC',
    'qwen-plus',
    env,
    bladeModel
  );
  if (domesticSettings.apiKey) {
    configs.push(
      createCompatibleTestConfig('domestic', 'Domestic (via NewAPI)', domesticSettings)
    );
  }

  return configs;
}

function resolveLegacyModelConfigs(): TestModelConfig[] {
  const env = process.env;
  const bladeModel = hasExplicitProviderCredentials(env)
    ? null
    : (getBladeCurrentModel() ?? null);
  const deepseekSettings = resolveModelSettings(
    'deepseek',
    'DEEPSEEK',
    'deepseek-chat',
    'https://api.deepseek.com',
    env,
    bladeModel
  );
  const claudeSettings = resolveNewApiSettings(
    'claude',
    'CLAUDE',
    'claude-opus-4-8',
    env,
    bladeModel
  );
  const gptSettings = resolveNewApiSettings('gpt', 'GPT', 'gpt-5.5', env, bladeModel);
  const domesticSettings = resolveNewApiSettings(
    'domestic',
    'DOMESTIC',
    'qwen-plus',
    env,
    bladeModel
  );

  return [
    createDeepSeekTestConfig(deepseekSettings.model, deepseekSettings),
    createClaudeTestConfig(claudeSettings),
    createCompatibleTestConfig('gpt', 'GPT (via NewAPI)', gptSettings),
    createCompatibleTestConfig('domestic', 'Domestic (via NewAPI)', domesticSettings),
  ];
}

export function getModelConfig(id: ModelId): TestModelConfig {
  const config = resolveLegacyModelConfigs().find((candidate) => candidate.id === id);
  if (!config) throw new Error(`Unknown model: ${id}`);
  return config;
}

export function getEnabledModelConfigs(): TestModelConfig[] {
  return resolveLegacyModelConfigs().filter((config) => Boolean(config.apiKey));
}

function sanitizeRuntimeModelId(qualificationId: string): string {
  const slug = qualificationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug) {
    throw new Error('Fork qualification model ID must contain letters or numbers');
  }
  const hash = createHash('sha256').update(qualificationId).digest('hex').slice(0, 12);
  return `real-api-${slug}-${hash}`;
}

export function expandDeepSeekModelMatrix(
  configs: readonly TestModelConfig[],
  configuredModels = process.env.DEEPSEEK_MODELS
): TestModelConfig[] {
  const models = [
    ...new Set(
      (configuredModels ?? '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
    ),
  ];
  if (models.length === 0) return [...configs];

  return configs.flatMap((config) =>
    config.id === 'deepseek'
      ? models.map((model) => ({
          ...config,
          name: `${config.name} (${model})`,
          model,
        }))
      : [config]
  );
}

export function buildRealApiRuntimeConfig(modelConfig: TestModelConfig): BladeConfig {
  const modelId = sanitizeRuntimeModelId(modelConfig.qualificationId);
  return {
    ...DEFAULT_CONFIG,
    currentModelId: modelId,
    models: [
      {
        id: modelId,
        displayName: modelConfig.name,
        provider: modelConfig.provider,
        model: modelConfig.model,
        overrides: {
          maxOutputTokens: 4_096,
          timeout: 180_000,
          ...(modelConfig.baseURL ? { baseUrl: modelConfig.baseURL } : {}),
        },
      },
    ],
  };
}

export function isRealApiTestEnabled(): boolean {
  return process.env.REAL_API_TEST === '1';
}

if (isRealApiTestEnabled() && getEnabledModelConfigs().length === 0) {
  throw new Error(
    'REAL_API_TEST=1 requires provider-specific API environment variables or a ' +
      'configured model in ~/.blade/config.json when no provider credentials are set.'
  );
}
