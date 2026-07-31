import { vi } from 'vitest';
import { PermissionMode } from '../../../src/config/types.js';
import type {
  BladeConfig,
  ModelConfig,
  McpServerConfig,
} from '../../../src/config/types.js';

export interface MockConfigOptions {
  currentModelId?: string;
  models?: ModelConfig[];
  theme?: string;
  language?: string;
  permissionMode?: PermissionMode;
  permissions?: {
    allow: string[];
    ask: string[];
    deny: string[];
  };
  mcpEnabled?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: BladeConfig['hooks'];
  debug?: boolean;
}

export const createDefaultMockConfig = (
  overrides?: Partial<BladeConfig>
): BladeConfig => ({
  currentModelId: 'mock-model',
  models: [
    {
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'openai-compatible',
      apiKey: 'mock-api-key',
      baseUrl: 'https://api.mock.com',
      model: 'gpt-4',
    },
  ],
  temperature: 0.7,
  maxContextTokens: 8000,
  maxOutputTokens: 4000,
  stream: true,
  topP: 1,
  topK: 0,
  timeout: 30000,
  theme: 'GitHub',
  uiTheme: 'system',
  language: 'en',
  fontSize: 14,
  autoSaveSessions: true,
  notifyBuild: true,
  notifyErrors: true,
  notifySounds: false,
  privacyTelemetry: false,
  privacyCrash: false,
  debug: false,
  mcpEnabled: false,
  mcpServers: {},
  permissions: { allow: [], ask: [], deny: [] },
  permissionMode: PermissionMode.DEFAULT,
  hooks: {},
  env: {},
  disableAllHooks: false,
  maxTurns: 10,
  ...overrides,
});

export class MockConfigManager {
  private config: BladeConfig;
  private initialized = false;
  private saveCallCount = 0;
  private loadCallCount = 0;

  constructor(options?: MockConfigOptions) {
    this.config = createDefaultMockConfig({
      currentModelId: options?.currentModelId,
      models: options?.models,
      theme: options?.theme,
      language: options?.language,
      permissionMode: options?.permissionMode,
      permissions: options?.permissions,
      mcpEnabled: options?.mcpEnabled,
      mcpServers: options?.mcpServers,
      hooks: options?.hooks,
      debug: options?.debug,
    });
  }

  async initialize(): Promise<BladeConfig> {
    this.loadCallCount++;
    this.initialized = true;
    return this.config;
  }

  getConfig(): BladeConfig {
    return this.config;
  }

  async updateConfig(updates: Partial<BladeConfig>): Promise<void> {
    this.config = { ...this.config, ...updates };
    this.saveCallCount++;
  }

  async saveConfig(): Promise<void> {
    this.saveCallCount++;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getSaveCallCount(): number {
    return this.saveCallCount;
  }

  getLoadCallCount(): number {
    return this.loadCallCount;
  }

  reset(): void {
    this.config = createDefaultMockConfig();
    this.initialized = false;
    this.saveCallCount = 0;
    this.loadCallCount = 0;
  }

  setConfig(config: Partial<BladeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getCurrentModel(): ModelConfig | undefined {
    return this.config.models.find(
      (m: ModelConfig) => m.id === this.config.currentModelId
    );
  }

  addModel(model: ModelConfig): void {
    this.config.models.push(model);
  }

  removeModel(modelId: string): void {
    this.config.models = this.config.models.filter(
      (m: ModelConfig) => m.id !== modelId
    );
  }

  setCurrentModel(modelId: string): void {
    this.config.currentModelId = modelId;
  }
}

export const createMockConfigManager = (
  options?: MockConfigOptions
): MockConfigManager => {
  return new MockConfigManager(options);
};

export const createMockConfigService = (options?: MockConfigOptions) => {
  const manager = new MockConfigManager(options);

  return {
    initialize: vi.fn(manager.initialize.bind(manager)),
    getConfig: vi.fn(manager.getConfig.bind(manager)),
    updateConfig: vi.fn(manager.updateConfig.bind(manager)),
    saveConfig: vi.fn(manager.saveConfig.bind(manager)),
    isInitialized: vi.fn(manager.isInitialized.bind(manager)),
    getCurrentModel: vi.fn(manager.getCurrentModel.bind(manager)),
    addModel: vi.fn(manager.addModel.bind(manager)),
    removeModel: vi.fn(manager.removeModel.bind(manager)),
    setCurrentModel: vi.fn(manager.setCurrentModel.bind(manager)),
    reset: manager.reset.bind(manager),
    setConfig: manager.setConfig.bind(manager),
    _manager: manager,
  };
};

export const mockConfigDefaults = {
  model: {
    id: 'test-model',
    name: 'Test Model',
    provider: 'openai-compatible' as const,
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com',
    model: 'gpt-4',
  },
  permissions: {
    allow: ['Read(*)', 'Glob(*)'],
    ask: ['Write(*)', 'RunCommand(*)'],
    deny: ['DeleteFile(*)'],
  },
};
