import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  assertForkChildToolTrace,
  assertForkLineage,
  assertForkParentToolTrace,
  assertNoSecrets,
  cleanupForkFixture,
  createForkFixture,
  extractDurableToolTrace,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

type NotificationPredicate = (notification: acp.SessionNotification) => boolean;

interface PendingNotificationWaiter {
  predicate: NotificationPredicate;
  resolve(notification: acp.SessionNotification): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationWaitOptions {
  afterIndex?: number;
  timeoutMs?: number;
}

class RecordingClient implements acp.Client {
  readonly updates: acp.SessionNotification[] = [];
  private readonly waiters = new Set<PendingNotificationWaiter>();
  private closed = false;

  async requestPermission(
    _params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    if (this.closed) return;
    this.updates.push(params);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(params)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(params);
    }
  }

  waitForNotification(
    predicate: NotificationPredicate,
    options: NotificationWaitOptions = {}
  ): Promise<acp.SessionNotification> {
    const afterIndex = options.afterIndex ?? 0;
    const timeoutMs = options.timeoutMs ?? 1_000;
    if (this.closed) {
      return Promise.reject(new Error('recording client closed'));
    }
    if (
      !Number.isInteger(afterIndex) ||
      afterIndex < 0 ||
      afterIndex > this.updates.length
    ) {
      return Promise.reject(new Error('notification boundary is invalid'));
    }
    const existing = this.updates.slice(afterIndex).find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter: PendingNotificationWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('timed out waiting for ACP session notification'));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('recording client closed'));
    }
    this.waiters.clear();
  }
}

interface PairedAcpHarness {
  client: RecordingClient;
  connection: acp.ClientSideConnection;
  close(): Promise<void>;
}

function createPairedHarness(client = new RecordingClient()): PairedAcpHarness {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;

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
  if (!agent) throw new Error('ACP Agent was not created');
  const productionAgent = agent;
  let closePromise: Promise<void> | undefined;

  return {
    client,
    connection,
    close: () => {
      closePromise ??= (async () => {
        let firstError: unknown;
        try {
          await productionAgent.destroy();
        } catch (error) {
          firstError = error;
        } finally {
          client.close();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeParentTrace(
  trace: ReturnType<typeof extractDurableToolTrace>,
  expectedPath: string
): {
  traceLength: number;
  records: Array<{
    toolName: string;
    inputKeys: string[];
    filePath: {
      basename: string | null;
      isAbsolute: boolean;
      equalsExpected: boolean;
    };
    outputType: string;
    outputNull: boolean;
    errorNull: boolean;
  }>;
} {
  return {
    traceLength: trace.length,
    records: trace.map((record) => {
      const input = isRecord(record.input) ? record.input : undefined;
      const filePath = typeof input?.file_path === 'string' ? input.file_path : null;
      return {
        toolName: record.toolName,
        inputKeys: input ? Object.keys(input).sort() : [],
        filePath: {
          basename: filePath === null ? null : path.basename(filePath),
          isAbsolute: filePath === null ? false : path.isAbsolute(filePath),
          equalsExpected: filePath === expectedPath,
        },
        outputType: record.output === null ? 'null' : typeof record.output,
        outputNull: record.output === null,
        errorNull: record.error === null,
      };
    }),
  };
}

function assertStrictParentTrace(
  trace: ReturnType<typeof extractDurableToolTrace>,
  memoryPath: string
): void {
  try {
    assertForkParentToolTrace(trace, memoryPath);
  } catch (error) {
    throw new Error(
      `ACP parent durable trace rejected: ${JSON.stringify(
        describeParentTrace(trace, memoryPath)
      )}`,
      { cause: error }
    );
  }
}

function assertKnownForkNotificationSessions(
  notifications: readonly acp.SessionNotification[],
  parentId: string,
  childId: string
): void {
  const foreign = notifications.find(
    (notification) =>
      notification.sessionId !== parentId && notification.sessionId !== childId
  );
  if (foreign) {
    throw new Error('ACP fork window contains a foreign session notification');
  }
}

function assertAllNotificationsForSession(
  notifications: readonly acp.SessionNotification[],
  expectedSessionId: string
): void {
  if (notifications.length === 0) {
    throw new Error('ACP notification ownership window must not be empty');
  }
  if (
    notifications.some((notification) => notification.sessionId !== expectedSessionId)
  ) {
    throw new Error('ACP notification ownership window contains an unexpected session');
  }
}

describe('ACP recording client lifecycle', () => {
  it('routes initialize through paired SDK streams and closes both connections', async () => {
    const harness = createPairedHarness();

    const initialized = await harness.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await harness.close();

    expect(initialized.agentCapabilities?.sessionCapabilities).toEqual({
      list: {},
      fork: {},
    });
    expect(harness.connection.signal.aborted).toBe(true);
  });

  it('resolves notification waiters from the matching incoming event', async () => {
    const client = new RecordingClient();
    const waiting = client.waitForNotification(
      (notification) =>
        notification.sessionId === 'child' &&
        notification.update.sessionUpdate === 'agent_message_chunk',
      { timeoutMs: 1_000 }
    );
    const update: acp.SessionNotification = {
      sessionId: 'child',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      },
    };

    await client.sessionUpdate(update);

    await expect(waiting).resolves.toBe(update);
    client.close();
  });

  it('resolves from a matching notification that arrived before the waiter', async () => {
    const client = new RecordingClient();
    const update: acp.SessionNotification = {
      sessionId: 'parent',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'yolo',
      },
    };
    await client.sessionUpdate(update);

    const waiting = client.waitForNotification(
      (notification) => notification.sessionId === 'parent',
      { timeoutMs: 100 }
    );

    await expect(waiting).resolves.toBe(update);
    client.close();
  });

  it('does not match notifications older than an explicit boundary', async () => {
    const client = new RecordingClient();
    await client.sessionUpdate({
      sessionId: 'child',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old' },
      },
    });
    const afterIndex = client.updates.length;
    const waiting = client.waitForNotification(
      (notification) =>
        notification.sessionId === 'child' &&
        notification.update.sessionUpdate === 'agent_message_chunk',
      { afterIndex, timeoutMs: 100 }
    );
    const fresh: acp.SessionNotification = {
      sessionId: 'child',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'fresh' },
      },
    };

    await client.sessionUpdate(fresh);

    await expect(waiting).resolves.toBe(fresh);
    client.close();
  });

  it('rejects pending notification waiters during teardown', async () => {
    const client = new RecordingClient();
    const waiting = client.waitForNotification(() => false, { timeoutMs: 1_000 });

    client.close();

    await expect(waiting).rejects.toThrow('recording client closed');
  });
});

describe('ACP parent trace diagnostics', () => {
  it('reports only structural metadata for a rejected Read trace', () => {
    const secretPath = '/private/tmp/secret-workspace/memory.txt';
    const secretOutput = 'must-not-appear';

    const metadata = describeParentTrace(
      [
        {
          toolCallId: 'tool-1',
          toolName: 'Read',
          input: { file_path: 'memory.txt', offset: 0 },
          output: secretOutput,
          error: null,
        },
      ],
      secretPath
    );

    expect(metadata).toEqual({
      traceLength: 1,
      records: [
        {
          toolName: 'Read',
          inputKeys: ['file_path', 'offset'],
          filePath: {
            basename: 'memory.txt',
            isAbsolute: false,
            equalsExpected: false,
          },
          outputType: 'string',
          outputNull: false,
          errorNull: true,
        },
      ],
    });
    expect(JSON.stringify(metadata)).not.toContain(secretPath);
    expect(JSON.stringify(metadata)).not.toContain(secretOutput);
  });
});

describe('ACP fork notification window', () => {
  it('accepts empty and known-session synchronous fork windows', () => {
    expect(() =>
      assertKnownForkNotificationSessions([], 'parent', 'child')
    ).not.toThrow();
    expect(() =>
      assertKnownForkNotificationSessions(
        [
          {
            sessionId: 'parent',
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'yolo',
            },
          },
          {
            sessionId: 'child',
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'default',
            },
          },
        ],
        'parent',
        'child'
      )
    ).not.toThrow();
  });

  it('rejects a synchronous fork notification for a foreign session', () => {
    expect(() =>
      assertKnownForkNotificationSessions(
        [
          {
            sessionId: 'foreign',
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'default',
            },
          },
        ],
        'parent',
        'child'
      )
    ).toThrow('foreign session');
  });

  it('requires a non-empty post-fork window owned by the child', () => {
    expect(() => assertAllNotificationsForSession([], 'child')).toThrow(
      'must not be empty'
    );
    expect(() =>
      assertAllNotificationsForSession(
        [
          {
            sessionId: 'child',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [],
            },
          },
        ],
        'child'
      )
    ).not.toThrow();
    expect(() =>
      assertAllNotificationsForSession(
        [
          {
            sessionId: 'parent',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [],
            },
          },
        ],
        'child'
      )
    ).toThrow('unexpected session');
  });
});

const enabled = isRealApiTestEnabled();
const modelConfigs = enabled
  ? resolveForkQualificationModels(process.env, { requiredDeepSeek: true })
  : [];

function safeModelLabel(
  modelConfig: (typeof modelConfigs)[number],
  ordinal: number
): string {
  const family = modelConfig.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const digest = createHash('sha256')
    .update(modelConfig.qualificationId)
    .digest('hex')
    .slice(0, 12);
  return `${family || 'model'}-${ordinal + 1}-${digest}`;
}

function createResolvedConfig(
  modelConfig: (typeof modelConfigs)[number]
): RuntimeConfig {
  const base = buildRealApiRuntimeConfig(modelConfig);
  return {
    ...base,
    permissionMode: PermissionMode.YOLO,
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpServers: {},
    allowedTools: ['Read'],
  };
}

function initializeIsolatedExtensions(
  fixture: ReturnType<typeof createForkFixture>
): void {
  const userSkillsDir = path.join(fixture.storageRoot, 'isolated-skills');
  const claudeUserSkillsDir = path.join(fixture.storageRoot, 'isolated-claude-skills');
  const projectSkillsDir = path.join(fixture.workspace, '.blade', 'skills');
  const claudeProjectSkillsDir = path.join(fixture.workspace, '.claude', 'skills');
  const skillCreatorDir = path.join(userSkillsDir, 'skill-creator');
  for (const directory of [
    skillCreatorDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    path.join(skillCreatorDir, 'SKILL.md'),
    '---\nname: skill-creator\ndescription: Local deterministic fixture.\n---\n\n# Fixture\n'
  );
  SkillRegistry.resetInstance();
  SkillRegistry.getInstance({
    cwd: fixture.workspace,
    userSkillsDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  });
  subagentRegistry.clear();
  subagentRegistry.loadBuiltinAgents();
}

function isMessageOrToolNotification(notification: acp.SessionNotification): boolean {
  return [
    'user_message_chunk',
    'agent_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
  ].includes(notification.update.sessionUpdate);
}

function finalAgentText(notifications: readonly acp.SessionNotification[]): string {
  return notifications
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

function assertSafeFinal(text: string, marker: string, nonce: string): void {
  if (!text.trim()) throw new Error('ACP final response must be non-empty text');
  if (text.includes(marker) || text.includes(nonce)) {
    throw new Error('ACP final response exposed fixture material');
  }
}

async function listUntilParent(
  connection: acp.ClientSideConnection,
  cwd: string,
  parentId: string
): Promise<{
  parent: acp.SessionInfo;
  responses: acp.ListSessionsResponse[];
  sessions: Map<string, acp.SessionInfo>;
}> {
  const responses: acp.ListSessionsResponse[] = [];
  const sessions = new Map<string, acp.SessionInfo>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const response = await connection.listSessions({ cwd, cursor });
    responses.push(response);
    for (const session of response.sessions) sessions.set(session.sessionId, session);
    const parent = sessions.get(parentId);
    if (parent) return { parent, responses, sessions };
    const nextCursor = response.nextCursor ?? undefined;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error('ACP session list returned a cursor cycle');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error('ACP parent session was not returned by session/list');
}

const describeTrajectory = enabled ? describe.sequential : describe.skip;

describeTrajectory('ACP durable fork trajectory (real API)', () => {
  if (modelConfigs.length === 0) {
    it('requires REAL_API_TEST=1', () => undefined);
  }

  for (const [modelIndex, modelConfig] of modelConfigs.entries()) {
    const modelLabel = safeModelLabel(modelConfig, modelIndex);
    it(`${modelLabel} forks inherited Read evidence through paired SDK connections`, async () => {
      const fixture = createForkFixture('acp', modelLabel);
      const marker = `ACP_FORK_MARKER_${fixture.nonce}`;
      const expectedBytes = `${marker}\n`;
      const memoryPath = path.join(fixture.workspace, 'memory.txt');
      const resultPath = path.join(fixture.workspace, 'result.txt');
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
      const hookManager = HookManager.getInstance();
      const hooksWereEnabled = hookManager.isEnabled();
      let originalConfig: RuntimeConfig | null = null;
      let harness: PairedAcpHarness | undefined;

      assertNoSecrets({ marker, expectedBytes }, [modelConfig.apiKey]);

      try {
        process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        hookManager.disable();
        initializeIsolatedExtensions(fixture);
        await ensureStoreInitialized();
        originalConfig = getState().config.config;
        const runtimeConfig = createResolvedConfig(modelConfig);
        getState().config.actions.setConfig(runtimeConfig);
        writeFileSync(memoryPath, expectedBytes);

        await runWithCwdOverride(fixture.workspace, async () => {
          harness = createPairedHarness();
          const initialized = await harness.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          expect(initialized.agentCapabilities?.sessionCapabilities).toEqual({
            list: {},
            fork: {},
          });

          const newSessionNotificationStart = harness.client.updates.length;
          const created = await harness.connection.newSession({
            cwd: fixture.workspace,
            mcpServers: [],
          });
          expect(created).toMatchObject({
            modes: {
              currentModeId: 'default',
              availableModes: expect.arrayContaining([
                expect.objectContaining({ id: 'yolo' }),
              ]),
            },
            configOptions: expect.arrayContaining([
              expect.objectContaining({
                type: 'select',
                id: 'model',
                category: 'model',
                currentValue: runtimeConfig.currentModelId,
                options: expect.arrayContaining([
                  expect.objectContaining({
                    value: runtimeConfig.currentModelId,
                  }),
                ]),
              }),
            ]),
          });
          const parentId = created.sessionId;
          const parentCommands = await harness.client.waitForNotification(
            (notification) =>
              notification.sessionId === parentId &&
              notification.update.sessionUpdate === 'available_commands_update',
            { afterIndex: newSessionNotificationStart, timeoutMs: 10_000 }
          );
          expect(parentCommands.sessionId).toBe(parentId);
          const parentNotificationStart = harness.client.updates.length;
          await harness.connection.setSessionMode({
            sessionId: parentId,
            modeId: 'yolo',
          });
          const parentPrompt = await harness.connection.prompt({
            sessionId: parentId,
            prompt: [
              {
                type: 'text',
                text: [
                  `Use Read on the workspace file at the exact absolute path ${memoryPath}.`,
                  'Remember its complete contents for a later fork.',
                  'Do not repeat, quote, encode, or summarize the file contents in final prose.',
                  'After the successful Read, give a brief completion confirmation.',
                ].join(' '),
              },
            ],
          });
          expect(parentPrompt.stopReason).toBe('end_turn');
          const parentNotifications = harness.client.updates.slice(
            parentNotificationStart
          );
          expect(
            parentNotifications.every(
              (notification) => notification.sessionId === parentId
            )
          ).toBe(true);
          assertSafeFinal(finalAgentText(parentNotifications), marker, fixture.nonce);

          const parentPath = findSessionTranscript(fixture.storageRoot, parentId);
          const parentEvents = readSessionEvents(parentPath);
          assertStrictParentTrace(extractDurableToolTrace(parentEvents), memoryPath);
          const parentSnapshot = readFileSync(parentPath);

          const listed = await listUntilParent(
            harness.connection,
            fixture.workspace,
            parentId
          );
          expect(listed.sessions.size).toBe(1);
          expect(listed.parent).toMatchObject({
            sessionId: parentId,
            cwd: fixture.workspace,
            title: expect.stringContaining('Use Read'),
          });
          expect(typeof listed.parent.updatedAt).toBe('string');
          expect(Number.isNaN(Date.parse(listed.parent.updatedAt ?? ''))).toBe(false);

          getState().config.actions.updateConfig({
            allowedTools: ['Write', 'Bash'],
          });
          const forkNotificationStart = harness.client.updates.length;
          const forked = await harness.connection.unstable_forkSession({
            sessionId: parentId,
            cwd: fixture.workspace,
            mcpServers: [],
          });
          const forkNotifications = harness.client.updates.slice(forkNotificationStart);
          assertKnownForkNotificationSessions(
            forkNotifications,
            parentId,
            forked.sessionId
          );
          expect(
            forkNotifications.filter(
              (notification) =>
                notification.sessionId === forked.sessionId &&
                (notification.update.sessionUpdate === 'user_message_chunk' ||
                  notification.update.sessionUpdate === 'agent_message_chunk')
            )
          ).toEqual([]);
          const { sessionId: _parentId, ...newSetup } = created;
          const { sessionId: childId, ...forkSetup } = forked;
          expect(childId).not.toBe(parentId);
          expect(forkSetup).toMatchObject({
            ...newSetup,
            modes: {
              ...newSetup.modes,
              currentModeId: 'yolo',
            },
          });
          expect(forkSetup._meta).toMatchObject({
            'blade/taskIsolation': 'local',
            'blade/taskSourceProjectPath': fixture.workspace,
            'blade/taskProjectPath': fixture.workspace,
          });

          getState().config.actions.updateConfig({
            allowedTools: ['Write', 'Bash'],
          });
          await harness.connection.setSessionMode({
            sessionId: childId,
            modeId: 'yolo',
          });
          const childPath = findSessionTranscript(fixture.storageRoot, childId);
          const childSnapshot = readSessionEvents(childPath);
          rmSync(memoryPath);
          expect(existsSync(memoryPath)).toBe(false);

          const childNotificationStart = harness.client.updates.length;
          const childPrompt = await harness.connection.prompt({
            sessionId: childId,
            prompt: [
              {
                type: 'text',
                text: [
                  'Recover the complete marker from the inherited Read result.',
                  `Use Write on the exact absolute path ${resultPath} with those exact bytes and exactly one trailing newline.`,
                  'Then use Bash with exactly `wc -c result.txt`.',
                  'Use no other tools or commands, never repeat the marker in final prose, and briefly confirm completion.',
                ].join(' '),
              },
            ],
          });
          expect(childPrompt.stopReason).toBe('end_turn');
          const childNotifications =
            harness.client.updates.slice(childNotificationStart);
          expect(
            childNotifications
              .filter(isMessageOrToolNotification)
              .every((notification) => notification.sessionId === childId)
          ).toBe(true);
          assertSafeFinal(finalAgentText(childNotifications), marker, fixture.nonce);
          expect(readFileSync(resultPath, 'utf8')).toBe(expectedBytes);
          const childCommands = await harness.client.waitForNotification(
            (notification) =>
              notification.sessionId === childId &&
              notification.update.sessionUpdate === 'available_commands_update',
            { afterIndex: forkNotificationStart, timeoutMs: 10_000 }
          );
          expect(childCommands.sessionId).toBe(childId);
          const postForkNotifications =
            harness.client.updates.slice(forkNotificationStart);
          assertAllNotificationsForSession(postForkNotifications, childId);

          const childEvents = readSessionEvents(childPath);
          const childRaw = readFileSync(childPath);
          assertForkChildToolTrace(
            extractDurableToolTrace(childEvents, {
              afterEventCount: childSnapshot.length,
            }),
            resultPath,
            expectedBytes
          );
          assertForkLineage(childEvents, {
            childId,
            parentId,
            rootId: parentId,
          });
          expect(childEvents.length).toBeGreaterThan(childSnapshot.length);
          const parentEventIds = new Set(parentEvents.map((event) => event.id));
          expect(childEvents.every((event) => !parentEventIds.has(event.id))).toBe(
            true
          );
          expect(readFileSync(parentPath).equals(parentSnapshot)).toBe(true);
          expect(existsSync(fixture.resultPath)).toBe(false);

          assertNoSecrets(
            {
              initialized,
              created,
              listResponses: listed.responses,
              forked,
              parentPrompt,
              childPrompt,
              notifications: harness.client.updates,
              parentSnapshot,
              childRaw,
              resultBytes: readFileSync(resultPath),
            },
            [modelConfig.apiKey]
          );

          await harness.close();
          harness = undefined;
        });
      } finally {
        await runWithCwdOverride(fixture.workspace, async () => {
          await harness?.close().catch(() => undefined);
        });
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        SkillRegistry.resetInstance();
        subagentRegistry.clear();
        subagentRegistry.loadBuiltinAgents();
        if (hooksWereEnabled) hookManager.enable();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        if (originalAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
        cleanupForkFixture(fixture);
      }
    }, 360_000);
  }
});
