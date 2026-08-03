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

  waitForUpdate(
    predicate: NotificationPredicate,
    timeoutMs: number,
    afterIndex = this.updates.length
  ): Promise<acp.SessionNotification> {
    if (this.closed) {
      return Promise.reject(new Error('recording client closed'));
    }
    if (!Number.isInteger(afterIndex) || afterIndex < 0) {
      return Promise.reject(new Error('notification boundary must be non-negative'));
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
    const waiting = client.waitForUpdate(
      (notification) =>
        notification.sessionId === 'child' &&
        notification.update.sessionUpdate === 'agent_message_chunk',
      1_000
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

  it('rejects pending notification waiters during teardown', async () => {
    const client = new RecordingClient();
    const waiting = client.waitForUpdate(() => false, 1_000);

    client.close();

    await expect(waiting).rejects.toThrow('recording client closed');
  });
});

const enabled = isRealApiTestEnabled();
if (enabled && !process.env.DEEPSEEK_API_KEY?.trim()) {
  throw new Error(
    'ACP fork qualification requires a DeepSeek key from the process environment'
  );
}
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
    const response = await connection.unstable_listSessions({ cwd, cursor });
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
            models: {
              currentModelId: runtimeConfig.currentModelId,
              availableModels: expect.arrayContaining([
                expect.objectContaining({
                  modelId: runtimeConfig.currentModelId,
                }),
              ]),
            },
          });
          const parentId = created.sessionId;
          const parentNotificationStart = harness.client.updates.length;
          await harness.connection.setSessionMode({
            sessionId: parentId,
            modeId: 'yolo',
          });
          const parentToolNotice = harness.client.waitForUpdate(
            (notification) =>
              notification.sessionId === parentId &&
              notification.update.sessionUpdate === 'tool_call' &&
              notification.update.title.includes('Read'),
            300_000
          );
          const [parentPrompt] = await Promise.all([
            harness.connection.prompt({
              sessionId: parentId,
              prompt: [
                {
                  type: 'text',
                  text: [
                    'Use Read on the workspace file named memory.txt.',
                    'Remember its complete contents for a later fork.',
                    'Do not repeat, quote, encode, or summarize the file contents in final prose.',
                    'After the successful Read, give a brief completion confirmation.',
                  ].join(' '),
                },
              ],
            }),
            parentToolNotice,
          ]);
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
          assertForkParentToolTrace(extractDurableToolTrace(parentEvents), memoryPath);
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
            title: null,
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
          expect(forkSetup).toEqual(newSetup);

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
          const childToolNotice = harness.client.waitForUpdate(
            (notification) =>
              notification.sessionId === childId &&
              notification.update.sessionUpdate === 'tool_call' &&
              notification.update.title.includes('Bash'),
            300_000
          );
          const [childPrompt] = await Promise.all([
            harness.connection.prompt({
              sessionId: childId,
              prompt: [
                {
                  type: 'text',
                  text: [
                    'Recover the complete marker from the inherited Read result.',
                    'Use Write to create result.txt with those exact bytes and exactly one trailing newline.',
                    'Then use Bash with exactly `wc -c result.txt`.',
                    'Use no other tools or commands, never repeat the marker in final prose, and briefly confirm completion.',
                  ].join(' '),
                },
              ],
            }),
            childToolNotice,
          ]);
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
