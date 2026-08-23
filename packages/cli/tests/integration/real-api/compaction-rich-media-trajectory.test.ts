import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CompactionService,
  resetCompactionCircuitBreaker,
} from '../../../src/context/CompactionService.js';
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
  .sequential('compaction rich-media elision (real API)', () => {
    it.each(models)(
      '$qualificationId sends only text and fixed image placeholders',
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
          { role: 'user', content: 'Older text remains available.' },
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
  });
