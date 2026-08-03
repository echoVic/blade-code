import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import type { LoopEvent } from '../../../src/agent/loop/types.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import {
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import { parseSessionJSONL } from '../../../src/context/storage/JSONLStore.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import {
  buildRealApiRuntimeConfig,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const modelConfigs = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];
const enabled = modelConfigs.length > 0;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

beforeAll(() => {
  if (!enabled) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) {
    getState().config.actions.setConfig(originalConfig);
  }
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

describe.skipIf(!enabled)('Durable steering recovery (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} recovers accepted steering after a runtime restart`, async () => {
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-durable-steering-')
      );
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const sessionId = `durable-steering-${Date.now()}`;
      let firstRuntime: SessionRuntime | undefined;
      let secondRuntime: SessionRuntime | undefined;
      let agent: Agent | undefined;

      try {
        const durablePrompt =
          'The old candidate was ALPHA_DURABLE_VALUE. The newest candidate is ' +
          'BETA_DURABLE_VALUE. Reply with the newest candidate value only.';
        firstRuntime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        const queued = await firstRuntime.enqueueSteering(durablePrompt, {
          allowBeforeTurn: true,
        });
        expect(queued).toMatchObject({
          accepted: true,
          queued: 1,
          delivery: 'next_turn',
        });

        const inboxPath = getSessionInboxFilePath(workspace, sessionId);
        const inbox = JSON.parse(await readFile(inboxPath, 'utf8')) as {
          messages: Array<{ id: string }>;
        };
        const inboxMessageId = inbox.messages[0]?.id;
        expect(inboxMessageId).toBeTruthy();
        await firstRuntime
          .getExecutionEngine()
          .getContextManager()
          .persistentStore.saveMessage(sessionId, 'user', durablePrompt, null, {
            inboxMessageId,
          });

        await firstRuntime.dispose();
        firstRuntime = undefined;

        secondRuntime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        expect(secondRuntime.getRecoveredSteeringCount()).toBe(1);
        agent = await Agent.createWithRuntime(secondRuntime, { sessionId });
        const context: ChatContext = {
          messages: await SessionService.loadSession(sessionId, workspace),
          userId: 'durable-steering-test',
          sessionId,
          workspaceRoot: workspace,
          permissionMode: 'yolo' as ChatContext['permissionMode'],
        };
        const events: LoopEvent[] = [];
        const result = await drainLoop(
          agent.chatStream('', context, {
            stream: true,
            pendingInputOnly: true,
          }),
          (event) => {
            events.push(event);
          }
        );

        expect(result.success).toBe(true);
        expect(result.finalMessage).toContain('BETA_DURABLE_VALUE');
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'steering_applied',
            recovered: 1,
            count: 1,
            delivery: 'next_turn',
          })
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'follow_up_started',
            recovered: 1,
            queued: 1,
          })
        );
        await expect(access(inboxPath)).rejects.toThrow();

        const transcriptPath = getSessionFilePath(workspace, sessionId);
        const transcript = parseSessionJSONL(
          await readFile(transcriptPath, 'utf8'),
          transcriptPath
        );
        expect(
          transcript.some(
            (event) =>
              event.type === 'message_created' &&
              event.data.inboxMessageId === inboxMessageId
          )
        ).toBe(true);
        expect(
          transcript.filter(
            (event) =>
              event.type === 'message_created' &&
              event.data.inboxMessageId === inboxMessageId
          )
        ).toHaveLength(1);
        expect(
          transcript.some(
            (event) =>
              event.type === 'inbox_acknowledged' &&
              event.data.messageIds.includes(inboxMessageId!)
          )
        ).toBe(true);
        expect(JSON.stringify(events)).not.toContain(modelConfig.apiKey);
      } finally {
        await agent?.destroy().catch(() => undefined);
        await firstRuntime?.dispose().catch(() => undefined);
        await secondRuntime?.dispose().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
