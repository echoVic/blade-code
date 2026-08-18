import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { derivePromptCacheMetrics } from '../../../src/api/promptCacheMetrics.js';
import type { ChatRequestOptions } from '../../../src/services/ChatServiceInterface.js';
import { PiAIChatService } from '../../../src/services/PiAIChatService.js';
import {
  getModelConfig,
  isRealApiTestEnabled,
  type TestModelConfig,
} from './testConfig.js';

const gpt = getModelConfig('gpt');
const enabled = isRealApiTestEnabled() && Boolean(gpt.apiKey);

function createCacheService(config: TestModelConfig): PiAIChatService {
  return new PiAIChatService({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseURL ?? '',
    maxOutputTokens: 32,
    temperature: 0,
    timeout: 270_000,
    maxRetries: 0,
    enablePromptCaching: true,
  });
}

describe.skipIf(!enabled)('Prompt cache efficiency (Real API)', () => {
  it('reads a warmed stable prefix from Provider cache', async () => {
    const service = createCacheService(gpt);
    const sessionId = `prompt-cache-${randomUUID()}`;
    const requestOptions: ChatRequestOptions = {
      providerSessionId: sessionId,
      providerAdmission: {
        sessionId,
        ownerId: sessionId,
        requestClass: 'internal',
      },
    };
    const stablePrefix = [
      `Qualification nonce: ${sessionId}`,
      ...Array.from(
        { length: 120 },
        () =>
          'Blade prompt cache qualification stable prefix. Keep every byte unchanged across requests.'
      ),
    ].join('\n');
    const firstMessages = [
      { role: 'system' as const, content: stablePrefix },
      { role: 'user' as const, content: 'Reply with exactly FIRST.' },
    ];

    const observations: Array<{
      promptTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      hitRate?: number;
    }> = [];

    for (let request = 0; request < 4; request++) {
      if (request > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      const response = await service.chat(
        firstMessages,
        undefined,
        undefined,
        requestOptions
      );
      const metrics = derivePromptCacheMetrics({
        totalInputTokens: response.usage?.promptTokens ?? 0,
        cacheReadTokens: response.usage?.cacheReadInputTokens ?? 0,
        cacheWriteTokens: response.usage?.cacheCreationInputTokens ?? 0,
      });
      expect(response.content.toUpperCase()).toContain('FIRST');
      expect(metrics.totalInputTokens).toBeGreaterThan(0);
      observations.push({
        promptTokens: metrics.totalInputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheWriteTokens: metrics.cacheWriteTokens,
        hitRate: metrics.hitRate,
      });
      if (metrics.cacheReadTokens > 0) break;
    }

    const warmRead = observations.find(
      (observation, index) => index > 0 && observation.cacheReadTokens > 0
    );
    expect(
      warmRead?.cacheReadTokens ?? 0,
      `Provider cache did not become readable: ${JSON.stringify(observations)}`
    ).toBeGreaterThan(0);
    expect(warmRead?.hitRate).toBeGreaterThan(0);
    expect(warmRead?.hitRate).toBeLessThanOrEqual(1);
  }, 300_000);
});
