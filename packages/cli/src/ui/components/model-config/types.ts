/**
 * 模型配置向导类型定义
 * 基于 models.dev API 数据结构
 */

import type { SetupConfig } from '../../../config/types.js';

export interface ModelsDevModel {
  id: string;
  name: string;
  cost?: { input: number; output: number };
  limit?: { context: number; output: number };
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  env: string[];
  npm?: string;
  doc?: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;

export interface ProviderOption {
  id: string;
  name: string;
  icon: string;
  description: string;
  envVars: string[];
  docUrl?: string;
  defaultBaseUrl?: string;
  isCustom?: boolean;
}

export interface ModelOption {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  inputCost?: number;
  outputCost?: number;
}

export type WizardStep = 'provider' | 'apiKey' | 'baseUrl' | 'model' | 'confirm';

export interface ModelConfigWizardProps {
  mode: 'setup' | 'add' | 'edit';
  initialConfig?: SetupConfig;
  modelId?: string;
  onComplete: (config: SetupConfig) => void;
  onCancel: () => void;
}

export const POPULAR_PROVIDERS = [
  'anthropic',
  'openai',
  'deepseek',
  'google-generative-ai',
  'groq',
  'openrouter',
] as const;

export const PROVIDER_ICONS: Record<string, string> = {
  anthropic: '',
  openai: '',
  'google-generative-ai': '',
  deepseek: '',
  groq: '',
  openrouter: '',
  azure: '',
  ollama: '',
  together: '',
  fireworks: '',
  mistral: '',
  cohere: '',
  perplexity: '',
  xai: '',
  default: '',
};

export const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  togetherai: 'https://api.together.xyz/v1',
  'fireworks-ai': 'https://api.fireworks.ai/inference/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.ai/v1',
  perplexity: 'https://api.perplexity.ai',
  xai: 'https://api.x.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  'novita-ai': 'https://api.novita.ai/v3/openai',
  nvidia: 'https://integrate.api.nvidia.com/v1',
};

/**
 * Provider 特定的 HTTP Headers
 */
export const PROVIDER_HEADERS: Record<string, Record<string, string>> = {
  anthropic: {
    'anthropic-beta':
      'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
  },
  openrouter: {
    'HTTP-Referer': 'https://github.com/anthropics/blade',
    'X-Title': 'Blade',
  },
  cerebras: {
    'X-Cerebras-3rd-Party-Integration': 'blade',
  },
  vercel: {
    'http-referer': 'https://github.com/anthropics/blade',
    'x-title': 'blade',
  },
  zenmux: {
    'HTTP-Referer': 'https://github.com/anthropics/blade',
    'X-Title': 'blade',
  },
};

/**
 * 获取 Provider 特定的 Headers
 */
export const getProviderHeaders = (provider: string): Record<string, string> => {
  return PROVIDER_HEADERS[provider] || {};
};
