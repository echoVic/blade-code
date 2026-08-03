import { nanoid } from 'nanoid';
import { PermissionMode } from '../../../src/config/types.js';
import type {
  BladeConfig,
  ModelConfig,
  ProviderType,
  McpServerConfig,
} from '../../../src/config/types.js';

export const createModelConfig = (overrides?: Partial<ModelConfig>): ModelConfig => ({
  id: overrides?.id || nanoid(),
  name: overrides?.name || 'Test Model',
  provider: overrides?.provider || 'openai-compatible',
  apiKey: overrides?.apiKey || 'test-api-key',
  baseUrl: overrides?.baseUrl || 'https://api.test.com',
  model: overrides?.model || 'gpt-4',
  ...overrides,
});

export const createBladeConfig = (overrides?: Partial<BladeConfig>): BladeConfig => {
  const defaultModel = createModelConfig({ id: 'default-model' });

  return {
    currentModelId: overrides?.currentModelId || defaultModel.id,
    models: overrides?.models || [defaultModel],
    temperature: overrides?.temperature ?? 0.7,
    maxContextTokens: overrides?.maxContextTokens ?? 8000,
    maxOutputTokens: overrides?.maxOutputTokens ?? 4000,
    stream: overrides?.stream ?? true,
    topP: overrides?.topP ?? 1,
    topK: overrides?.topK ?? 0,
    timeout: overrides?.timeout ?? 30000,
    theme: overrides?.theme || 'GitHub',
    language: overrides?.language || 'en',
    debug: overrides?.debug ?? false,
    mcpEnabled: overrides?.mcpEnabled ?? false,
    mcpServers: overrides?.mcpServers || {},
    permissions: overrides?.permissions || { allow: [], ask: [], deny: [] },
    permissionMode: overrides?.permissionMode || PermissionMode.DEFAULT,
    hooks: overrides?.hooks || {},
    env: overrides?.env || {},
    disableAllHooks: overrides?.disableAllHooks ?? false,
    maxTurns: overrides?.maxTurns ?? 10,
    ...overrides,
  } as BladeConfig;
};

export const modelPresets = {
  openai: (apiKey?: string): ModelConfig =>
    createModelConfig({
      id: 'openai-gpt4',
      name: 'OpenAI GPT-4',
      provider: 'openai-compatible' as ProviderType,
      apiKey: apiKey || 'sk-test-key',
      model: 'gpt-4',
    }),

  anthropic: (apiKey?: string): ModelConfig =>
    createModelConfig({
      id: 'anthropic-claude',
      name: 'Anthropic Claude',
      provider: 'anthropic' as ProviderType,
      apiKey: apiKey || 'sk-ant-test-key',
      model: 'claude-3-opus-20240229',
    }),

  azure: (apiKey?: string, endpoint?: string): ModelConfig =>
    createModelConfig({
      id: 'azure-openai',
      name: 'Azure OpenAI',
      provider: 'azure-openai' as ProviderType,
      apiKey: apiKey || 'azure-test-key',
      baseUrl: endpoint || 'https://test.openai.azure.com',
      model: 'gpt-4',
    }),

  gemini: (apiKey?: string): ModelConfig =>
    createModelConfig({
      id: 'google-gemini',
      name: 'Google Gemini',
      provider: 'gemini' as ProviderType,
      apiKey: apiKey || 'google-test-key',
      model: 'gemini-pro',
    }),

  custom: (baseUrl: string, apiKey?: string): ModelConfig =>
    createModelConfig({
      id: 'custom-model',
      name: 'Custom Model',
      provider: 'openai-compatible',
      apiKey: apiKey || 'custom-key',
      baseUrl,
      model: 'custom',
    }),
};

export const permissionPresets = {
  allowAll: (): BladeConfig['permissions'] => ({
    allow: ['*'],
    ask: [],
    deny: [],
  }),

  denyAll: (): BladeConfig['permissions'] => ({
    allow: [],
    ask: [],
    deny: ['*'],
  }),

  readOnly: (): BladeConfig['permissions'] => ({
    allow: ['Read(*)', 'Glob(*)', 'Grep(*)', 'LS(*)'],
    ask: [],
    deny: ['Write(*)', 'SearchReplace(*)', 'DeleteFile(*)', 'RunCommand(*)'],
  }),

  askForWrite: (): BladeConfig['permissions'] => ({
    allow: ['Read(*)', 'Glob(*)', 'Grep(*)', 'LS(*)'],
    ask: ['Write(*)', 'SearchReplace(*)', 'DeleteFile(*)'],
    deny: ['RunCommand(*)'],
  }),

  development: (): BladeConfig['permissions'] => ({
    allow: ['Read(*)', 'Glob(*)', 'Grep(*)', 'LS(*)', 'Write(*)', 'SearchReplace(*)'],
    ask: ['RunCommand(*)', 'DeleteFile(*)'],
    deny: [],
  }),

  production: (): BladeConfig['permissions'] => ({
    allow: ['Read(*)', 'Glob(*)', 'Grep(*)', 'LS(*)'],
    ask: ['Write(*)', 'SearchReplace(*)'],
    deny: ['DeleteFile(*)', 'RunCommand(*)'],
  }),
};

export const configPresets = {
  minimal: (): BladeConfig =>
    createBladeConfig({
      models: [modelPresets.openai()],
      currentModelId: 'openai-gpt4',
    }),

  development: (): BladeConfig =>
    createBladeConfig({
      models: [modelPresets.openai()],
      currentModelId: 'openai-gpt4',
      permissions: permissionPresets.development(),
      debug: true,
    }),

  production: (): BladeConfig =>
    createBladeConfig({
      models: [modelPresets.openai()],
      currentModelId: 'openai-gpt4',
      permissions: permissionPresets.production(),
      debug: false,
    }),

  multiModel: (): BladeConfig =>
    createBladeConfig({
      models: [modelPresets.openai(), modelPresets.anthropic(), modelPresets.gemini()],
      currentModelId: 'openai-gpt4',
    }),

  withMCP: (servers: Record<string, McpServerConfig>): BladeConfig =>
    createBladeConfig({
      mcpEnabled: true,
      mcpServers: servers,
    }),

  withHooks: (hooks: BladeConfig['hooks']): BladeConfig =>
    createBladeConfig({
      hooks,
      disableAllHooks: false,
    }),
};

export const permissionModes: PermissionMode[] = [
  PermissionMode.DEFAULT,
  PermissionMode.AUTO_EDIT,
  PermissionMode.YOLO,
  PermissionMode.PLAN,
];
