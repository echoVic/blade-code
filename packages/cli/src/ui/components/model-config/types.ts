import type { SetupConfig } from '../../../config/types.js';
import type {
  ModelOption,
  ProviderOption,
} from '../../../services/PiCatalogService.js';

export type { ModelOption, ProviderOption };

export type WizardStep = 'provider' | 'custom' | 'model' | 'credential';

export interface ModelConfigWizardProps {
  mode: 'setup' | 'add' | 'edit';
  initialConfig?: SetupConfig;
  modelId?: string;
  onComplete: (config: SetupConfig) => void | Promise<void>;
  onCancel: () => void;
}

export const PROVIDER_ICONS: Record<string, string> = {
  anthropic: '',
  openai: '',
  google: '',
  deepseek: '',
  groq: '',
  openrouter: '',
  'azure-openai-responses': '',
  mistral: '',
  xai: '',
  default: '',
};

export const PROVIDER_HEADERS: Record<string, Record<string, string>> = {
  openrouter: {
    'HTTP-Referer': 'https://github.com/echoVic/blade-code',
    'X-Title': 'Blade',
  },
  cerebras: {
    'X-Cerebras-3rd-Party-Integration': 'blade',
  },
};

export const getProviderHeaders = (provider: string): Record<string, string> =>
  PROVIDER_HEADERS[provider] || {};
