/**
 * 获取 pi-ai catalog 数据的 React Hook
 */

import { useEffect, useState } from 'react';
import {
  getModelsForProvider,
  getProviders,
} from '../../../../services/PiCatalogService.js';
import type { ModelOption, ProviderOption } from '../types.js';

interface UseProvidersResult {
  providers: ProviderOption[];
  isLoading: boolean;
  error: string | null;
}

export const useProviders = (): UseProvidersResult => {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        setProviders(await getProviders());
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

export const useModels = (provider: string | undefined): UseModelsResult => {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) {
      setModels([]);
      return;
    }
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        setModels(await getModelsForProvider(provider));
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载模型列表失败');
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [provider]);

  return { models, isLoading, error };
};
