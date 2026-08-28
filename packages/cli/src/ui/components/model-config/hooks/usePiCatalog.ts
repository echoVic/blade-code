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
    let cancelled = false;
    const load = async () => {
      try {
        const nextProviders = await getProviders();
        if (!cancelled) setProviders(nextProviders);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载 Provider 列表失败');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
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
      setIsLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setModels([]);
    setIsLoading(true);
    setError(null);
    const load = async () => {
      try {
        const nextModels = await getModelsForProvider(provider);
        if (!cancelled) setModels(nextModels);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载模型列表失败');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  return { models, isLoading, error };
};
