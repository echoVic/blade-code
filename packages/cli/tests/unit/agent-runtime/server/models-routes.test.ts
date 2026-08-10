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
      thinkingLevelMap: {
        off: null,
        xhigh: 'xhigh',
        max: null,
      },
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
      supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      supportedServiceTiers: ['standard', 'fast', 'flex'],
      supportedResponseVerbosities: [],
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

  it('projects communication style summaries without prompt or host paths', () => {
    const config = {
      id: 'gpt',
      provider: 'openai',
      model: 'gpt-5',
    } as ModelConfig;
    const runtimeModel = {
      id: 'gpt-5',
      name: 'GPT-5',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_000,
    } satisfies Model<Api>;
    const projected = projectModelConfig(config, runtimeModel, [
      {
        id: 'project:strict',
        name: 'Strict',
        description: 'Strict project communication',
        source: 'project',
        contentSha256: 'a'.repeat(64),
      },
    ]);

    expect(projected.communicationStyles).toEqual([
      expect.objectContaining({
        id: 'project:strict',
        contentSha256: 'a'.repeat(64),
      }),
    ]);
    expect(JSON.stringify(projected)).not.toContain('CUSTOM_STYLE_MARKER');
    expect(JSON.stringify(projected)).not.toContain('/Users/');
  });

  it('rejects a stream watchdog value that would cause a retry storm', () => {
    expect(() =>
      createModelUpdates({
        overrides: { streamIdleTimeout: 999 },
      })
    ).toThrow('streamIdleTimeout must be at least 1000ms');
  });
});
