import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import {
  installPiModelCatalogForTests,
  PiModelCatalog,
} from '../../../../src/services/pi/PiModelCatalog.js';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
}));

vi.mock('../../../../src/config/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/config/index.js')
  >('../../../../src/config/index.js');
  return {
    ...actual,
    getConfigService: () => ({
      save: mocks.save,
      flush: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

import { configActions, getConfig, getState } from '../../../../src/store/vanilla.js';

describe('custom provider lifecycle store actions', () => {
  let catalog: PiModelCatalog;

  beforeEach(async () => {
    mocks.save.mockReset();
    mocks.save.mockResolvedValue(undefined);
    catalog = new PiModelCatalog(new InMemoryCredentialStore());
    installPiModelCatalogForTests(catalog);
    getState().config.actions.setConfig({
      ...DEFAULT_CONFIG,
      currentModelId: 'custom-model',
      modelProviders: {
        'team-gateway': {
          name: 'Team Gateway',
          baseUrl: 'https://old.example.test/v1',
          wireApi: 'openai-completions',
        },
      },
      models: [
        {
          id: 'custom-model',
          provider: 'team-gateway',
          model: 'vendor-model',
        },
        {
          id: 'deepseek-model',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          fallbackModels: [
            {
              provider: 'team-gateway',
              model: 'vendor-model',
            },
          ],
        },
      ],
    });
    await catalog.setApiKey('team-gateway', 'stored-channel-key');
  });

  afterEach(() => {
    getState().config.actions.setConfig({ ...DEFAULT_CONFIG });
    installPiModelCatalogForTests(undefined);
  });

  it('updates a provider and rebuilds all referenced runtime models', async () => {
    await configActions().updateModelProvider('team-gateway', {
      name: 'Updated Gateway',
      baseUrl: 'https://new.example.test/v1/',
      wireApi: 'openai-completions',
    });

    expect(getConfig()?.modelProviders['team-gateway']).toEqual({
      name: 'Updated Gateway',
      baseUrl: 'https://new.example.test/v1/',
      wireApi: 'openai-completions',
    });
    expect(catalog.getModel('team-gateway', 'vendor-model')).toMatchObject({
      provider: 'team-gateway',
      baseUrl: 'https://new.example.test/v1',
    });
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProviders: expect.objectContaining({
          'team-gateway': expect.objectContaining({
            name: 'Updated Gateway',
          }),
        }),
      }),
      expect.objectContaining({ immediate: true })
    );
  });

  it('rejects deletion while direct or fallback references remain', async () => {
    await expect(configActions().removeModelProvider('team-gateway')).rejects.toThrow(
      'still referenced by 1 model(s) and 1 fallback configuration(s)'
    );

    expect(getConfig()?.modelProviders['team-gateway']).toBeDefined();
    expect(await catalog.credentials.read('team-gateway')).toBeDefined();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('cascades models, fallback references, current selection, and credentials', async () => {
    const result = await configActions().removeModelProvider('team-gateway', {
      removeModels: true,
    });

    expect(result).toEqual({ removedModelIds: ['custom-model'] });
    expect(getConfig()).toMatchObject({
      currentModelId: 'deepseek-model',
      modelProviders: {},
      models: [
        {
          id: 'deepseek-model',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
        },
      ],
    });
    expect(getConfig()?.models[0]).not.toHaveProperty('fallbackModels');
    expect(await catalog.credentials.read('team-gateway')).toBeUndefined();
    expect(catalog.models.getProvider('team-gateway')).toBeUndefined();
  });

  it('restores config and credentials when destructive persistence fails', async () => {
    mocks.save.mockRejectedValueOnce(new Error('simulated disk failure'));

    await expect(
      configActions().removeModelProvider('team-gateway', {
        removeModels: true,
      })
    ).rejects.toThrow('simulated disk failure');

    expect(getConfig()?.modelProviders['team-gateway']).toBeDefined();
    expect(getConfig()?.models.map((model) => model.id)).toEqual([
      'custom-model',
      'deepseek-model',
    ]);
    expect(await catalog.credentials.read('team-gateway')).toEqual({
      type: 'api_key',
      key: 'stored-channel-key',
    });
  });

  it('refuses a cascade that would leave Blade without a model', async () => {
    getState().config.actions.setConfig({
      ...DEFAULT_CONFIG,
      currentModelId: 'custom-model',
      modelProviders: getConfig()?.modelProviders ?? {},
      models: [
        {
          id: 'custom-model',
          provider: 'team-gateway',
          model: 'vendor-model',
        },
      ],
    });

    await expect(
      configActions().removeModelProvider('team-gateway', {
        removeModels: true,
      })
    ).rejects.toThrow('only model');
    expect(await catalog.credentials.read('team-gateway')).toBeDefined();
  });
});
