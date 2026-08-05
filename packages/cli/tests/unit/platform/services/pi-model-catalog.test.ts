import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { PiModelCatalog } from '../../../../src/services/pi/PiModelCatalog.js';

describe('PiModelCatalog', () => {
  it('exposes provider and model metadata from pi-ai', async () => {
    const catalog = new PiModelCatalog(new InMemoryCredentialStore());
    const providers = await catalog.listProviders();
    const deepseek = providers.find((provider) => provider.id === 'deepseek');
    const models = catalog.listModels('deepseek');

    expect(deepseek).toMatchObject({
      id: 'deepseek',
      modelCount: expect.any(Number),
      supportsApiKey: true,
      configured: false,
    });
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'deepseek-v4-pro',
          provider: 'deepseek',
          contextWindow: expect.any(Number),
        }),
      ])
    );
  });

  it('stores provider credentials independently from model config', async () => {
    const catalog = new PiModelCatalog(new InMemoryCredentialStore());
    await catalog.setApiKey('deepseek', 'test-key');

    expect(await catalog.isConfigured('deepseek')).toBe(true);
    expect(await catalog.credentials.read('deepseek')).toEqual({
      type: 'api_key',
      key: 'test-key',
    });
  });

  it('resolves config overrides without duplicating model metadata', () => {
    const catalog = new PiModelCatalog(new InMemoryCredentialStore());
    const model = catalog.resolveConfig({
      id: 'primary',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      overrides: {
        baseUrl: 'https://gateway.example/v1',
        maxOutputTokens: 2048,
      },
    });

    expect(model.baseUrl).toBe('https://gateway.example/v1');
    expect(model.maxTokens).toBe(2048);
    expect(model.contextWindow).toBeGreaterThan(0);
  });
});
