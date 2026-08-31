import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, type TestContext } from 'vitest';
import { materializeRealApiEnvironment } from '../../../scripts/real-api-credentials.js';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { type BladeConfig, PermissionMode } from '../../../src/config/types.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  buildCanonicalRemoteFilesystemQualificationEvidence,
  buildRemoteFilesystemQualificationRuntimeConfig,
  digestCanonicalRemoteFilesystemQualificationEvidence,
  isBenignPairedAcpWriterCloseError,
  runRemoteFilesystemQualificationCleanup,
  withRemainingDeadline,
} from '../../support/acp/remoteFilesystemQualification.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

interface LoggedFileRequest {
  kind: 'read' | 'write';
  sessionId: string;
  path: string;
  contentSha256?: string;
}

interface NotificationSummary {
  sessionUpdate: acp.SessionNotification['update']['sessionUpdate'];
  title?: string | null;
  status?: string;
  toolCallId?: string;
  contentTypes?: string[];
}

class RemoteFilesystemClient implements acp.Client {
  readonly files = new Map<string, string>();
  readonly requests: LoggedFileRequest[] = [];
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

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    this.requests.push({
      kind: 'read',
      sessionId: params.sessionId,
      path: params.path,
    });
    const content = this.files.get(params.path);
    if (content === undefined) {
      throw acp.RequestError.resourceNotFound(params.path);
    }
    return { content };
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    this.requests.push({
      kind: 'write',
      sessionId: params.sessionId,
      path: params.path,
      contentSha256: sha256(params.content),
    });
    this.files.set(params.path, params.content);
    return {};
  }
}

interface PairedHarness {
  client: RemoteFilesystemClient;
  connection: acp.ClientSideConnection;
  close(input: { deadlineAt: number; bodyError?: unknown }): Promise<void>;
}

const ACP_REMOTE_TRAJECTORY_TIMEOUT_MS = 240_000;
const ACP_REMOTE_CLOSE_RESERVE_MS = 15_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonce(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

function createPairedHarness(): PairedHarness {
  const client = new RemoteFilesystemClient();
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  let closePromise: Promise<void> | undefined;
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    (productionConnection) => {
      agent = new BladeAgent(productionConnection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) {
    throw new Error('ACP remote filesystem trajectory agent was not created');
  }

  const closeWritable = async (
    writable: WritableStream<Uint8Array>,
    deadlineAt: number
  ): Promise<void> => {
    let writer: WritableStreamDefaultWriter<Uint8Array>;
    try {
      writer = writable.getWriter();
    } catch (error) {
      if (isBenignPairedAcpWriterCloseError(error)) return;
      throw error;
    }
    try {
      await withRemainingDeadline(async () => writer.close(), {
        deadlineAt,
        timeoutMessage: 'ACP writable close timed out',
      });
    } catch (error) {
      if (!isBenignPairedAcpWriterCloseError(error)) throw error;
    } finally {
      writer.releaseLock();
    }
  };

  const awaitClosed = async (
    target: Promise<void>,
    deadlineAt: number
  ): Promise<void> => {
    await withRemainingDeadline(async () => target, {
      deadlineAt,
      timeoutMessage: 'ACP transport close timed out',
    });
  };

  return {
    client,
    connection,
    close: ({ deadlineAt, bodyError }) => {
      closePromise ??= (async () => {
        const closeDeadline = Math.max(
          Date.now() + 1,
          deadlineAt - ACP_REMOTE_CLOSE_RESERVE_MS
        );
        await runRemoteFilesystemQualificationCleanup({
          bodyError,
          deadlineAt,
          operations: [
            {
              phase: 'agent_destroy',
              run: async () => {
                const createdAgent = agent;
                if (!createdAgent) {
                  throw new Error(
                    'ACP remote filesystem trajectory agent was not created'
                  );
                }
                await withRemainingDeadline(async () => createdAgent.destroy(), {
                  deadlineAt: closeDeadline,
                  timeoutMessage: 'ACP agent destroy timed out',
                });
              },
              timeoutMessage: 'ACP agent destroy timed out',
            },
            {
              phase: 'client_to_agent_close',
              run: async () => closeWritable(clientToAgent.writable, closeDeadline),
              timeoutMessage: 'ACP client-to-agent writable close timed out',
            },
            {
              phase: 'agent_to_client_close',
              run: async () => closeWritable(agentToClient.writable, closeDeadline),
              timeoutMessage: 'ACP agent-to-client writable close timed out',
            },
            {
              phase: 'client_connection_closed',
              run: async () => awaitClosed(connection.closed, deadlineAt),
              timeoutMessage: 'ACP client connection close timed out',
            },
            {
              phase: 'agent_connection_closed',
              run: async () => awaitClosed(agentConnection.closed, deadlineAt),
              timeoutMessage: 'ACP agent connection close timed out',
            },
          ],
        });
      })();
      return closePromise;
    },
  };
}

function createRuntimeConfig(model: TestModelConfig): BladeConfig {
  return buildRemoteFilesystemQualificationRuntimeConfig(
    buildRealApiRuntimeConfig(model)
  );
}

function finalAssistantText(updates: readonly acp.SessionNotification[]): string {
  return updates
    .map((notification) => notification.update)
    .flatMap((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? [update.content.text]
        : []
    )
    .join('');
}

function collectSuccessfulWriteResults(
  updates: readonly acp.SessionNotification[]
): Extract<acp.SessionNotification['update'], { sessionUpdate: 'tool_call_update' }>[] {
  const writeToolCallIds = updates.flatMap((notification) =>
    notification.update.sessionUpdate === 'tool_call' &&
    notification.update.title === 'Executing Write'
      ? [notification.update.toolCallId]
      : []
  );
  return updates.flatMap((notification) =>
    notification.update.sessionUpdate === 'tool_call_update' &&
    writeToolCallIds.includes(notification.update.toolCallId) &&
    notification.update.status === 'completed'
      ? [notification.update]
      : []
  );
}

function assertHostFilesystemUnchanged(input: {
  sourcePath: string;
  outputParent: string;
  sourceCanary: string;
}): void {
  expect(readFileSync(input.sourcePath, 'utf8')).toBe(input.sourceCanary);
  expect(statSync(input.sourcePath).isFile()).toBe(true);
  expect(() => statSync(input.outputParent)).toThrow();
}

function buildPrompt(input: {
  sourcePath: string;
  outputPath: string;
  finalMarker: string;
}): string {
  return [
    'You are operating against an ACP-owned remote filesystem.',
    `Use Read exactly once on the exact absolute path ${input.sourcePath}.`,
    `Use Write exactly once on the exact absolute path ${input.outputPath}.`,
    `Transform the remote source content by appending a final line FINAL_MARKER=${input.finalMarker}.`,
    'Do not use Edit, Bash, Glob, Grep, or any other tool.',
    'Do not retry Read or Write.',
    'After the successful Write, briefly confirm completion without repeating the full file content.',
  ].join(' ');
}

function summarizeNotifications(
  updates: readonly acp.SessionNotification[]
): NotificationSummary[] {
  return updates.map(({ update }) => ({
    sessionUpdate: update.sessionUpdate,
    title: 'title' in update ? update.title : undefined,
    status: 'status' in update ? String(update.status) : undefined,
    toolCallId: 'toolCallId' in update ? update.toolCallId : undefined,
    contentTypes:
      'content' in update && Array.isArray(update.content)
        ? update.content.map((content) => content.type)
        : undefined,
  }));
}

function normalizeFrameworkRetryBudget(context: TestContext): number {
  const retry = context.task.retry;
  if (typeof retry === 'number') return retry;
  return retry?.count ?? 0;
}

const deepseekModels = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels(
      materializeRealApiEnvironment(process.env)
    )
  : [];
const describeReal = deepseekModels.length === 2 ? describe.sequential : describe.skip;

describeReal('paired ACP remote filesystem qualification (real API)', () => {
  const fixtureRoots: string[] = [];
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
    }
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const model of deepseekModels) {
    it(
      `${model.qualificationId} keeps remote ownership through paired ACP filesystem tools`,
      async (context: TestContext) => {
        await ensureStoreInitialized();
        expect(context.task.retry).toBe(0);
        const fixtureRoot = mkdtempSync(
          path.join(os.tmpdir(), 'blade-real-api-acp-remote-fs-')
        );
        fixtureRoots.push(fixtureRoot);
        const workspace = path.join(fixtureRoot, 'workspace');
        const home = path.join(fixtureRoot, 'home');
        const storageRoot = path.join(fixtureRoot, 'storage');
        mkdirSync(workspace, { recursive: true });
        mkdirSync(home, { recursive: true });
        process.env.BLADE_STORAGE_ROOT = storageRoot;

        const sourcePath = path.join(workspace, 'inputs', 'source.txt');
        const outputPath = path.join(workspace, 'remote', 'nested', 'output.txt');
        const outputParent = path.dirname(outputPath);
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        mkdirSync(path.join(home, '.blade'), { recursive: true });
        const hostNonce = nonce('HOST_CANARY');
        const remoteNonce = nonce('REMOTE_TEXT');
        const finalMarker = `ACP_REMOTE_FS_OK_${nonce('marker')}`;
        const hostSource = `HOST_CANARY_${hostNonce}\nlocal host content must stay untouched\n`;
        const remoteSource =
          `REMOTE_SOURCE_${remoteNonce}\n` +
          `model=${model.model}\n` +
          'ownership=paired-acp\n';
        writeFileSync(sourcePath, hostSource, 'utf8');

        const runtimeConfig = createRuntimeConfig(model);
        const selectedModel = runtimeConfig.models.find(
          (entry) => entry.id === runtimeConfig.currentModelId
        );
        expect(selectedModel).toBeDefined();
        expect(selectedModel?.overrides?.maxRetries).toBe(0);
        writeFileSync(
          path.join(home, '.blade', 'config.json'),
          `${JSON.stringify(
            {
              currentModelId: runtimeConfig.currentModelId,
              models: runtimeConfig.models,
              modelProviders: runtimeConfig.modelProviders,
              permissionMode: 'yolo',
              hooks: { enabled: false },
              disableAllHooks: true,
              mcpServers: {},
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        );

        const harness = createPairedHarness();
        harness.client.files.set(sourcePath, remoteSource);
        const deadlineAt = Date.now() + ACP_REMOTE_TRAJECTORY_TIMEOUT_MS;
        const originalConfig = getState().config.config;
        let bodyError: unknown;

        try {
          getState().config.actions.setConfig(runtimeConfig);
          await runWithCwdOverride(workspace, async () => {
            await harness.connection.initialize({
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {
                fs: {
                  readTextFile: true,
                  writeTextFile: true,
                },
              },
            });
            const created = await harness.connection.newSession({
              cwd: workspace,
              mcpServers: [],
            });
            await harness.connection.setSessionMode({
              sessionId: created.sessionId,
              modeId: 'yolo',
            });
            const result = await withRemainingDeadline(
              async () =>
                harness.connection.prompt({
                  sessionId: created.sessionId,
                  prompt: [
                    {
                      type: 'text',
                      text: buildPrompt({ sourcePath, outputPath, finalMarker }),
                    },
                  ],
                }),
              {
                deadlineAt,
                timeoutMessage: 'ACP remote filesystem prompt timed out',
              }
            );
            expect(result.stopReason).toBe('end_turn');

            const output = harness.client.files.get(outputPath);
            expect(output).toBeDefined();
            if (!output) {
              throw new Error('expected remote output to exist');
            }
            const writeResults = collectSuccessfulWriteResults(harness.client.updates);
            expect(writeResults).toHaveLength(1);
            expect(harness.client.requests).toEqual([
              { kind: 'read', sessionId: created.sessionId, path: sourcePath },
              { kind: 'read', sessionId: created.sessionId, path: outputPath },
              {
                kind: 'write',
                sessionId: created.sessionId,
                path: outputPath,
                contentSha256: sha256(output),
              },
              { kind: 'read', sessionId: created.sessionId, path: outputPath },
            ]);
            expect(output).toContain(`FINAL_MARKER=${finalMarker}`);
            expect(output).not.toContain(`HOST_CANARY_${hostNonce}`);
            assertHostFilesystemUnchanged({
              sourcePath,
              outputParent,
              sourceCanary: hostSource,
            });

            const canonicalEvidence =
              buildCanonicalRemoteFilesystemQualificationEvidence({
                qualificationId: model.qualificationId,
                frameworkRetryBudget: normalizeFrameworkRetryBudget(context),
                sourcePath,
                outputPath,
                requests: harness.client.requests.map((request) => ({
                  kind: request.kind,
                  path: request.path,
                })),
                writeResultCount: writeResults.length,
                hostSourcePreserved: true,
                hostOutputParentAbsent: true,
                outputContainsFinalMarker: true,
                outputExcludesHostCanary: true,
              });
            const evidenceDigest =
              digestCanonicalRemoteFilesystemQualificationEvidence(canonicalEvidence);
            const evidence = {
              ...canonicalEvidence,
              notificationCount: harness.client.updates.length,
              writeResultCount: writeResults.length,
              evidenceDigest,
            };
            assertNoSecrets(
              {
                evidence,
                notifications: summarizeNotifications(harness.client.updates),
                finalText: finalAssistantText(harness.client.updates),
              },
              [model.apiKey, remoteSource]
            );
            expect(evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
          });
        } catch (error) {
          bodyError = error;
        } finally {
          if (originalConfig !== null) {
            try {
              getState().config.actions.setConfig(originalConfig);
            } catch (error) {
              bodyError =
                bodyError === undefined
                  ? error
                  : new AggregateError(
                      [bodyError, error],
                      'ACP remote filesystem qualification cleanup failed'
                    );
            }
          }
          await harness.close({ deadlineAt, bodyError });
        }
      },
      ACP_REMOTE_TRAJECTORY_TIMEOUT_MS
    );
  }
});
