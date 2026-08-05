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
  displayName: overrides?.displayName || 'Test Model',
  provider: overrides?.provider || 'deepseek',
  model: overrides?.model || 'deepseek-v4-pro',
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
  openai: (_apiKey?: string): ModelConfig =>
    createModelConfig({
      id: 'openai-gpt4',
      displayName: 'OpenAI GPT',
      provider: 'openai' as ProviderType,
      model: 'gpt-5-mini',
    }),

  anthropic: (_apiKey?: string): ModelConfig =>
    createModelConfig({
      id: 'anthropic-claude',
      displayName: 'Anthropic Claude',
      provider: 'anthropic' as ProviderType,
      model: 'claude-sonnet-4-5',
    }),

  azure: (_apiKey?: string, endpoint?: string): ModelConfig =>
    createModelConfig({
      id: 'azure-openai',
      displayName: 'Azure OpenAI',
      provider: 'azure-openai-responses' as ProviderType,
      model: 'gpt-5-mini',
      overrides: { baseUrl: endpoint || 'https://test.openai.azure.com' },
    }),

  gemini: (_apiKey?: string): ModelConfig =>
    createModelConfig({
      id: 'google-gemini',
      displayName: 'Google Gemini',
      provider: 'google' as ProviderType,
      model: 'gemini-2.5-flash',
    }),

  custom: (baseUrl: string, _apiKey?: string): ModelConfig =>
    createModelConfig({
      id: 'custom-model',
      displayName: 'Custom Endpoint',
      provider: 'openai',
      model: 'gpt-5-mini',
      overrides: { baseUrl },
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
