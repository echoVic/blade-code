import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpSession } from '../../../src/acp/Session.js';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { parseSessionJSONL } from '../../../src/context/storage/JSONLStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { Bus } from '../../../src/server/bus.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
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
  if (enabled) originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

function editPrompt(): string {
  return [
    'This is a deterministic rewind qualification.',
    'Use Read on fixture.txt, then use Edit exactly once to replace the exact',
    'string BASELINE with CHANGED, then use Read again to verify CHANGED.',
    'Use no other tools. Finish with the exact text REWIND_READY.',
  ].join(' ');
}

async function waitForSessionCompletion(
  sessionId: string,
  projectPath: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for rewind Web run completion'));
    }, 180_000);
    const unsubscribe = Bus.subscribe((event) => {
      if (
        event.sessionId === sessionId &&
        event.projectPath === projectPath &&
        event.type === 'session.completed'
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
      if (
        event.sessionId === sessionId &&
        event.projectPath === projectPath &&
        event.type === 'session.error'
      ) {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error('Web rewind qualification run failed'));
      }
    });
  });
}

async function assertDurableRewind(
  workspace: string,
  sessionId: string,
  targetMessageId: string
): Promise<void> {
  const raw = await readFile(getSessionFilePath(workspace, sessionId), 'utf8');
  const events = parseSessionJSONL(raw, `rewind qualification ${sessionId}`);
  expect(events.at(-1)).toMatchObject({
    type: 'session_rewound',
    data: {
      targetMessageId,
    },
  });
  expect(await SessionService.listRewindCheckpoints(sessionId, workspace)).toEqual([]);
}

const describeTrajectory = enabled ? describe.sequential : describe.skip;

describeTrajectory('Durable rewind trajectories (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} rewinds a real Runtime edit and conversation`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-runtime-rewind-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const sessionId = `runtime-rewind-${Date.now()}`;
      const targetFile = path.join(workspace, 'fixture.txt');
      let runtime: SessionRuntime | undefined;
      let agent: Agent | undefined;

      try {
        await writeFile(targetFile, 'BASELINE', 'utf8');
        runtime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        agent = await Agent.createWithRuntime(runtime, { sessionId });
        const context: ChatContext = {
          messages: [],
          userId: 'runtime-rewind-real-api',
          sessionId,
          workspaceRoot: workspace,
          permissionMode: 'yolo' as ChatContext['permissionMode'],
        };
        const result = await drainLoop(
          agent.chatStream(editPrompt(), context, { stream: true })
        );
        expect(result.success).toBe(true);
        expect((await readFile(targetFile, 'utf8')).trim()).toBe('CHANGED');

        const [checkpoint] = await runtime.listRewindCheckpoints();
        expect(checkpoint).toMatchObject({ fileCount: 1 });
        const rewound = await runtime.rewindSession({
          targetMessageId: checkpoint!.messageId,
          mode: 'both',
        });
        expect(rewound.removedTurns).toBe(1);
        expect((await readFile(targetFile, 'utf8')).trim()).toBe('BASELINE');
        expect(rewound.messages).toEqual([]);
        await assertDurableRewind(workspace, sessionId, checkpoint!.messageId);
        expect(JSON.stringify(rewound)).not.toContain(modelConfig.apiKey);
      } finally {
        await agent?.destroy().catch(() => undefined);
        await runtime?.dispose().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} rewinds through Web HTTP and SSE`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-web-rewind-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const targetFile = path.join(workspace, 'fixture.txt');
      const app = SessionRoutes();
      let sessionId = '';

      try {
        await writeFile(targetFile, 'BASELINE', 'utf8');
        const created = await app.request('/', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectPath: workspace,
            title: 'Web rewind qualification',
          }),
        });
        expect(created.status).toBe(200);
        sessionId = ((await created.json()) as { sessionId: string }).sessionId;

        const completion = waitForSessionCompletion(sessionId, workspace);
        const submitted = await app.request(`/${sessionId}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: editPrompt(),
            projectPath: workspace,
            permissionMode: 'yolo',
          }),
        });
        expect(submitted.status).toBe(202);
        await completion;
        expect((await readFile(targetFile, 'utf8')).trim()).toBe('CHANGED');

        const listed = await app.request(
          `/${sessionId}/rewind?projectPath=${encodeURIComponent(workspace)}`
        );
        expect(listed.status).toBe(200);
        const checkpoints = (
          (await listed.json()) as {
            checkpoints: Array<{ messageId: string; fileCount: number }>;
          }
        ).checkpoints;
        expect(checkpoints[0]).toMatchObject({ fileCount: 1 });

        const rewound = await app.request(
          `/${sessionId}/rewind?projectPath=${encodeURIComponent(workspace)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              targetMessageId: checkpoints[0]!.messageId,
              mode: 'both',
            }),
          }
        );
        expect(rewound.status).toBe(200);
        expect(await rewound.json()).toMatchObject({
          removedTurns: 1,
          messages: [],
        });
        expect((await readFile(targetFile, 'utf8')).trim()).toBe('BASELINE');
        await assertDurableRewind(workspace, sessionId, checkpoints[0]!.messageId);
      } finally {
        if (sessionId) {
          await app.request(
            `/${sessionId}?projectPath=${encodeURIComponent(workspace)}`,
            { method: 'DELETE' }
          );
        }
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} rewinds ACP context and continues cleanly`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-rewind-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const sessionId = `acp-rewind-${Date.now()}`;
      const client = createMockACPClient();
      const session = new AcpSession(sessionId, workspace, client as never, {});

      try {
        await session.initialize();
        await session.setMode('yolo');
        const first = await session.prompt({
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Reply with the exact text ACP_BEFORE_REWIND and use no tools.',
            },
          ],
        });
        expect(first.stopReason).toBe('end_turn');
        const [checkpoint] = await SessionService.listRewindCheckpoints(
          sessionId,
          workspace
        );
        expect(checkpoint).toBeDefined();

        const rewind = await session.prompt({
          sessionId,
          prompt: [
            {
              type: 'text',
              text: `/rewind ${checkpoint!.messageId}`,
            },
          ],
        });
        expect(rewind.stopReason).toBe('end_turn');
        await assertDurableRewind(workspace, sessionId, checkpoint!.messageId);

        const continued = await session.prompt({
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Reply with the exact text ACP_AFTER_REWIND and use no tools.',
            },
          ],
        });
        expect(continued.stopReason).toBe('end_turn');
        const persistedAfterRewind = await SessionService.loadSession(
          sessionId,
          workspace
        );
        const updateTexts = client.sessionUpdates.flatMap((notification) =>
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text'
            ? [notification.update.content.text]
            : []
        );
        const diagnostic = JSON.stringify({
          updateTexts,
          persisted: persistedAfterRewind.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }).replaceAll(modelConfig.apiKey, '[redacted]');
        expect(updateTexts.join(''), diagnostic).toContain('ACP_AFTER_REWIND');
        expect(persistedAfterRewind).toContainEqual(
          expect.objectContaining({
            role: 'assistant',
            content: expect.stringContaining('ACP_AFTER_REWIND'),
          })
        );
        expect(JSON.stringify(client.sessionUpdates)).not.toContain(modelConfig.apiKey);
      } finally {
        await session.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
