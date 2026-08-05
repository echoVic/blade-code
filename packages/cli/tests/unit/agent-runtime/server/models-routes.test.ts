import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../../../src/config/types.js';
import {
  createModelUpdates,
  projectModelConfig,
} from '../../../../src/server/routes/models.js';

describe('ModelsRoutes', () => {
  it('never exposes credentials or legacy model fields', () => {
    const config = {
      id: 'deepseek',
      displayName: 'DeepSeek',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      apiKey: 'secret',
      baseUrl: 'https://legacy.example.test',
      maxContextTokens: 128_000,
    } as unknown as ModelConfig;
    const runtimeModel = {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      api: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    } satisfies Model<Api>;

    const projected = projectModelConfig(config, runtimeModel);
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('legacy.example.test');
    expect(serialized).not.toContain('maxContextTokens');
    expect(projected).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    });
  });

  it('preserves the model reference when an edit omits model', () => {
    const updates = createModelUpdates({
      displayName: 'Edited alias',
      overrides: { baseUrl: 'https://example.test/v1' },
    });

    expect(updates).toEqual({
      displayName: 'Edited alias',
      overrides: { baseUrl: 'https://example.test/v1' },
    });
    expect(updates).not.toHaveProperty('model');
  });
});
