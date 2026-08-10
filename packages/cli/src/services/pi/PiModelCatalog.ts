import {
  type Api,
  type CredentialStore,
  createModels,
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  type Model,
  type MutableModels,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { validateModelProviderConfig } from '../../config/modelProviders.js';
import type {
  ModelConfig,
  ModelProviderConfig,
  ModelProviderWireApi,
} from '../../config/types.js';
import type { ModelCatalogEntry, ProviderCatalogEntry } from './catalogTypes.js';
import { normalizeProviderBaseUrl } from './endpoint.js';
import { FileCredentialStore } from './FileCredentialStore.js';
import { getSupportedResponseVerbosities } from './responseVerbosity.js';
import { getSupportedServiceTiers } from './serviceTier.js';

export const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible';
export const ANTHROPIC_COMPATIBLE_PROVIDER = 'anthropic-compatible';
const OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_COMPATIBLE_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CUSTOM_CONTEXT_WINDOW = 128_000;
const DEFAULT_CUSTOM_MAX_TOKENS = 32_768;
const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
const TEMPLATE_PROVIDER_PRIORITY = [
  'openai',
  'anthropic',
  'deepseek',
  'google',
  'moonshotai',
  'moonshotai-cn',
  'zai',
  'zai-coding-cn',
] as const;

export class PiModelCatalog {
  readonly credentials: CredentialStore;
  readonly models: MutableModels;
  private readonly compatibleModels = new Map<string, Model<'openai-completions'>>();
  private readonly anthropicCompatibleModels = new Map<
    string,
    Model<'anthropic-messages'>
  >();
  private readonly customProviderConfigs = new Map<string, ModelProviderConfig>();
  private readonly customProviderModels = new Map<string, Map<string, Model<Api>>>();
  private readonly reservedProviderIds = new Set<string>();

  constructor(credentials: CredentialStore = new FileCredentialStore()) {
    this.credentials = credentials;
    this.models = createModels({ credentials });
    for (const provider of builtinProviders()) {
      this.models.setProvider(provider);
    }
    this.installOpenAICompatibleProvider();
    this.installAnthropicCompatibleProvider();
    for (const provider of this.models.getProviders()) {
      this.reservedProviderIds.add(provider.id);
    }
  }

  async listProviders(): Promise<ProviderCatalogEntry[]> {
    return Promise.all(
      this.models.getProviders().map(async (provider) => {
        const models = provider.getModels();
        const customConfig = this.customProviderConfigs.get(provider.id);
        const factoryWireApi = this.getFactoryWireApi(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          modelCount: models.length,
          defaultBaseUrl: provider.baseUrl ?? models[0]?.baseUrl,
          supportsApiKey: Boolean(provider.auth.apiKey),
          supportsOAuth: Boolean(provider.auth.oauth),
          configured: factoryWireApi
            ? false
            : Boolean(await this.models.checkAuth(provider.id)),
          custom: Boolean(customConfig),
          factoryWireApi,
          wireApi: customConfig?.wireApi,
          apiKeyEnv: customConfig?.apiKeyEnv,
        };
      })
    );
  }

  listModels(providerId: string): ModelCatalogEntry[] {
    return this.models.getModels(providerId).map((model) => this.toCatalogEntry(model));
  }

  getModel(providerId: string, modelId: string): Model<Api> {
    let model = this.models.getModel(providerId, modelId);
    if (!model && providerId === OPENAI_COMPATIBLE_PROVIDER) {
      this.registerOpenAICompatibleModel(modelId);
      model = this.models.getModel(providerId, modelId);
    }
    if (!model && providerId === ANTHROPIC_COMPATIBLE_PROVIDER) {
      this.registerAnthropicCompatibleModel(modelId);
      model = this.models.getModel(providerId, modelId);
    }
    if (!model && this.customProviderConfigs.has(providerId)) {
      this.registerCustomProviderModel(providerId, modelId);
      model = this.models.getModel(providerId, modelId);
    }
    if (!model) {
      throw new Error(`Unknown pi-ai model: ${providerId}/${modelId}`);
    }
    return model;
  }

  resolveConfig(config: ModelConfig): Model<Api> {
    const model = this.getModel(config.provider, config.model);
    const overrides = config.overrides;
    return {
      ...model,
      ...(overrides?.baseUrl
        ? {
            baseUrl: normalizeProviderBaseUrl(model.api, overrides.baseUrl),
          }
        : {}),
      ...(overrides?.maxOutputTokens ? { maxTokens: overrides.maxOutputTokens } : {}),
    };
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    this.requireProvider(providerId);
    await this.credentials.modify(providerId, async () => ({
      type: 'api_key',
      key: apiKey,
    }));
  }

  async clearCredential(providerId: string): Promise<void> {
    this.requireProvider(providerId);
    await this.credentials.delete(providerId);
  }

  async isConfigured(providerId: string): Promise<boolean> {
    this.requireProvider(providerId);
    return Boolean(await this.models.checkAuth(providerId));
  }

  isReservedProviderId(providerId: string): boolean {
    return this.reservedProviderIds.has(providerId);
  }

  configureModelProviders(
    providers: Readonly<Record<string, ModelProviderConfig>>,
    models: readonly ModelConfig[]
  ): void {
    for (const providerId of this.customProviderConfigs.keys()) {
      this.models.deleteProvider(providerId);
    }
    this.customProviderConfigs.clear();
    this.customProviderModels.clear();

    for (const [providerId, config] of Object.entries(providers)) {
      const modelIds = models
        .filter((model) => model.provider === providerId)
        .map((model) => model.model);
      this.registerModelProvider(providerId, config, modelIds);
    }
  }

  registerModelProvider(
    providerId: string,
    config: ModelProviderConfig,
    modelIds: readonly string[] = []
  ): void {
    if (this.isReservedProviderId(providerId)) {
      throw new Error(
        `modelProviders.${providerId}: built-in provider ids cannot be overridden`
      );
    }
    const errors = validateModelProviderConfig(providerId, config);
    if (errors.length > 0) throw new Error(errors.join('; '));

    const normalizedConfig: ModelProviderConfig = {
      ...config,
      name: config.name.trim(),
      baseUrl: normalizeProviderBaseUrl(config.wireApi, config.baseUrl),
      ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv.trim() } : {}),
    };
    this.customProviderConfigs.set(providerId, normalizedConfig);
    const registered = new Map<string, Model<Api>>();
    for (const modelId of new Set(modelIds)) {
      const normalizedId = modelId.trim();
      if (!normalizedId) continue;
      registered.set(
        normalizedId,
        this.createCompatibleModel(
          providerId,
          normalizedId,
          normalizedConfig.wireApi,
          normalizedConfig.baseUrl
        )
      );
    }
    this.customProviderModels.set(providerId, registered);
    this.installCustomProvider(providerId);
  }

  unregisterModelProvider(providerId: string): void {
    if (!this.customProviderConfigs.has(providerId)) return;
    this.customProviderConfigs.delete(providerId);
    this.customProviderModels.delete(providerId);
    this.models.deleteProvider(providerId);
  }

  private requireProvider(providerId: string): void {
    if (!this.models.getProvider(providerId)) {
      throw new Error(`Unknown pi-ai provider: ${providerId}`);
    }
  }

  private registerOpenAICompatibleModel(modelId: string): void {
    const normalizedId = modelId.trim();
    if (!normalizedId) {
      throw new Error('OpenAI-compatible model ID must not be empty');
    }
    if (this.compatibleModels.has(normalizedId)) return;

    const model = this.createCompatibleModel(
      OPENAI_COMPATIBLE_PROVIDER,
      normalizedId,
      'openai-completions',
      OPENAI_COMPATIBLE_BASE_URL
    ) as Model<'openai-completions'>;
    this.compatibleModels.set(normalizedId, model);
    this.installOpenAICompatibleProvider();
  }

  private registerAnthropicCompatibleModel(modelId: string): void {
    const normalizedId = modelId.trim();
    if (!normalizedId) {
      throw new Error('Anthropic-compatible model ID must not be empty');
    }
    if (this.anthropicCompatibleModels.has(normalizedId)) return;
    const model = this.createCompatibleModel(
      ANTHROPIC_COMPATIBLE_PROVIDER,
      normalizedId,
      'anthropic-messages',
      ANTHROPIC_COMPATIBLE_BASE_URL
    ) as Model<'anthropic-messages'>;
    this.anthropicCompatibleModels.set(normalizedId, model);
    this.installAnthropicCompatibleProvider();
  }

  private registerCustomProviderModel(providerId: string, modelId: string): void {
    const normalizedId = modelId.trim();
    if (!normalizedId) {
      throw new Error('Custom provider model ID must not be empty');
    }
    const config = this.customProviderConfigs.get(providerId);
    const registered = this.customProviderModels.get(providerId);
    if (!config || !registered || registered.has(normalizedId)) return;
    registered.set(
      normalizedId,
      this.createCompatibleModel(
        providerId,
        normalizedId,
        config.wireApi,
        config.baseUrl
      )
    );
    this.installCustomProvider(providerId);
  }

  private createCompatibleModel(
    providerId: string,
    modelId: string,
    api: ModelProviderWireApi,
    baseUrl: string
  ): Model<Api> {
    const candidates = this.models
      .getModels()
      .filter(
        (model) =>
          model.provider !== providerId &&
          !this.customProviderConfigs.has(model.provider) &&
          model.id === modelId
      );
    const template =
      TEMPLATE_PROVIDER_PRIORITY.flatMap((provider) =>
        candidates.filter((candidate) => candidate.provider === provider)
      )[0] ?? candidates[0];
    return {
      id: modelId,
      name: template?.name ?? modelId,
      api,
      provider: providerId,
      baseUrl,
      reasoning: template?.reasoning ?? false,
      input: template ? [...template.input] : ['text'],
      cost: { ...ZERO_COST },
      contextWindow: template?.contextWindow ?? DEFAULT_CUSTOM_CONTEXT_WINDOW,
      maxTokens: template?.maxTokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
      ...(template?.thinkingLevelMap
        ? { thinkingLevelMap: { ...template.thinkingLevelMap } }
        : {}),
    };
  }

  private installOpenAICompatibleProvider(): void {
    this.models.setProvider(
      createProvider({
        id: OPENAI_COMPATIBLE_PROVIDER,
        name: 'Custom OpenAI Endpoint',
        baseUrl: OPENAI_COMPATIBLE_BASE_URL,
        auth: {
          apiKey: envApiKeyAuth('OpenAI-compatible API key', [
            'OPENAI_COMPATIBLE_API_KEY',
            'BLADE_API_KEY',
          ]),
        },
        models: [...this.compatibleModels.values()],
        api: openAICompletionsApi(),
      })
    );
  }

  private installAnthropicCompatibleProvider(): void {
    this.models.setProvider(
      createProvider({
        id: ANTHROPIC_COMPATIBLE_PROVIDER,
        name: 'Custom Anthropic Endpoint',
        baseUrl: ANTHROPIC_COMPATIBLE_BASE_URL,
        auth: {
          apiKey: envApiKeyAuth('Anthropic-compatible API key', [
            'ANTHROPIC_API_KEY',
            'BLADE_API_KEY',
          ]),
        },
        models: [...this.anthropicCompatibleModels.values()],
        api: anthropicMessagesApi(),
      })
    );
  }

  private installCustomProvider(providerId: string): void {
    const config = this.customProviderConfigs.get(providerId);
    const registered = this.customProviderModels.get(providerId);
    if (!config || !registered) return;
    const environmentVariables = config.apiKeyEnv ? [config.apiKeyEnv] : [];
    this.models.setProvider(
      createProvider({
        id: providerId,
        name: config.name,
        baseUrl: config.baseUrl,
        auth: {
          apiKey: envApiKeyAuth(`${config.name} API key`, environmentVariables),
        },
        models: [...registered.values()],
        api:
          config.wireApi === 'anthropic-messages'
            ? anthropicMessagesApi()
            : openAICompletionsApi(),
      })
    );
  }

  private getFactoryWireApi(providerId: string): ModelProviderWireApi | undefined {
    if (providerId === OPENAI_COMPATIBLE_PROVIDER) return 'openai-completions';
    if (providerId === ANTHROPIC_COMPATIBLE_PROVIDER) return 'anthropic-messages';
    return undefined;
  }

  private toCatalogEntry(model: Model<Api>): ModelCatalogEntry {
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      supportedReasoningEfforts: getSupportedThinkingLevels(model),
      supportedServiceTiers: getSupportedServiceTiers(model),
      supportedResponseVerbosities: getSupportedResponseVerbosities(model),
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: { ...model.cost },
    };
  }
}

let catalog: PiModelCatalog | undefined;

export function getPiModelCatalog(): PiModelCatalog {
  catalog ??= new PiModelCatalog();
  return catalog;
}

export function installPiModelCatalogForTests(next?: PiModelCatalog): void {
  catalog = next;
}
