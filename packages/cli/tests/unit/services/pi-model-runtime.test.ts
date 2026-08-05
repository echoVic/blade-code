import { describe, expect, it } from 'vitest';
import type { ChatConfig } from '../../../src/services/ChatServiceInterface.js';
import { createPiRuntime } from '../../../src/services/pi/modelRuntime.js';

function config(overrides: Partial<ChatConfig>): ChatConfig {
  return {
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: '',
    model: 'gpt-5-mini',
    ...overrides,
  };
}

describe('pi model runtime', () => {
  it('uses the built-in native provider protocol', () => {
    const runtime = createPiRuntime(
      config({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    );

    expect(runtime.model).toMatchObject({
      provider: 'deepseek',
      api: 'openai-completions',
      id: 'deepseek-v4-flash',
    });
  });

  it('applies endpoint overrides without changing the pi provider protocol', () => {
    const runtime = createPiRuntime(
      config({
        provider: 'google',
        model: 'gemini-2.5-flash',
        baseUrl: 'https://gateway.example.test/v1',
      })
    );

    expect(runtime.model).toMatchObject({
      provider: 'google',
      api: 'google-generative-ai',
      baseUrl: 'https://gateway.example.test/v1',
    });
  });

  it('uses the native Google protocol for official endpoints', () => {
    const runtime = createPiRuntime(
      config({
        provider: 'google',
        model: 'gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      })
    );

    expect(runtime.model.api).toBe('google-generative-ai');
  });
});
