import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import {
  installPiModelCatalogForTests,
  PiModelCatalog,
} from '../../../../src/services/pi/PiModelCatalog.js';

const mocks = vi.hoisted(() => ({
  addModel: vi.fn(),
  addModelWithProvider: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  configActions: () => ({
    addModel: mocks.addModel,
    addModelWithProvider: mocks.addModelWithProvider,
  }),
  getAllModels: () => [],
  getConfig: mocks.getConfig,
  getCurrentModel: () => undefined,
  getModelById: () => undefined,
}));

import { ModelsRoutes } from '../../../../src/server/routes/models.js';

describe('ModelsRoutes custom provider channels', () => {
  let catalog: PiModelCatalog;

  beforeEach(() => {
    mocks.addModel.mockReset();
    mocks.addModelWithProvider.mockReset();
    mocks.getConfig.mockReturnValue(DEFAULT_CONFIG);
    mocks.addModelWithProvider.mockResolvedValue({
      id: 'model-config',
      provider: 'team-gateway',
      model: 'vendor-model',
    });
    catalog = new PiModelCatalog(new InMemoryCredentialStore());
    installPiModelCatalogForTests(catalog);
  });

  afterEach(() => {
    installPiModelCatalogForTests(undefined);
  });

  it('creates the channel and stores its credential under the channel id', async () => {
    const app = ModelsRoutes();
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'team-gateway',
        model: 'vendor-model',
        displayName: 'Vendor Model',
        apiKey: 'channel-secret',
        modelProvider: {
          id: 'team-gateway',
          name: 'Team Gateway',
          baseUrl: 'https://gateway.example.test/v1',
          wireApi: 'openai-completions',
        },
      }),
    });
    const body = new TextDecoder().decode(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(body).not.toContain('channel-secret');
    expect(mocks.addModelWithProvider).toHaveBeenCalledWith(
      {
        provider: 'team-gateway',
        model: 'vendor-model',
        displayName: 'Vendor Model',
        overrides: undefined,
      },
      {
        name: 'Team Gateway',
        baseUrl: 'https://gateway.example.test/v1',
        wireApi: 'openai-completions',
      }
    );
    expect(await catalog.credentials.read('team-gateway')).toEqual({
      type: 'api_key',
      key: 'channel-secret',
    });
  });

  it('rolls back a channel credential when config persistence fails', async () => {
    mocks.addModelWithProvider.mockRejectedValueOnce(
      new Error('simulated persistence failure')
    );
    const response = await ModelsRoutes().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'failed-gateway',
        model: 'vendor-model',
        apiKey: 'channel-secret',
        modelProvider: {
          id: 'failed-gateway',
          name: 'Failed Gateway',
          baseUrl: 'https://gateway.example.test/v1',
          wireApi: 'openai-completions',
        },
      }),
    });

    expect(response.status).toBe(500);
    expect(await catalog.credentials.read('failed-gateway')).toBeUndefined();
    expect(
      (await catalog.listProviders()).some(
        (provider) => provider.id === 'failed-gateway'
      )
    ).toBe(false);
  });
});
