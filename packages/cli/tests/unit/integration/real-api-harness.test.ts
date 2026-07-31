import { describe, expect, it } from 'vitest';
import {
  buildRealApiConfig,
  parseHeadlessJsonl,
  redactSecrets,
} from '../../integration/real-api/codingTaskHarness.js';

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

  it('redacts provider keys from output without changing unrelated text', () => {
    expect(redactSecrets('key=sk-secret-value; status=ok', ['sk-secret-value'])).toBe(
      'key=[REDACTED]; status=ok'
    );
  });
});
