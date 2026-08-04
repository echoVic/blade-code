import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { AcpSession } from '../../../src/acp/Session.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { getSessionInboxFilePath } from '../../../src/context/storage/pathUtils.js';
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

interface PairedAcpHarness {
  connection: acp.ClientSideConnection;
  agentConnection: acp.AgentSideConnection;
  close(): Promise<void>;
}

function createHarness(client: RecordingClient): PairedAcpHarness {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    (agentConnection) => {
      agent = new BladeAgent(agentConnection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('ACP Agent was not created');
  const productionAgent = agent;
  let closePromise: Promise<void> | undefined;

  return {
    connection,
    agentConnection,
    close: () => {
      closePromise ??= (async () => {
        let firstError: unknown;
        try {
          await productionAgent.destroy();
        } catch (error) {
          firstError = error;
        }

        try {
          const clientWriter = clientToAgent.writable.getWriter();
          const agentWriter = agentToClient.writable.getWriter();
          try {
            await Promise.all([clientWriter.close(), agentWriter.close()]);
          } finally {
            clientWriter.releaseLock();
            agentWriter.releaseLock();
          }
          await Promise.all([connection.closed, agentConnection.closed]);
        } catch (error) {
          firstError ??= error;
        }

        if (firstError !== undefined) throw firstError;
      })();
      return closePromise;
    },
  };
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

describe('direct ACP session transport fixture', () => {
  it('exposes transport abort state and suppresses updates after close', async () => {
    const client = new RecordingClient();
    const harness = createHarness(client);
    const session = new AcpSession(
      'direct-transport-abort',
      process.cwd(),
      harness.agentConnection,
      {},
      {
        initialMessages: [{ role: 'user', content: 'transport lifecycle marker' }],
      }
    );

    try {
      await session.replayHistory();
      expect(replayedText(client.updates)).toContain('transport lifecycle marker');

      client.updates.length = 0;
      await harness.close();
      expect(harness.agentConnection.signal.aborted).toBe(true);

      await session.replayHistory();
      expect(client.updates).toEqual([]);
    } finally {
      await session.destroy().catch(() => undefined);
      await harness.close().catch(() => undefined);
    }
  });
});

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

      let firstHarness: PairedAcpHarness | undefined;
      let secondHarness: PairedAcpHarness | undefined;
      try {
        await runWithCwdOverride(workspace, async () => {
          const firstClient = new RecordingClient();
          const first = createHarness(firstClient);
          firstHarness = first;
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

          await first.close();
          firstHarness = undefined;
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
          secondHarness = second;
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
        await firstHarness?.close().catch(() => undefined);
        await secondHarness?.close().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} steers an active ACP prompt without aborting it`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-steering-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient();
      const harness = createHarness(client);
      const session = new AcpSession(
        `acp-steering-${Date.now()}`,
        workspace,
        harness.agentConnection,
        {}
      );

      try {
        await runWithCwdOverride(workspace, async () => {
          await session.initialize();
          await session.setMode('yolo');

          const initialPrompt = session.prompt({
            sessionId: 'ignored-by-session',
            prompt: [
              {
                type: 'text',
                text:
                  'We are choosing a TypeScript identifier before editing code. The ' +
                  'current requested identifier is ALPHA_ACP_IDENTIFIER. Reply with ' +
                  'that identifier only. Do not call tools.',
              },
            ],
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          const steeringResponse = await session.prompt({
            sessionId: 'ignored-by-session',
            prompt: [
              {
                type: 'text',
                text:
                  'Requirement update: use BETA_ACP_IDENTIFIER instead. Reply with ' +
                  'the newest requested identifier only.',
              },
            ],
          });
          const initialResponse = await initialPrompt;

          expect(steeringResponse.stopReason).toBe('end_turn');
          expect(initialResponse.stopReason).toBe('end_turn');
          const output = replayedText(client.updates);
          expect(output).toContain('BETA_ACP_IDENTIFIER');
          expect(output.lastIndexOf('BETA_ACP_IDENTIFIER')).toBeGreaterThan(
            output.lastIndexOf('ALPHA_ACP_IDENTIFIER')
          );
          expect(JSON.stringify(client.updates)).not.toContain(modelConfig.apiKey);
        });
      } finally {
        await session.destroy().catch(() => undefined);
        await harness.close().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} auto-resumes durable input when ACP initializes`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-recovery-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient();
      const harness = createHarness(client);
      const sessionId = `acp-recovery-${Date.now()}`;
      let firstRuntime: SessionRuntime | undefined;
      let session: AcpSession | undefined;

      try {
        await runWithCwdOverride(workspace, async () => {
          firstRuntime = await SessionRuntime.create({
            sessionId,
            workspaceRoot: workspace,
          });
          const durablePrompt =
            'The old value was ALPHA_ACP_RECOVERY. The newest value is ' +
            'BETA_ACP_RECOVERY. Reply with the newest value only.';
          const prepared = await firstRuntime.prepareInputTurn(durablePrompt);
          expect(prepared).toMatchObject({
            accepted: true,
            mode: 'direct',
            queued: 1,
          });
          if (!prepared.accepted) {
            throw new Error('Expected durable input preparation to succeed');
          }
          await firstRuntime.dispose();
          firstRuntime = undefined;

          const initialMessages = await SessionService.loadSession(
            sessionId,
            workspace
          );
          session = new AcpSession(
            sessionId,
            workspace,
            harness.agentConnection,
            {},
            { initialMessages }
          );
          await session.initialize();
          await session.replayHistory();

          await vi.waitFor(
            () => {
              const agentOutput = client.updates
                .flatMap((update) =>
                  update.update.sessionUpdate === 'agent_message_chunk' &&
                  update.update.content.type === 'text'
                    ? [update.update.content.text]
                    : []
                )
                .join('');
              expect(agentOutput).toContain('BETA_ACP_RECOVERY');
            },
            { timeout: 120_000, interval: 100 }
          );
          expect(
            client.updates.filter(
              (update) =>
                update.update.sessionUpdate === 'user_message_chunk' &&
                update.update.content.type === 'text' &&
                update.update.content.text.includes('BETA_ACP_RECOVERY')
            )
          ).toHaveLength(1);
          await vi.waitFor(
            async () => {
              let inboxExists = true;
              try {
                await access(getSessionInboxFilePath(workspace, sessionId));
              } catch {
                inboxExists = false;
              }
              expect(inboxExists).toBe(false);
            },
            { timeout: 10_000, interval: 50 }
          );
          expect(JSON.stringify(client.updates)).not.toContain(modelConfig.apiKey);
        });
      } finally {
        await firstRuntime?.dispose().catch(() => undefined);
        await session?.destroy().catch(() => undefined);
        await harness.close().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
