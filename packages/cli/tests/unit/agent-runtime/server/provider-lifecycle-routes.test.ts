import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import {
  installPiModelCatalogForTests,
  PiModelCatalog,
} from '../../../../src/services/pi/PiModelCatalog.js';

const mocks = vi.hoisted(() => ({
  updateModelProvider: vi.fn(),
  removeModelProvider: vi.fn(),
  getConfig: vi.fn(),
  probeModelProvider: vi.fn(),
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  configActions: () => ({
    updateModelProvider: mocks.updateModelProvider,
    removeModelProvider: mocks.removeModelProvider,
  }),
  getConfig: mocks.getConfig,
}));

vi.mock('../../../../src/services/ProviderHealthService.js', () => ({
  probeModelProvider: mocks.probeModelProvider,
}));

import { ProviderRoutes } from '../../../../src/server/routes/provider.js';

describe('ProviderRoutes lifecycle', () => {
  let catalog: PiModelCatalog;

  beforeEach(async () => {
    mocks.updateModelProvider.mockReset();
    mocks.removeModelProvider.mockReset();
    mocks.probeModelProvider.mockReset();
    mocks.getConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      currentModelId: 'custom-model',
      modelProviders: {
        'team-gateway': {
          name: 'Team Gateway',
          baseUrl: 'https://old.example.test/v1',
          wireApi: 'openai-completions',
          apiKeyEnv: 'TEAM_GATEWAY_API_KEY',
        },
      },
      models: [
        {
          id: 'custom-model',
          provider: 'team-gateway',
          model: 'vendor-model',
        },
      ],
    });
    mocks.updateModelProvider.mockResolvedValue(undefined);
    mocks.removeModelProvider.mockResolvedValue({
      removedModelIds: ['custom-model'],
    });
    mocks.probeModelProvider.mockResolvedValue({
      ok: true,
      providerId: 'team-gateway',
      modelConfigId: 'custom-model',
      model: 'vendor-model',
      wireApi: 'openai-completions',
      latencyMs: 12,
      code: 'ok',
      message: 'Provider responded successfully.',
    });
    catalog = new PiModelCatalog(new InMemoryCredentialStore());
    catalog.registerModelProvider(
      'team-gateway',
      {
        name: 'Team Gateway',
        baseUrl: 'https://old.example.test/v1',
        wireApi: 'openai-completions',
        apiKeyEnv: 'TEAM_GATEWAY_API_KEY',
      },
      ['vendor-model']
    );
    await catalog.setApiKey('team-gateway', 'old-key');
    installPiModelCatalogForTests(catalog);
  });

  afterEach(() => {
    installPiModelCatalogForTests(undefined);
  });

  it('updates a channel and rotates its credential without returning it', async () => {
    const response = await ProviderRoutes().request('/team-gateway', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Updated Gateway',
        baseUrl: 'https://new.example.test/v1',
        wireApi: 'openai-completions',
        apiKey: 'new-key',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('new-key');
    expect(mocks.updateModelProvider).toHaveBeenCalledWith('team-gateway', {
      name: 'Updated Gateway',
      baseUrl: 'https://new.example.test/v1',
      wireApi: 'openai-completions',
      apiKeyEnv: 'TEAM_GATEWAY_API_KEY',
    });
    expect(await catalog.credentials.read('team-gateway')).toEqual({
      type: 'api_key',
      key: 'new-key',
    });
  });

  it('restores the previous credential when channel persistence fails', async () => {
    mocks.updateModelProvider.mockRejectedValueOnce(
      new Error('simulated persistence failure')
    );
    const response = await ProviderRoutes().request('/team-gateway', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Updated Gateway',
        baseUrl: 'https://new.example.test/v1',
        wireApi: 'openai-completions',
        apiKey: 'new-key',
      }),
    });

    expect(response.status).toBe(500);
    expect(await catalog.credentials.read('team-gateway')).toEqual({
      type: 'api_key',
      key: 'old-key',
    });
  });

  it('requires explicit cascading and delegates provider deletion', async () => {
    const response = await ProviderRoutes().request('/team-gateway?removeModels=true', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(mocks.removeModelProvider).toHaveBeenCalledWith('team-gateway', {
      removeModels: true,
    });
    expect(await response.json()).toEqual({
      success: true,
      removedModelIds: ['custom-model'],
    });
  });

  it('probes only a model owned by the requested provider', async () => {
    const response = await ProviderRoutes().request('/team-gateway/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'custom-model' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.probeModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'custom-model',
        provider: 'team-gateway',
      }),
      expect.objectContaining({
        currentModelId: 'custom-model',
      })
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      code: 'ok',
      latencyMs: 12,
    });
  });

  it('rejects a probe model owned by another provider', async () => {
    const response = await ProviderRoutes().request('/team-gateway/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'different-model' }),
    });

    expect(response.status).toBe(500);
    expect(mocks.probeModelProvider).not.toHaveBeenCalled();
  });
});
