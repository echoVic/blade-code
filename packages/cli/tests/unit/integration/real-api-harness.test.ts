import { describe, expect, it } from 'vitest';
import {
  buildRealApiConfig,
  parseHeadlessJsonl,
  redactSecrets,
} from '../../integration/real-api/codingTaskHarness.js';
import {
  buildRealApiRuntimeConfig,
  normalizeNewApiBaseURL,
  resolveModelSettings,
} from '../../integration/real-api/testConfig.js';

describe('real API coding-task harness', () => {
  it('parses versioned JSONL events and reports malformed lines', () => {
    const parsed = parseHeadlessJsonl(
      [
        JSON.stringify({
          event_version: 1,
          type: 'tool_start',
          tool_name: 'Read',
          summary: 'Read src/math.js',
        }),
        'diagnostic line',
        JSON.stringify({ event_version: 1, type: 'content', content: 'done' }),
      ].join('\n')
    );

    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]?.type).toBe('tool_start');
    expect(parsed.nonJsonLines).toEqual(['diagnostic line']);
  });

  it('builds a project config that keeps the API key outside the file', () => {
    expect(
      buildRealApiConfig({
        modelId: 'deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com',
      })
    ).toMatchObject({
      currentModelId: 'deepseek-v4-flash',
      models: [
        expect.objectContaining({
          apiKey: '${BLADE_API_KEY}',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          provider: 'deepseek',
        }),
      ],
    });
  });

  it('allows a real CLI trajectory to exercise a constrained context window', () => {
    expect(
      buildRealApiConfig({
        modelId: 'deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com',
        maxContextTokens: 24_000,
        maxOutputTokens: 1_024,
      })
    ).toMatchObject({
      models: [
        expect.objectContaining({
          maxContextTokens: 24_000,
          maxOutputTokens: 1_024,
        }),
      ],
    });
  });

  it('redacts provider keys from output without changing unrelated text', () => {
    expect(redactSecrets('key=sk-secret-value; status=ok', ['sk-secret-value'])).toBe(
      'key=[REDACTED]; status=ok'
    );
  });

  it('treats explicit provider credentials as a complete model allowlist', () => {
    const personalModel = {
      id: 'personal-proxy',
      provider: 'openai-compatible',
      model: 'deepseek-v4-pro',
      apiKey: 'personal-secret',
      baseUrl: 'https://personal-proxy.invalid/v1',
    };

    expect(
      resolveModelSettings(
        'domestic',
        'DOMESTIC',
        'qwen-plus',
        'https://default.invalid',
        { DEEPSEEK_API_KEY: 'explicit-secret' },
        personalModel
      )
    ).toEqual({
      apiKey: '',
      baseURL: 'https://default.invalid',
      model: 'qwen-plus',
    });
  });

  it('normalizes NewAPI channel roots without duplicating the API version', () => {
    expect(normalizeNewApiBaseURL('https://callapi8.com')).toBe(
      'https://callapi8.com/v1'
    );
    expect(normalizeNewApiBaseURL(' `https://callapi8.com/` ')).toBe(
      'https://callapi8.com/v1'
    );
    expect(normalizeNewApiBaseURL('https://callapi8.com/v1')).toBe(
      'https://callapi8.com/v1'
    );
  });

  it('builds an isolated runtime config with only the selected real API model', () => {
    const runtimeConfig = buildRealApiRuntimeConfig({
      id: 'deepseek',
      name: 'DeepSeek',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      apiKey: 'explicit-secret',
      baseURL: 'https://api.deepseek.com',
      createModel: () => ({}) as never,
    });

    expect(runtimeConfig.currentModelId).toBe('real-api-deepseek');
    expect(runtimeConfig.models).toEqual([
      expect.objectContaining({
        id: 'real-api-deepseek',
        apiKey: 'explicit-secret',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
      }),
    ]);
  });
});
