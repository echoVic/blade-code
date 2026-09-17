import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../../src/config/types.js';
import type { StreamChunk } from '../../../src/services/ChatServiceInterface.js';
import { PiAIChatService } from '../../../src/services/PiAIChatService.js';
import { ProviderCircuitRegistry } from '../../../src/services/pi/providerCircuitBreaker.js';
import { ProviderRequestAdmissionScheduler } from '../../../src/services/pi/providerRequestAdmission.js';
import {
  getModelApiKeyEnvironmentVariable,
  resolveModelConfig,
} from '../../../src/services/pi/resolveModelConfig.js';
import { isRealApiTestEnabled, resolveForkQualificationModels } from './testConfig.js';

const models = resolveForkQualificationModels();
const claude = models.find((model) => model.id === 'claude');
const deepseek = models.find((model) => model.id === 'deepseek');

describe.skipIf(!isRealApiTestEnabled())(
  'cross-provider fallback trajectory (real API)',
  () => {
    it.skipIf(!claude || !deepseek)(
      'moves a pre-output Claude timeout to an independently authenticated DeepSeek channel',
      async () => {
        if (!claude || !deepseek) {
          throw new Error('Claude and DeepSeek models are required');
        }

        const primaryId = 'real-claude-primary';
        const fallbackId = 'real-deepseek-fallback';
        const primaryCredential = getModelApiKeyEnvironmentVariable(primaryId);
        const fallbackCredential = getModelApiKeyEnvironmentVariable(fallbackId);
        const originalPrimary = process.env[primaryCredential];
        const originalFallback = process.env[fallbackCredential];
        const primary: ModelConfig = {
          id: primaryId,
          provider: claude.provider,
          model: claude.model,
          overrides: {
            baseUrl: claude.baseURL,
            maxOutputTokens: 64,
            timeout: 5_000,
            streamIdleTimeout: 3_000,
            maxRetries: 0,
          },
          fallbackModels: [
            {
              provider: deepseek.provider,
              model: deepseek.model,
              configId: fallbackId,
            },
          ],
        };
        const fallback: ModelConfig = {
          id: fallbackId,
          provider: deepseek.provider,
          model: deepseek.model,
          overrides: {
            baseUrl: deepseek.baseURL,
            maxOutputTokens: 64,
            timeout: 30_000,
            streamIdleTimeout: 30_000,
          },
        };

        try {
          process.env[primaryCredential] = claude.apiKey;
          process.env[fallbackCredential] = deepseek.apiKey;
          const resolved = resolveModelConfig(
            primary,
            {
              temperature: 0,
              timeout: 180_000,
              providerCircuitBreakerOpenMs: 0,
              models: [primary, fallback],
            },
            'off'
          );
          const service = new PiAIChatService({
            ...resolved.chat,
            providerCircuitRegistry: new ProviderCircuitRegistry({
              processSecret: new Uint8Array(32).fill(71),
            }),
            providerRequestAdmissionScheduler: new ProviderRequestAdmissionScheduler({
              processSecret: new Uint8Array(32).fill(72),
            }),
          });
          const chunks: StreamChunk[] = [];

          for await (const chunk of service.streamChat(
            [{ role: 'user', content: 'Reply with exactly FALLBACK_OK.' }],
            undefined,
            undefined,
            {
              providerRecovery: {
                mode: 'bounded_foreground',
                budgetMs: 45_000,
              },
            }
          )) {
            chunks.push(chunk);
          }

          expect(resolved.chat.fallbackModels?.[0]?.channel?.apiKey).toBe(
            deepseek.apiKey
          );
          expect(resolved.chat.fallbackModels?.[0]?.channel?.baseUrl).toBe(
            deepseek.baseURL
          );
          expect(chunks.filter((chunk) => chunk.modelFallback)).toHaveLength(1);
          expect(chunks.find((chunk) => chunk.modelFallback)?.modelFallback).toEqual({
            from: { provider: claude.provider, model: claude.model },
            to: { provider: deepseek.provider, model: deepseek.model },
            candidate: 1,
            candidateCount: 1,
            trigger: { source: 'stall', reason: 'timeout' },
          });
          expect(JSON.stringify(chunks)).not.toContain(claude.apiKey);
          expect(JSON.stringify(chunks)).not.toContain(deepseek.apiKey);
          expect(JSON.stringify(chunks)).not.toContain(claude.baseURL);
          expect(JSON.stringify(chunks)).not.toContain(deepseek.baseURL);
          expect(chunks.some((chunk) => chunk.providerRetry?.phase === 'attempt')).toBe(
            false
          );
          expect(
            chunks
              .map((chunk) => chunk.content ?? '')
              .join('')
              .replace(/\p{Cf}/gu, '')
              .trim()
          ).toBe('FALLBACK_OK');
        } finally {
          if (originalPrimary === undefined) delete process.env[primaryCredential];
          else process.env[primaryCredential] = originalPrimary;
          if (originalFallback === undefined) delete process.env[fallbackCredential];
          else process.env[fallbackCredential] = originalFallback;
        }
      },
      60_000
    );
  }
);
