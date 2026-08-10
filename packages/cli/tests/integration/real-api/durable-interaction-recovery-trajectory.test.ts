import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { PermissionMode } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { Bus } from '../../../src/server/bus.js';
import { PermissionRoutes } from '../../../src/server/routes/permission.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
import { SessionInteractionService } from '../../../src/services/SessionInteractionService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;

function waitForCompletion(
  sessionId: string,
  projectPath: string
): { promise: Promise<void>; cancel(): void } {
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for durable interaction recovery'));
    }, 180_000);
    unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId !== sessionId || event.projectPath !== projectPath) return;
      if (event.type === 'permission.asked' || event.type === 'question.required') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error('Recovered interaction unexpectedly requested input again'));
      } else if (event.type === 'session.completed') {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      } else if (event.type === 'session.error') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(String(event.properties.error ?? 'Recovered run failed')));
      }
    });
  });
  return {
    promise,
    cancel() {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    },
  };
}

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const content = await readFile(filePath, 'utf8').catch(() => undefined);
    if (content !== undefined) return content;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for recovered file: ${filePath}`);
}

describeReal('durable pending interaction recovery trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('restarts from a durable Web question and performs a real Write', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-interaction-'));
    const workspace = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    const target = path.join(workspace, 'selected-channel.txt');
    const sessionId = `interaction-web-${Date.now()}`;
    const originalConfig = getState().config.config;
    const config = {
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    };
    const app = new Hono();
    app.route('/sessions', SessionRoutes());
    app.route('/permissions', PermissionRoutes());

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      await mkdir(workspace, { recursive: true });
      getState().config.actions.setConfig(config);
      await SessionService.createSessionMetadata(sessionId, workspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'yolo',
      });
      const store = new PersistentStore(workspace);
      await store.saveMessage(
        sessionId,
        'user',
        [
          'A structured Channel question will be recovered after a process restart.',
          'After the recovered answer is available, use Write exactly once to create selected-channel.txt.',
          'The complete file content must be the selected label followed by one newline.',
          'Do not call AskUserQuestion again and do not call any other tool.',
          'After Write succeeds, reply exactly INTERACTION_RECOVERED.',
        ].join(' ')
      );
      const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
        questions: [
          {
            header: 'Channel',
            question: 'Which release channel?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Stable release' },
              { label: 'Canary', description: 'Canary release' },
            ],
          },
        ],
      });
      const request = await SessionInteractionService.request(
        {
          sessionId,
          projectPath: workspace,
          toolCallId,
          toolName: 'AskUserQuestion',
        },
        {
          type: 'askUserQuestion',
          message: 'Choose a release channel',
          questions: [
            {
              header: 'Channel',
              question: 'Which release channel?',
              multiSelect: false,
              options: [
                { label: 'Stable', description: 'Stable release' },
                { label: 'Canary', description: 'Canary release' },
              ],
            },
          ],
        }
      );
      await expect(
        SessionService.findSessionMetadata(sessionId, workspace)
      ).resolves.toMatchObject({
        pendingInteraction: {
          type: 'question',
          requestId: request.requestId,
        },
      });

      const completion = waitForCompletion(sessionId, workspace);
      const response = await runWithCwdOverride(workspace, () =>
        app.request(
          `/permissions/${request.requestId}?sessionId=${sessionId}&projectPath=${encodeURIComponent(
            workspace
          )}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              approved: true,
              answers: { Channel: 'Canary' },
            }),
          }
        )
      );
      if (response.status !== 200) completion.cancel();
      expect(response.status, await response.clone().text()).toBe(200);
      await completion.promise;

      expect(await readFile(target, 'utf8')).toBe('Canary\n');
      const transcript = await readFile(
        getSessionFilePath(workspace, sessionId),
        'utf8'
      );
      expect(transcript.match(/"type":"interaction_requested"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_responded"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_recovered"/g)).toHaveLength(1);
      expect(transcript.match(/"interactionRecovery":true/g)).toHaveLength(1);
      assertNoSecrets(
        {
          metadata: await SessionService.findSessionMetadata(sessionId, workspace),
          transcript,
        },
        [gpt.apiKey]
      );
    } finally {
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

  it('replays a durable ACP question on session/load and resumes automatically', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-acp-interaction-'));
    const workspace = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    const target = path.join(workspace, 'acp-selected-channel.txt');
    const sessionId = `interaction-acp-${Date.now()}`;
    const originalConfig = getState().config.config;
    const config = {
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    };
    const client = createMockACPClient();
    client.requestPermission = async (request) => {
      client.permissionRequests.push(request);
      const selected = request.options.find((option) => option.name === 'Stable');
      return {
        outcome: {
          outcome: 'selected',
          optionId: selected?.optionId,
        },
      };
    };
    const agent = new BladeAgent(client as never);

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      await mkdir(workspace, { recursive: true });
      getState().config.actions.setConfig(config);
      await SessionService.createSessionMetadata(sessionId, workspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'yolo',
      });
      const store = new PersistentStore(workspace);
      await store.saveMessage(
        sessionId,
        'user',
        [
          'A Channel question will be recovered by ACP session/load.',
          'After the recovered answer, use Write exactly once to create acp-selected-channel.txt.',
          'Write only the selected label and one newline.',
          'Do not call AskUserQuestion again or call any other tool.',
          'After Write succeeds, reply exactly ACP_INTERACTION_RECOVERED.',
        ].join(' ')
      );
      const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
        questions: [
          {
            header: 'Channel',
            question: 'Which release channel?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Stable release' },
              { label: 'Canary', description: 'Canary release' },
            ],
          },
        ],
      });
      await SessionInteractionService.request(
        {
          sessionId,
          projectPath: workspace,
          toolCallId,
          toolName: 'AskUserQuestion',
        },
        {
          type: 'askUserQuestion',
          message: 'Choose a release channel',
          questions: [
            {
              header: 'Channel',
              question: 'Which release channel?',
              multiSelect: false,
              options: [
                { label: 'Stable', description: 'Stable release' },
                { label: 'Canary', description: 'Canary release' },
              ],
            },
          ],
        }
      );

      const setup = await runWithCwdOverride(workspace, () =>
        agent.loadSession({
          sessionId,
          cwd: workspace,
          mcpServers: [],
        })
      );
      expect(setup.modes?.currentModeId).toBe('yolo');
      expect(client.permissionRequests).toHaveLength(1);
      expect(
        client.permissionRequests[0]?.options.map((option) => option.name)
      ).toEqual(['Stable', 'Canary', 'Cancel']);
      const hostContent = await waitForFile(target).catch(() => undefined);
      const clientContent = [...client.files.values()].find(
        (content) => content === 'Stable\n'
      );
      expect(hostContent ?? clientContent).toBe('Stable\n');
      assertNoSecrets(
        {
          setup,
          updates: client.sessionUpdates,
          requests: client.permissionRequests,
        },
        [gpt.apiKey]
      );
    } finally {
      await agent.destroy().catch(() => undefined);
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
