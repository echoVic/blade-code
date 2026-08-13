import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { PermissionMode } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import {
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import { Bus } from '../../../src/server/bus.js';
import { PermissionRoutes } from '../../../src/server/routes/permission.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
import { SessionInteractionService } from '../../../src/services/SessionInteractionService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  createMockACPClient,
  type MockACPClient,
} from '../../support/mocks/mockACPClient.js';
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

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function fileIsMissing(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function waitForAcpRecovery(input: {
  client: MockACPClient;
  target: string;
  workspace: string;
  sessionId: string;
  expectedContent: string;
  expectedText: string;
}): Promise<string> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const hostContent = await readOptionalFile(input.target);
    const clientContent = [...input.client.files.values()].find(
      (content) => content === input.expectedContent
    );
    const agentText = input.client.sessionUpdates
      .flatMap((notification) =>
        notification.update.sessionUpdate === 'agent_message_chunk' &&
        notification.update.content.type === 'text'
          ? [notification.update.content.text]
          : []
      )
      .join('');
    if (
      (hostContent ?? clientContent) === input.expectedContent &&
      agentText.includes(input.expectedText) &&
      (await fileIsMissing(getSessionInboxFilePath(input.workspace, input.sessionId)))
    ) {
      return hostContent ?? clientContent ?? '';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for durable ACP interaction completion');
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
          `After the recovered answer, call Write exactly once with file_path=${JSON.stringify(
            target
          )}.`,
          'Set content to the selected label followed by exactly one newline.',
          'That Write is the only allowed tool call. Never call AskUserQuestion again.',
          'Do not emit assistant text or end the turn before Write succeeds.',
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

      const transcript = await readFile(
        getSessionFilePath(workspace, sessionId),
        'utf8'
      );
      const [events, metadata] = await Promise.all([
        store.loadEvents(sessionId),
        SessionService.findSessionMetadata(sessionId, workspace),
      ]);
      assertNoSecrets({ metadata, transcript }, [gpt.apiKey]);
      const targetContent = await readOptionalFile(target);
      const diagnostic = JSON.stringify(
        events?.filter(
          (event) =>
            event.type === 'interaction_requested' ||
            event.type === 'interaction_responded' ||
            event.type === 'interaction_recovered' ||
            event.type === 'message_created' ||
            (event.type === 'part_created' &&
              ['text', 'tool_call', 'tool_result'].includes(event.data.partType))
        )
      )
        .replaceAll(gpt.apiKey, '[redacted]')
        .slice(-8_000);
      expect(
        targetContent,
        `Recovered Web interaction did not commit the selected file: ${diagnostic}`
      ).toBe('Canary\n');
      expect(transcript.match(/"type":"interaction_requested"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_responded"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_recovered"/g)).toHaveLength(1);
      expect(transcript.match(/"interactionRecovery":true/g)).toHaveLength(1);
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
          `After the recovered answer, call Write exactly once with file_path=${JSON.stringify(
            target
          )}.`,
          'Set content to the selected label followed by exactly one newline.',
          'That Write is the only allowed tool call. Never call AskUserQuestion again.',
          'Do not emit assistant text or end the turn before Write succeeds.',
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
      const content = await waitForAcpRecovery({
        client,
        target,
        workspace,
        sessionId,
        expectedContent: 'Stable\n',
        expectedText: 'ACP_INTERACTION_RECOVERED',
      });
      expect(content).toBe('Stable\n');
      const transcript = await readFile(
        getSessionFilePath(workspace, sessionId),
        'utf8'
      );
      expect(transcript).toContain('ACP_INTERACTION_RECOVERED');
      expect(transcript.match(/"type":"interaction_requested"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_responded"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_recovered"/g)).toHaveLength(1);
      assertNoSecrets(
        {
          setup,
          updates: client.sessionUpdates,
          requests: client.permissionRequests,
          transcript,
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
