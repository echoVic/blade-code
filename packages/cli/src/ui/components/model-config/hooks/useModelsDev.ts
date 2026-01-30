/**
 * useModelsDev - 获取 models.dev 数据的 React Hook
 */

import { useEffect, useState } from 'react';
import {
  getModelsForProvider,
  getProviders,
} from '../../../../services/ModelsDevService.js';
import type { ModelOption, ProviderOption } from '../types.js';
import { OAUTH_PROVIDERS } from '../types.js';

interface UseProvidersResult {
  providers: ProviderOption[];
  isLoading: boolean;
  error: string | null;
}

const CUSTOM_PROVIDER: ProviderOption = {
  id: 'custom-openai-compatible',
  name: '自定义 OpenAI Compatible',
  icon: '🔧',
  description: '使用自定义 Base URL 和 API Key',
  isOAuth: false,
  envVars: [],
  bladeProvider: 'openai-compatible',
  isCustom: true,
};

export const useProviders = (): UseProvidersResult => {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const apiProviders = await getProviders();

        const oauthProviders: ProviderOption[] = Object.entries(OAUTH_PROVIDERS).map(
          ([id, info]) => ({
            id,
            name: id === 'antigravity' ? 'Google Antigravity' : 'GitHub Copilot',
            icon: info.icon,
            description: info.description,
            isOAuth: true,
            envVars: [],
            bladeProvider: info.bladeProvider,
          })
        );

        setProviders([...oauthProviders, CUSTOM_PROVIDER, ...apiProviders]);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载 Provider 列表失败');
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, []);

  return { providers, isLoading, error };
};

interface UseModelsResult {
  models: ModelOption[];
  isLoading: boolean;
  error: string | null;
}

export const useModels = (providerId: string | undefined): UseModelsResult => {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!providerId) {
      setModels([]);
      return;
    }

    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await getModelsForProvider(providerId);
        setModels(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载模型列表失败');
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [providerId]);

  return { models, isLoading, error };
};
