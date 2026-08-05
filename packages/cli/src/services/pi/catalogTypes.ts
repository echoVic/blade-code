export interface ProviderCatalogEntry {
  id: string;
  name: string;
  modelCount: number;
  defaultBaseUrl?: string;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  configured: boolean;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
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
