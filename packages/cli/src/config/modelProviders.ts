import type { ModelProviderConfig, ModelProviderWireApi } from './types.js';

export const MODEL_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const API_KEY_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const MODEL_PROVIDER_WIRE_APIS = new Set<ModelProviderWireApi>([
  'openai-completions',
  'anthropic-messages',
]);

export function isModelProviderWireApi(value: unknown): value is ModelProviderWireApi {
  return (
    typeof value === 'string' &&
    MODEL_PROVIDER_WIRE_APIS.has(value as ModelProviderWireApi)
  );
}

export function validateModelProviderConfig(
  id: string,
  config: ModelProviderConfig
): string[] {
  const prefix = `modelProviders.${id}`;
  const errors: string[] = [];

  if (!MODEL_PROVIDER_ID_PATTERN.test(id)) {
    errors.push(`${prefix}: id must match ${MODEL_PROVIDER_ID_PATTERN.source}`);
  }
  if (!config.name?.trim()) {
    errors.push(`${prefix}: name must not be empty`);
  }
  if (!isModelProviderWireApi(config.wireApi)) {
    errors.push(`${prefix}: wireApi must be openai-completions or anthropic-messages`);
  }
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      errors.push(`${prefix}: baseUrl must be an absolute HTTP(S) URL`);
    }
  } catch {
    errors.push(`${prefix}: baseUrl must be an absolute HTTP(S) URL`);
  }
  if (config.apiKeyEnv !== undefined && !API_KEY_ENV_PATTERN.test(config.apiKeyEnv)) {
    errors.push(`${prefix}: apiKeyEnv must be a valid environment variable name`);
  }
  if ('apiKey' in (config as unknown as Record<string, unknown>)) {
    errors.push(`${prefix}: API keys must be stored separately in auth.json`);
  }

  return errors;
}
