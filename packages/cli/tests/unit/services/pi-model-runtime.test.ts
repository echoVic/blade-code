import { describe, expect, it } from 'vitest';
import type { ChatConfig } from '../../../src/services/ChatServiceInterface.js';
import { createPiRuntime } from '../../../src/services/pi/modelRuntime.js';
import {
  getModelApiKeyEnvironmentVariable,
  resolveModelConfig,
} from '../../../src/services/pi/resolveModelConfig.js';

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

  it('avoids duplicating the Anthropic API version behind a gateway', () => {
    const runtime = createPiRuntime(
      config({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        baseUrl: 'https://gateway.example.test/v1/',
      })
    );

    expect(runtime.model).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://gateway.example.test',
    });
  });

  it('creates arbitrary OpenAI-compatible models through the shared catalog', () => {
    const runtime = createPiRuntime(
      config({
        provider: 'openai-compatible',
        model: 'qwen-custom-model',
        baseUrl: 'https://gateway.example.test/v1/',
      })
    );

    expect(runtime.model).toMatchObject({
      provider: 'openai-compatible',
      api: 'openai-completions',
      id: 'qwen-custom-model',
      baseUrl: 'https://gateway.example.test/v1',
      contextWindow: 128_000,
    });
  });

  it('forwards the model stream watchdog override into the shared chat config', () => {
    const resolved = resolveModelConfig(
      {
        id: 'deepseek',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        overrides: { streamIdleTimeout: 120_000 },
      },
      { temperature: 0, timeout: 180_000 },
      'off'
    );

    expect(resolved.chat).toMatchObject({
      timeout: 180_000,
      streamIdleTimeout: 120_000,
    });
  });

  it('freezes Provider circuit and admission policy into chat config', () => {
    const resolved = resolveModelConfig(
      {
        id: 'deepseek',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      },
      {
        temperature: 0,
        timeout: 180_000,
        providerCircuitBreakerOpenMs: 20_000,
        providerRequestConcurrency: 6,
        providerRequestAdmissionMs: 120_000,
        providerRequestPendingBytes: 8 * 1024 * 1024,
      },
      'off'
    );

    expect(resolved.chat.providerCircuitBreakerOpenMs).toBe(20_000);
    expect(resolved.chat.providerRequestConcurrency).toBe(6);
    expect(resolved.chat.providerRequestAdmissionMs).toBe(120_000);
    expect(resolved.chat.providerRequestPendingBytes).toBe(8 * 1024 * 1024);
  });

  it('isolates injected credentials by model config ID', () => {
    const firstName = getModelApiKeyEnvironmentVariable('first-model');
    const secondName = getModelApiKeyEnvironmentVariable('second-model');
    const originalFirst = process.env[firstName];
    const originalGlobal = process.env.BLADE_API_KEY;

    try {
      process.env[firstName] = 'model-scoped-key';
      process.env.BLADE_API_KEY = 'global-key';
      const resolved = resolveModelConfig(
        {
          id: 'first-model',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
        },
        { temperature: 0, timeout: 180_000 },
        'off'
      );

      expect(firstName).toMatch(/^BLADE_MODEL_API_KEY_[A-F0-9]{32}$/);
      expect(secondName).not.toBe(firstName);
      expect(resolved.chat.apiKey).toBe('model-scoped-key');
    } finally {
      if (originalFirst === undefined) delete process.env[firstName];
      else process.env[firstName] = originalFirst;
      if (originalGlobal === undefined) delete process.env.BLADE_API_KEY;
      else process.env.BLADE_API_KEY = originalGlobal;
    }
  });
});
