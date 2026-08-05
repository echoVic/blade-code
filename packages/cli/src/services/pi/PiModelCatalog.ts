import {
  type Api,
  createModels,
  type CredentialStore,
  type Model,
  type MutableModels,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ModelConfig } from '../../config/types.js';
import { FileCredentialStore } from './FileCredentialStore.js';
import type { ModelCatalogEntry, ProviderCatalogEntry } from './catalogTypes.js';

export class PiModelCatalog {
  readonly credentials: CredentialStore;
  readonly models: MutableModels;

  constructor(credentials: CredentialStore = new FileCredentialStore()) {
    this.credentials = credentials;
    this.models = createModels({ credentials });
    for (const provider of builtinProviders()) {
      this.models.setProvider(provider);
    }
  }

  async listProviders(): Promise<ProviderCatalogEntry[]> {
    return Promise.all(
      this.models.getProviders().map(async (provider) => {
        const models = provider.getModels();
        return {
          id: provider.id,
          name: provider.name,
          modelCount: models.length,
          defaultBaseUrl: provider.baseUrl ?? models[0]?.baseUrl,
          supportsApiKey: Boolean(provider.auth.apiKey),
          supportsOAuth: Boolean(provider.auth.oauth),
          configured: Boolean(await this.models.checkAuth(provider.id)),
        };
      })
    );
  }

  listModels(providerId: string): ModelCatalogEntry[] {
    return this.models.getModels(providerId).map((model) => this.toCatalogEntry(model));
  }

  getModel(providerId: string, modelId: string): Model<Api> {
    const model = this.models.getModel(providerId, modelId);
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
      ...(overrides?.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
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

  private requireProvider(providerId: string): void {
    if (!this.models.getProvider(providerId)) {
      throw new Error(`Unknown pi-ai provider: ${providerId}`);
    }
  }

  private toCatalogEntry(model: Model<Api>): ModelCatalogEntry {
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
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
