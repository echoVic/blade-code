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
  BOUNDED_OUTPUT_PROOF,
  BOUNDED_OUTPUT_TAIL,
  buildInteractiveShellCommand,
  buildInteractiveShellPrompt,
  createBoundedOutputFixture,
  INTERACTIVE_SHELL_INPUT,
} from './interactiveShellFixture.js';
import {
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  type TestModelConfig,
} from './testConfig.js';

const modelConfigs = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];
const questionModelConfigs = expandDeepSeekModelMatrix(modelConfigs);
const enabled = modelConfigs.length > 0;
let originalConfig: RuntimeConfig | null = null;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

class RecordingClient implements acp.Client {
  readonly updates: acp.SessionNotification[] = [];
  readonly permissionRequests: acp.RequestPermissionRequest[] = [];

  constructor(
    private readonly permissionResponder?: (
      params: acp.RequestPermissionRequest
    ) => Promise<acp.RequestPermissionResponse>
  ) {}

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    this.permissionRequests.push(params);
    if (this.permissionResponder) {
      return this.permissionResponder(params);
    }
    const preferredAnswer = params.options.find((option) => option.name === 'Canary');
    return {
      outcome: {
        outcome: 'selected',
        optionId: preferredAnswer?.optionId ?? 'allow_once',
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
  for (const modelConfig of questionModelConfigs) {
    it(`${modelConfig.model} collects a structured answer in yolo mode and continues the coding loop`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-question-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient();
      const session = new AcpSession(
        `acp-question-${Date.now()}`,
        workspace,
        client as unknown as acp.AgentSideConnection,
        {}
      );
      const resultPath = path.join(workspace, 'selected-channel.txt');

      try {
        await runWithCwdOverride(workspace, async () => {
          await session.initialize();
          await session.setMode('yolo');
          const response = await session.prompt({
            sessionId: 'ignored-by-session',
            prompt: [
              {
                type: 'text',
                text: [
                  'Work as a coding agent and follow this interaction contract exactly.',
                  'Before editing any file, call AskUserQuestion exactly once with one single-select question:',
                  '- header: Channel',
                  '- question: Which release channel should be written?',
                  '- options in order: Stable, then Canary',
                  '- multiSelect: false',
                  'After the user answers, write only the selected label and a newline to selected-channel.txt.',
                  "Then invoke Bash with: node -e \"const fs=require('node:fs');if(fs.readFileSync('selected-channel.txt','utf8').trim()!=='Canary')process.exit(1)\"",
                  'Finish only after Bash succeeds.',
                ].join('\n'),
              },
            ],
          });

          expect(response.stopReason).toBe('end_turn');
          expect(client.permissionRequests).toHaveLength(1);
          expect(
            client.permissionRequests[0]?.options.map((option) => option.name)
          ).toEqual(['Stable', 'Canary', 'Cancel']);
          expect((await readFile(resultPath, 'utf8')).trim()).toBe('Canary');
          expect(
            client.updates.some(
              (notification) =>
                notification.update.sessionUpdate === 'tool_call' &&
                notification.update.title.includes('Bash')
            )
          ).toBe(true);
          expect(JSON.stringify(client.updates)).not.toContain(modelConfig.apiKey);
          expect(JSON.stringify(client.permissionRequests)).not.toContain(
            modelConfig.apiKey
          );
        });
      } finally {
        await session.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 360_000);

    it(`${modelConfig.model} cancels an unanswered ACP question and reuses the session`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-cancel-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient(async () => {
        return new Promise<acp.RequestPermissionResponse>(() => undefined);
      });
      const harness = createHarness(client);
      const resultPath = path.join(workspace, 'cancel-recovery.txt');

      try {
        await runWithCwdOverride(workspace, async () => {
          await harness.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await harness.connection.newSession({
            cwd: workspace,
            mcpServers: [],
          });
          await harness.connection.setSessionMode?.({
            sessionId: session.sessionId,
            modeId: 'yolo',
          });

          const blockedPrompt = harness.connection.prompt({
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text: [
                  'Before editing any file, call AskUserQuestion exactly once.',
                  'Ask one single-select question with header Channel and options Stable and Canary.',
                  'Wait for the answer. Do not edit files or call Bash before the answer.',
                ].join('\n'),
              },
            ],
          });
          await vi.waitFor(
            () => {
              expect(client.permissionRequests).toHaveLength(1);
            },
            { timeout: 180_000, interval: 50 }
          );
          await harness.connection.cancel({ sessionId: session.sessionId });
          await expect(blockedPrompt).resolves.toEqual({ stopReason: 'cancelled' });

          const recovered = await harness.connection.prompt({
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text: [
                  'The previous turn was explicitly cancelled. Start a new turn now.',
                  'Do not call AskUserQuestion.',
                  'Use Write to create cancel-recovery.txt containing exactly recovered-after-cancel and a newline.',
                  'Then run Bash with "wc -c cancel-recovery.txt" and finish only after Bash succeeds.',
                ].join('\n'),
              },
            ],
          });

          expect(recovered.stopReason).toBe('end_turn');
          expect((await readFile(resultPath, 'utf8')).trim()).toBe(
            'recovered-after-cancel'
          );
          expect(
            client.updates.some(
              (notification) =>
                notification.update.sessionUpdate === 'tool_call' &&
                notification.update.title.includes('Bash')
            )
          ).toBe(true);
          expect(JSON.stringify(client.updates)).not.toContain(modelConfig.apiKey);
          expect(JSON.stringify(client.permissionRequests)).not.toContain(
            modelConfig.apiKey
          );
        });
      } finally {
        await harness.agent.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 360_000);

    it(`${modelConfig.model} persists ACP allow_always for the project and reloads it`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-scope-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient(async (request) => ({
        outcome: {
          outcome: 'selected',
          optionId:
            request.options.find((option) => option.kind === 'allow_always')
              ?.optionId ?? 'allow_always',
        },
      }));
      const harness = createHarness(client);
      const command = "printf 'acp-scope\\n' > acp-permission-scope.log";

      try {
        await runWithCwdOverride(workspace, async () => {
          await harness.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const first = await harness.connection.newSession({
            cwd: workspace,
            mcpServers: [],
          });
          const firstResult = await harness.connection.prompt({
            sessionId: first.sessionId,
            prompt: [
              {
                type: 'text',
                text: `Call Bash exactly once with ${JSON.stringify(command)} and finish after it succeeds.`,
              },
            ],
          });
          expect(firstResult.stopReason).toBe('end_turn');
          expect(client.permissionRequests).toHaveLength(1);
          const settings = JSON.parse(
            await readFile(
              path.join(workspace, '.blade', 'settings.local.json'),
              'utf8'
            )
          ) as { permissions?: { allow?: string[] } };
          expect(settings.permissions?.allow).toEqual([
            expect.stringContaining('Bash'),
          ]);

          const updatesBeforeReloadedPrompt = client.updates.length;
          const second = await harness.connection.newSession({
            cwd: workspace,
            mcpServers: [],
          });
          const secondResult = await harness.connection.prompt({
            sessionId: second.sessionId,
            prompt: [
              {
                type: 'text',
                text: `Call Bash exactly once with ${JSON.stringify(command)} and finish after it succeeds.`,
              },
            ],
          });
          expect(secondResult.stopReason).toBe('end_turn');
          expect(client.permissionRequests).toHaveLength(1);
          expect(
            client.updates
              .slice(updatesBeforeReloadedPrompt)
              .some(
                (notification) =>
                  notification.update.sessionUpdate === 'tool_call' &&
                  notification.update.title.includes('Bash')
              )
          ).toBe(true);
          expect(
            await readFile(path.join(workspace, 'acp-permission-scope.log'), 'utf8')
          ).toBe('acp-scope\n');
          expect(JSON.stringify(client.updates)).not.toContain(modelConfig.apiKey);
          expect(JSON.stringify(client.permissionRequests)).not.toContain(
            modelConfig.apiKey
          );
        });
      } finally {
        await harness.agent.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 360_000);

    it(`${modelConfig.model} drives an interactive background shell through ACP`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-stdin-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient();
      const harness = createHarness(client);
      const outputFile = 'acp-stdin.txt';
      const command = buildInteractiveShellCommand(outputFile);

      try {
        await runWithCwdOverride(workspace, async () => {
          await harness.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await harness.connection.newSession({
            cwd: workspace,
            mcpServers: [],
          });
          await harness.connection.setSessionMode?.({
            sessionId: session.sessionId,
            modeId: 'yolo',
          });

          const result = await harness.connection.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: buildInteractiveShellPrompt(command) }],
          });

          expect(result.stopReason).toBe('end_turn');
          expect(await readFile(path.join(workspace, outputFile), 'utf8')).toBe(
            INTERACTIVE_SHELL_INPUT
          );
          const toolTitles = client.updates
            .map((notification) => notification.update)
            .filter((update) => update.sessionUpdate === 'tool_call')
            .map((update) => update.title);
          expect(toolTitles).toEqual(
            expect.arrayContaining([
              'Executing Bash',
              'Executing WriteStdin',
              'Executing TaskOutput',
            ])
          );
          expect(JSON.stringify(client.updates)).not.toContain(modelConfig.apiKey);
        });
      } finally {
        await harness.agent.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 360_000);

    it(`${modelConfig.model} observes bounded background output through ACP`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-bounded-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient();
      const harness = createHarness(client);
      const proofFile = 'acp-bounded-output.txt';
      const fixture = await createBoundedOutputFixture(workspace, proofFile);

      try {
        await runWithCwdOverride(workspace, async () => {
          await harness.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await harness.connection.newSession({
            cwd: workspace,
            mcpServers: [],
          });
          await harness.connection.setSessionMode?.({
            sessionId: session.sessionId,
            modeId: 'yolo',
          });

          const result = await harness.connection.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: fixture.prompt }],
          });

          expect(result.stopReason).toBe('end_turn');
          expect(await readFile(path.join(workspace, proofFile), 'utf8')).toBe(
            BOUNDED_OUTPUT_PROOF
          );
          const updates = JSON.stringify(client.updates);
          expect(updates).toContain('Output truncated');
          expect(updates).toContain(BOUNDED_OUTPUT_TAIL);
          expect(updates).not.toContain(modelConfig.apiKey);
        });
      } finally {
        await harness.agent.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 360_000);
  }

  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} branches durable context through ACP session/load`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-branch-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      const modelMarker = modelConfig.model.replaceAll(/[^A-Za-z0-9]/g, '_');
      const marker = `ACP_BRANCH_${modelMarker}`;
      const markerPath = path.join(workspace, 'branch-marker.txt');
      const resultPath = path.join(workspace, 'branch-result.txt');
      await writeFile(markerPath, `${marker}\n`);
      const modelId = configureModel(modelConfig);

      let firstAgent: BladeAgent | undefined;
      let secondAgent: BladeAgent | undefined;
      try {
        await runWithCwdOverride(workspace, async () => {
          const firstClient = new RecordingClient();
          const first = createHarness(firstClient);
          firstAgent = first.agent;
          await first.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const parent = await first.connection.newSession({
            cwd: workspace,
            mcpServers: [],
          });
          await first.connection.setSessionMode?.({
            sessionId: parent.sessionId,
            modeId: 'yolo',
          });
          const captured = await first.connection.prompt({
            sessionId: parent.sessionId,
            prompt: [
              {
                type: 'text',
                text:
                  'Read branch-marker.txt. Do not modify files and do not repeat its contents. ' +
                  'After the Read tool succeeds, reply only with "Marker captured.".',
              },
            ],
          });
          expect(captured.stopReason).toBe('end_turn');
          const parentMessagesBefore = await SessionService.loadSession(
            parent.sessionId,
            workspace
          );

          const branchUpdateStart = firstClient.updates.length;
          const branched = await first.connection.prompt({
            sessionId: parent.sessionId,
            prompt: [{ type: 'text', text: '/branch' }],
          });
          expect(branched.stopReason).toBe('end_turn');
          const branchOutput = replayedText(
            firstClient.updates.slice(branchUpdateStart)
          );
          const childId = /Created session branch ([A-Za-z0-9_-]+)/.exec(
            branchOutput
          )?.[1];
          expect(childId).toBeTruthy();
          expect(branchOutput).toContain('session/load');
          if (!childId) throw new Error('ACP branch did not return a child session ID');

          await first.agent.destroy();
          firstAgent = undefined;
          await unlink(markerPath);

          const secondClient = new RecordingClient();
          const second = createHarness(secondClient);
          secondAgent = second.agent;
          await second.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const loaded = await second.connection.loadSession({
            sessionId: childId,
            cwd: workspace,
            mcpServers: [],
          });
          expect(loaded.models?.currentModelId).toBe(modelId);
          expect(replayedText(secondClient.updates)).toContain(
            'Read branch-marker.txt'
          );
          await second.connection.setSessionMode?.({
            sessionId: childId,
            modeId: 'yolo',
          });
          const continued = await second.connection.prompt({
            sessionId: childId,
            prompt: [
              {
                type: 'text',
                text:
                  'Use the exact marker from the earlier Read tool result. Write it as the only ' +
                  'line in branch-result.txt, then run Bash with "wc -c branch-result.txt" before finishing.',
              },
            ],
          });
          expect(continued.stopReason).toBe('end_turn');
          expect((await readFile(resultPath, 'utf8')).trim()).toBe(marker);
          expect(
            secondClient.updates.some(
              (notification) =>
                notification.update.sessionUpdate === 'tool_call' &&
                notification.update.title.includes('Bash')
            )
          ).toBe(true);
          expect(await SessionService.loadSession(parent.sessionId, workspace)).toEqual(
            parentMessagesBefore
          );
          const childMetadata = (await SessionService.listSessions()).find(
            (session) => session.sessionId === childId
          );
          expect(childMetadata).toMatchObject({
            parentId: parent.sessionId,
            relationType: 'fork',
          });
          expect(JSON.stringify(secondClient.updates)).not.toContain(
            modelConfig.apiKey
          );
        });
      } finally {
        await firstAgent?.destroy().catch(() => undefined);
        await secondAgent?.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 360_000);

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

    it(`${modelConfig.model} steers an active ACP prompt without aborting it`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-steering-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient();
      const session = new AcpSession(
        `acp-steering-${Date.now()}`,
        workspace,
        client as unknown as acp.AgentSideConnection,
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
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} auto-resumes durable input when ACP initializes`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-recovery-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      configureModel(modelConfig);
      const client = new RecordingClient();
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
            client as unknown as acp.AgentSideConnection,
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
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
