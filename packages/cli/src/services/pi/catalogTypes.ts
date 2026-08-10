import type { ModelProviderWireApi } from '../../config/types.js';

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  modelCount: number;
  defaultBaseUrl?: string;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  configured: boolean;
  custom: boolean;
  factoryWireApi?: ModelProviderWireApi;
  wireApi?: ModelProviderWireApi;
  apiKeyEnv?: string;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  supportedReasoningEfforts: Array<
    'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  >;
  supportedServiceTiers: Array<'standard' | 'fast' | 'flex'>;
  supportedResponseVerbosities: Array<'low' | 'medium' | 'high'>;
  input: Array<'text' | 'image'>;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}
