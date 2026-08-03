import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  type TestModelConfig,
} from './testConfig.js';

const modelConfigs = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];
const enabled = modelConfigs.length > 0;
let originalConfig: RuntimeConfig | null = null;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

class RecordingClient implements acp.Client {
  readonly updates: acp.SessionNotification[] = [];

  async requestPermission(
    _params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }
}

function createHarness(client: RecordingClient): {
  connection: acp.ClientSideConnection;
  agent: BladeAgent;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  new acp.AgentSideConnection(
    (agentConnection) => {
      agent = new BladeAgent(agentConnection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('ACP Agent was not created');
  return { connection, agent };
}

function configureModel(modelConfig: TestModelConfig): string {
  const modelId = `acp-load-${modelConfig.id}`;
  getState().config.actions.setConfig({
    ...DEFAULT_CONFIG,
    currentModelId: modelId,
    models: [
      {
        id: modelId,
        name: modelConfig.name,
        provider: modelConfig.provider,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseURL ?? '',
        model: modelConfig.model,
        maxContextTokens: 64_000,
        maxOutputTokens: 4_096,
        timeout: 180_000,
        maxRetries: 1,
      },
    ],
  });
  return modelId;
}

function replayedText(updates: acp.SessionNotification[]): string {
  return updates
    .map((notification) => notification.update)
    .filter(
      (update) =>
        update.sessionUpdate === 'user_message_chunk' ||
        update.sessionUpdate === 'agent_message_chunk'
    )
    .map((update) => (update.content.type === 'text' ? update.content.text : ''))
    .join('');
}

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

describe.skipIf(!enabled)('ACP session/load trajectory (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} reloads history through ACP and continues the coding loop`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-load-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      const modelMarker = modelConfig.model.replaceAll(/[^A-Za-z0-9]/g, '_');
      const marker = `ACP_SESSION_RECOVERY_${modelMarker}`;
      const resumedValue = `ACP_SESSION_RESUMED_${modelMarker}`;
      const markerPath = path.join(workspace, 'marker.txt');
      const resultPath = path.join(workspace, 'result.txt');
      await writeFile(markerPath, `${marker}\n`);
      const modelId = configureModel(modelConfig);

      let firstAgent: BladeAgent | undefined;
      let secondAgent: BladeAgent | undefined;
      try {
        await runWithCwdOverride(workspace, async () => {
          const firstClient = new RecordingClient();
          const first = createHarness(firstClient);
          firstAgent = first.agent;
          const initialized = await first.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          expect(initialized.agentCapabilities?.loadSession).toBe(true);

          const session = await first.connection.newSession({
            cwd: workspace,
            mcpServers: [],
          });
          await first.connection.setSessionMode?.({
            sessionId: session.sessionId,
            modeId: 'yolo',
          });
          const firstResponse = await first.connection.prompt({
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text:
                  'Read marker.txt. Do not modify any files and do not repeat its contents. ' +
                  'After the Read tool succeeds, reply only with "Marker captured.".',
              },
            ],
          });
          expect(firstResponse.stopReason).toBe('end_turn');
          expect(
            firstClient.updates.some(
              (notification) =>
                notification.update.sessionUpdate === 'tool_call' &&
                notification.update.title.includes('Read')
            )
          ).toBe(true);

          await first.agent.destroy();
          firstAgent = undefined;
          const restoredMessages = await SessionService.loadSession(
            session.sessionId,
            workspace
          );
          const readCall = restoredMessages
            .flatMap((message) => message.tool_calls ?? [])
            .find(
              (toolCall) =>
                toolCall.type === 'function' && toolCall.function.name === 'Read'
            );
          expect(readCall).toBeDefined();
          const readResult = restoredMessages.find(
            (message) =>
              message.role === 'tool' && message.tool_call_id === readCall?.id
          );
          expect(readResult?.content).toContain(marker);
          await unlink(markerPath);

          const secondClient = new RecordingClient();
          const second = createHarness(secondClient);
          secondAgent = second.agent;
          await second.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const loaded = await second.connection.loadSession({
            sessionId: session.sessionId,
            cwd: workspace,
            mcpServers: [],
          });
          expect(loaded.models?.currentModelId).toBe(modelId);
          expect(replayedText(secondClient.updates)).toContain('Read marker.txt');

          await second.connection.setSessionMode?.({
            sessionId: session.sessionId,
            modeId: 'yolo',
          });
          const secondResponse = await second.connection.prompt({
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text:
                  `The session has been restored. Write exactly ${resumedValue} to result.txt ` +
                  'with no extra text, then run Bash with "wc -c result.txt" before finishing.',
              },
            ],
          });
          expect(secondResponse.stopReason).toBe('end_turn');
          expect((await readFile(resultPath, 'utf8')).trim()).toBe(resumedValue);
          expect(
            secondClient.updates.some(
              (notification) =>
                notification.update.sessionUpdate === 'tool_call' &&
                notification.update.title.includes('Bash')
            )
          ).toBe(true);
          expect(JSON.stringify(secondClient.updates)).not.toContain(
            modelConfig.apiKey
          );
        });
      } finally {
        await firstAgent?.destroy().catch(() => undefined);
        await secondAgent?.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
