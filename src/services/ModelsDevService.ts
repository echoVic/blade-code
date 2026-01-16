/**
 * ModelsDevService - models.dev API 服务
 * 获取 80+ LLM Provider 及其内置模型列表
 */

import { createLogger, LogCategory } from '../logging/Logger.js';
import type {
  ModelOption,
  ModelsDevData,
  ProviderOption
} from '../ui/components/model-config/types.js';
import {
  DEFAULT_BASE_URLS,
  getBladeProvider,
  POPULAR_PROVIDERS,
  PROVIDER_ICONS,
} from '../ui/components/model-config/types.js';

const logger = createLogger(LogCategory.SERVICE);
const MODELS_DEV_API = 'https://models.dev/api.json';
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

interface CacheEntry {
  data: ModelsDevData;
  timestamp: number;
}

let cache: CacheEntry | null = null;

export const fetchModelsDevData = async (): Promise<ModelsDevData> => {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  try {
    logger.info('📡 Fetching models.dev data...');
    const response = await fetch(MODELS_DEV_API, {
      headers: { 'User-Agent': 'Blade-CLI/1.0' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as ModelsDevData;
    cache = { data, timestamp: Date.now() };
    logger.info(`✅ Loaded ${Object.keys(data).length} providers from models.dev`);
    return data;
  } catch (error) {
    logger.error('❌ Failed to fetch models.dev data:', error);
    throw error;
  }
};

export const getProviders = async (): Promise<ProviderOption[]> => {
  const data = await fetchModelsDevData();
  const providers: ProviderOption[] = [];

  for (const [id, provider] of Object.entries(data)) {
    const modelCount = Object.keys(provider.models || {}).length;
    if (modelCount === 0) continue;

    providers.push({
      id,
      name: provider.name || id,
      icon: PROVIDER_ICONS[id] || PROVIDER_ICONS.default,
      description: `${modelCount} 个模型`,
      isOAuth: false,
      envVars: provider.env || [],
      docUrl: provider.doc,
      defaultBaseUrl: DEFAULT_BASE_URLS[id],
      bladeProvider: getBladeProvider(id),
    });
  }

  return providers.sort((a, b) => {
    const aPopular = POPULAR_PROVIDERS.indexOf(a.id as (typeof POPULAR_PROVIDERS)[number]);
    const bPopular = POPULAR_PROVIDERS.indexOf(b.id as (typeof POPULAR_PROVIDERS)[number]);
    if (aPopular !== -1 && bPopular !== -1) return aPopular - bPopular;
    if (aPopular !== -1) return -1;
    if (bPopular !== -1) return 1;
    return a.name.localeCompare(b.name);
  });
};

export const getModelsForProvider = async (providerId: string): Promise<ModelOption[]> => {
  const data = await fetchModelsDevData();
  const provider = data[providerId];

  if (!provider?.models) {
    logger.warn(`⚠️ No models found for provider: ${providerId}`);
    return [];
  }

  return Object.values(provider.models).map((model) => ({
    id: model.id,
    name: model.name || model.id,
    contextWindow: model.limit?.context,
    maxOutput: model.limit?.output,
    inputCost: model.cost?.input,
    outputCost: model.cost?.output,
  }));
};


