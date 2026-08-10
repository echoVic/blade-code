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

  it('registers arbitrary OpenAI-compatible model IDs on demand', async () => {
    const catalog = new PiModelCatalog(new InMemoryCredentialStore());
    const custom = catalog.resolveConfig({
      id: 'custom',
      provider: 'openai-compatible',
      model: 'vendor-model-not-in-catalog',
      overrides: {
        baseUrl: 'https://gateway.example/v1/',
        maxOutputTokens: 4096,
      },
    });

    expect(custom).toMatchObject({
      id: 'vendor-model-not-in-catalog',
      name: 'vendor-model-not-in-catalog',
      provider: 'openai-compatible',
      api: 'openai-completions',
      baseUrl: 'https://gateway.example/v1',
      reasoning: false,
      input: ['text'],
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
    expect(catalog.listModels('openai-compatible')).toEqual([
      expect.objectContaining({
        id: 'vendor-model-not-in-catalog',
        api: 'openai-completions',
      }),
    ]);

    await catalog.setApiKey('openai-compatible', 'custom-key');
    expect(await catalog.isConfigured('openai-compatible')).toBe(true);
  });

  it('reuses safe metadata for a known model behind an OpenAI-compatible gateway', () => {
    const catalog = new PiModelCatalog(new InMemoryCredentialStore());
    const model = catalog.getModel('openai-compatible', 'gpt-5.5');

    expect(model).toMatchObject({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      provider: 'openai-compatible',
      api: 'openai-completions',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 272_000,
    });
    expect(model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('registers independent custom provider channels for the same wire API', async () => {
    const credentials = new InMemoryCredentialStore();
    const catalog = new PiModelCatalog(credentials);
    catalog.configureModelProviders(
      {
        'gateway-gpt': {
          name: 'Gateway GPT',
          baseUrl: 'https://gpt.example.test/v1/',
          wireApi: 'openai-completions',
        },
        'gateway-qwen': {
          name: 'Gateway Qwen',
          baseUrl: 'https://qwen.example.test/v1',
          wireApi: 'openai-completions',
        },
      },
      [
        {
          id: 'gpt',
          provider: 'gateway-gpt',
          model: 'gpt-5.5',
        },
        {
          id: 'qwen',
          provider: 'gateway-qwen',
          model: 'qwen-plus',
        },
      ]
    );
    await catalog.setApiKey('gateway-gpt', 'gpt-key');
    await catalog.setApiKey('gateway-qwen', 'qwen-key');

    expect(catalog.getModel('gateway-gpt', 'gpt-5.5')).toMatchObject({
      provider: 'gateway-gpt',
      api: 'openai-completions',
      baseUrl: 'https://gpt.example.test/v1',
    });
    expect(catalog.getModel('gateway-qwen', 'qwen-plus')).toMatchObject({
      provider: 'gateway-qwen',
      api: 'openai-completions',
      baseUrl: 'https://qwen.example.test/v1',
    });
    expect(await credentials.read('gateway-gpt')).toEqual({
      type: 'api_key',
      key: 'gpt-key',
    });
    expect(await credentials.read('gateway-qwen')).toEqual({
      type: 'api_key',
      key: 'qwen-key',
    });
  });

  it('supports Anthropic Messages custom channels without changing model ids', () => {
    const catalog = new PiModelCatalog(new InMemoryCredentialStore());
    catalog.configureModelProviders(
      {
        'claude-gateway': {
          name: 'Claude Gateway',
          baseUrl: 'https://claude.example.test/v1',
          wireApi: 'anthropic-messages',
        },
      },
      [
        {
          id: 'claude',
          provider: 'claude-gateway',
          model: 'claude-opus-4-8',
        },
      ]
    );

    expect(catalog.getModel('claude-gateway', 'claude-opus-4-8')).toMatchObject({
      provider: 'claude-gateway',
      api: 'anthropic-messages',
      baseUrl: 'https://claude.example.test',
    });
  });

  it('rejects custom channels that shadow built-in providers', () => {
    const catalog = new PiModelCatalog(new InMemoryCredentialStore());

    expect(() =>
      catalog.registerModelProvider('deepseek', {
        name: 'Shadow',
        baseUrl: 'https://example.test/v1',
        wireApi: 'openai-completions',
      })
    ).toThrow('built-in provider ids cannot be overridden');
  });

  it('does not let a global Blade key collapse custom channel isolation', async () => {
    const originalGlobal = process.env.BLADE_API_KEY;
    const originalChannel = process.env.BLADE_TEST_CHANNEL_API_KEY;
    process.env.BLADE_API_KEY = 'global-key-must-not-apply';
    process.env.BLADE_TEST_CHANNEL_API_KEY = 'channel-key';
    try {
      const catalog = new PiModelCatalog(new InMemoryCredentialStore());
      catalog.configureModelProviders(
        {
          isolated: {
            name: 'Isolated',
            baseUrl: 'https://isolated.example.test/v1',
            wireApi: 'openai-completions',
          },
          explicit: {
            name: 'Explicit',
            baseUrl: 'https://explicit.example.test/v1',
            wireApi: 'openai-completions',
            apiKeyEnv: 'BLADE_TEST_CHANNEL_API_KEY',
          },
        },
        []
      );

      expect(await catalog.isConfigured('isolated')).toBe(false);
      expect(await catalog.isConfigured('explicit')).toBe(true);
    } finally {
      if (originalGlobal === undefined) delete process.env.BLADE_API_KEY;
      else process.env.BLADE_API_KEY = originalGlobal;
      if (originalChannel === undefined) {
        delete process.env.BLADE_TEST_CHANNEL_API_KEY;
      } else {
        process.env.BLADE_TEST_CHANNEL_API_KEY = originalChannel;
      }
    }
  });
});
