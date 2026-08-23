import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CompactionService,
  MAX_COMPACTION_CONTEXT_RATIO,
  MAX_COMPACTION_RESULT_RATIO,
  MIN_COMPACTION_EFFECTIVENESS_TOKENS,
  resetCompactionCircuitBreaker,
} from '../../../src/context/CompactionService.js';
import { TokenCounter } from '../../../src/context/TokenCounter.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { startTokenBudgetHandoffProxy } from '../../support/tokenBudgetHandoffProxy.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import { isRealApiTestEnabled, resolveForkQualificationModels } from './testConfig.js';

const IMAGE_PLACEHOLDER = '[image omitted from compaction]';
const models = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env, {
      requiredDeepSeek: true,
    }).filter((model) => model.id !== 'domestic')
  : [];
const flash = models.find((model) => model.model === 'deepseek-v4-flash');

let hooksWereEnabled = false;
const roots: string[] = [];

beforeAll(() => {
  if (!isRealApiTestEnabled()) return;
  const hooks = HookManager.getInstance();
  hooksWereEnabled = hooks.isEnabled();
  hooks.disable();
});

afterEach(() => {
  resetCompactionCircuitBreaker();
});

afterAll(async () => {
  if (hooksWereEnabled) HookManager.getInstance().enable();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('compaction safety controls (real API)', () => {
    it.each(models)(
      '$qualificationId elides media and produces an effective replacement',
      async (model) => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'blade-compact-media-'));
        roots.push(root);
        const nonce = randomBytes(16).toString('hex');
        const inlinePayload = `INLINE_IMAGE_${nonce}`;
        const remotePath = `REMOTE_IMAGE_${nonce}`;
        const proxy = await startTokenBudgetHandoffProxy(
          model.baseURL ?? 'https://api.deepseek.com',
          {
            handoffPromptTokens: 1,
            compactionPromptTokens: 1,
            markerTag: '<unused-rich-media-marker>',
            compactionContentPolicy: {
              forbidden: [inlinePayload, remotePath, 'data:image/png;base64,'],
              required: [IMAGE_PLACEHOLDER, 'Keep this textual evidence.'],
            },
          }
        );
        const messages: Message[] = [
          {
            role: 'user',
            content: Array.from(
              { length: 600 },
              (_, index) =>
                `Historical checkpoint ${index} remained complete and verified.`
            ).join('\n'),
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Keep this textual evidence.' },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${inlinePayload}`,
                },
              },
              {
                type: 'image_url',
                image_url: {
                  url: `https://images.example.invalid/${remotePath}`,
                },
              },
            ],
          },
          { role: 'assistant', content: 'Continue from the textual evidence.' },
        ];
        const originalMessages = structuredClone(messages);
        const estimatedSourceTokens = TokenCounter.countTokens(messages, model.model);

        try {
          const result = await CompactionService.compact(messages, {
            trigger: 'auto',
            modelName: model.model,
            modelProvider: model.provider,
            maxContextTokens: 128_000,
            apiKey: model.apiKey,
            baseURL: proxy.baseURL,
            workspaceRoot: root,
            sessionId: `compact-media-${nonce}`,
          });
          const evidence = proxy.evidence();

          if (!result.success) {
            throw new Error(
              `Rich-media compaction failed: reason=${
                result.failureReason ?? 'unknown'
              }, attempts=${result.sampleAttempts ?? 0}, statuses=${evidence.requests
                .map((request) => request.upstreamStatus ?? 0)
                .join(',')}`
            );
          }
          expect(result.sampleAttempts).toBe(1);
          expect(result.imagesOmitted).toBe(2);
          expect(result.failureReason).toBeUndefined();
          expect(estimatedSourceTokens).toBeGreaterThanOrEqual(
            MIN_COMPACTION_EFFECTIVENESS_TOKENS
          );
          expect(result.postTokens).toBeLessThanOrEqual(
            Math.floor(estimatedSourceTokens * MAX_COMPACTION_RESULT_RATIO)
          );
          expect(messages).toEqual(originalMessages);

          expect(evidence.maxInFlight).toBe(1);
          expect(evidence.requests).toHaveLength(1);
          expect(evidence.requests[0]).toMatchObject({
            ordinal: 1,
            kind: 'compaction',
            compactionContentPolicyPassed: true,
            upstreamStatus: 200,
            usageRewritten: false,
          });
          assertNoSecrets(evidence, [model.apiKey, inlinePayload, remotePath]);
        } finally {
          await proxy.close();
        }
      },
      180_000
    );

    it.skipIf(!flash)(
      'bounds an ineffective real summary with a token-targeted fallback',
      async () => {
        if (!flash) throw new Error('DeepSeek Flash is required');
        const root = await mkdtemp(path.join(os.tmpdir(), 'blade-compact-fallback-'));
        roots.push(root);
        const nonce = randomBytes(16).toString('hex');
        const exactRecords = Array.from({ length: 4 }, (_, index) => {
          const payload = `FALLBACK_RECORD_${index}_${randomBytes(700).toString('hex')}`;
          return {
            line: `EXACT CONTINUATION RECORD [Decisions and rationale] :: ${payload}`,
            payload,
          };
        });
        const tailHead = `FALLBACK_TAIL_HEAD_${nonce}`;
        const tailEnd = `FALLBACK_TAIL_END_${nonce}`;
        const messages: Message[] = [
          {
            role: 'user',
            content: exactRecords.map((record) => record.line).join('\n'),
          },
          {
            role: 'user',
            content: `${tailHead}_${randomBytes(16_000).toString('hex')}_${tailEnd}`,
          },
        ];
        const originalMessages = structuredClone(messages);
        const contextTarget = Math.floor(12_000 * MAX_COMPACTION_CONTEXT_RATIO);

        const result = await CompactionService.compact(messages, {
          trigger: 'auto',
          modelName: flash.model,
          modelProvider: flash.provider,
          maxContextTokens: 12_000,
          apiKey: flash.apiKey,
          baseURL: flash.baseURL,
          workspaceRoot: root,
          sessionId: `compact-fallback-${nonce}`,
        });

        expect(result.success).toBe(false);
        expect(result.failureReason).toBe('insufficient_reduction');
        expect(result.usage?.totalTokens).toBeGreaterThan(0);
        expect(result.fallbackTargetTokens).toBe(contextTarget);
        expect(result.postTokens).toBeLessThanOrEqual(contextTarget);
        expect(result.fallbackMessagesOmitted).toBe(1);
        expect(result.fallbackMessagesTruncated).toBe(1);
        expect(String(result.compactedMessages[1]?.content)).toContain(tailHead);
        expect(String(result.compactedMessages[1]?.content)).toContain(tailEnd);
        for (const record of exactRecords) {
          expect(result.summary).toContain(record.payload);
        }
        expect(messages).toEqual(originalMessages);
        assertNoSecrets(result, [flash.apiKey]);
      },
      180_000
    );
  });
