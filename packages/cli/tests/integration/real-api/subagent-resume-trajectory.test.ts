import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpSession } from '../../../src/acp/Session.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import {
  type AgentSession,
  type AgentSessionOwner,
  AgentSessionStore,
} from '../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../src/agent/subagents/BackgroundAgentManager.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { PermissionMode } from '../../../src/config/types.js';
import { BusEventSchema } from '../../../src/api/schemas.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { taskTool } from '../../../src/tools/builtin/task/task.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
import {
  buildRealApiRuntimeConfig,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

interface SurfaceEvent {
  type: string;
  properties: Record<string, unknown>;
}

interface SseCollector {
  events: SurfaceEvent[];
  waitFor: (
    predicate: (event: SurfaceEvent) => boolean,
    label: string
  ) => Promise<SurfaceEvent>;
  close: () => Promise<void>;
}

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

function resetSubagentState(): void {
  const existing = (
    BackgroundAgentManager as unknown as {
      instance?: BackgroundAgentManager | null;
    }
  ).instance;
  existing?.killAll();
  (
    BackgroundAgentManager as unknown as {
      instance: BackgroundAgentManager | null;
    }
  ).instance = null;
  (
    AgentSessionStore as unknown as {
      instance: AgentSessionStore | null;
    }
  ).instance = null;
}

function registerMemoryAgent(): void {
  subagentRegistry.clear();
  subagentRegistry.register({
    name: 'durable-memory',
    description: 'Follow-up code review agent',
    systemPrompt:
      'Act as a focused code review assistant. Use prior conversation context ' +
      'when answering follow-up questions. Do not call tools unless requested.',
    tools: ['Read'],
    permissionMode: PermissionMode.YOLO,
    maxTurns: 2,
  });
}

function seedSource(input: {
  id: string;
  owner: AgentSessionOwner;
  modelId: string;
  token: string;
}): AgentSession {
  const now = Date.now();
  const session: AgentSession = {
    schemaVersion: 2,
    id: input.id,
    subagentType: 'durable-memory',
    description: 'Track review module',
    prompt: `For this code review, the selected module codename is ${input.token}.`,
    messages: [
      {
        role: 'user',
        content: `For this code review, the selected module codename is ${input.token}.`,
      },
      {
        role: 'assistant',
        content: 'Acknowledged. I recorded the selected module codename.',
      },
    ],
    status: 'completed',
    result: {
      success: true,
      message: 'Acknowledged. I recorded the selected module codename.',
    },
    createdAt: now - 1,
    lastActiveAt: now,
    completedAt: now,
    parentSessionId: input.owner.sessionId,
    parentProjectPath: input.owner.projectPath,
    rootAgentId: input.id,
    resumeDepth: 0,
    workspaceRoot: input.owner.projectPath,
    isolation: 'none',
    configSnapshot: {
      name: 'durable-memory',
      description: 'Follow-up code review agent',
      systemPrompt:
        'Act as a focused code review assistant. Use prior conversation context ' +
        'when answering follow-up questions. Do not call tools unless requested.',
      tools: ['Read'],
      model: input.modelId,
      permissionMode: PermissionMode.YOLO,
      maxTurns: 2,
    },
  };
  AgentSessionStore.getInstance().saveSession(session);
  return session;
}

async function waitForTerminal(
  agentId: string,
  owner: AgentSessionOwner
): Promise<AgentSession> {
  const session = await BackgroundAgentManager.getInstance().waitForCompletion(
    agentId,
    180_000,
    owner
  );
  if (!session || session.status === 'running') {
    throw new Error(`Subagent did not reach a terminal state: ${agentId}`);
  }
  return session;
}

function assertResumeResult(
  sourceId: string,
  child: AgentSession,
  token: string
): void {
  expect(child).toMatchObject({
    status: 'completed',
    resumedFrom: sourceId,
    rootAgentId: sourceId,
    resumeDepth: 1,
  });
  expect(child.id).not.toBe(sourceId);
  expect(child.result?.message).toContain(token);
}

async function createSseCollector(
  app: ReturnType<typeof SessionRoutes>,
  owner: AgentSessionOwner
): Promise<SseCollector> {
  const controller = new AbortController();
  const response = await app.request(
    `/${owner.sessionId}/events?projectPath=${encodeURIComponent(owner.projectPath)}`,
    { signal: controller.signal }
  );
  if (!response.ok || !response.body) {
    throw new Error(`Failed to connect Web SSE: ${response.status}`);
  }
  const events: SurfaceEvent[] = [];
  const waiters = new Set<{
    predicate: (event: SurfaceEvent) => boolean;
    resolve: (event: SurfaceEvent) => void;
    reject: (error: Error) => void;
  }>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const reading = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const event = BusEventSchema.parse(JSON.parse(data));
          events.push(event);
          for (const waiter of waiters) {
            if (!waiter.predicate(event)) continue;
            waiters.delete(waiter);
            waiter.resolve(event);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        for (const waiter of waiters) {
          waiter.reject(error as Error);
        }
      }
    }
  })();

  const waitFor = (
    predicate: (event: SurfaceEvent) => boolean,
    label: string
  ): Promise<SurfaceEvent> => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for Web SSE ${label}`));
      }, 180_000);
      const waiter = {
        predicate,
        resolve: (event: SurfaceEvent) => {
          clearTimeout(timeout);
          resolve(event);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      waiters.add(waiter);
    });
  };

  return {
    events,
    waitFor,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading.catch(() => undefined);
    },
  };
}

const describeTrajectory = enabled ? describe.sequential : describe.skip;

describeTrajectory('Durable subagent resume trajectories (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} resumes a real root after runtime reconstruction`, async () => {
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-runtime-subagent-resume-')
      );
      const storageRoot = path.join(workspace, '.blade-storage');
      const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
      const owner = {
        sessionId: `runtime-subagent-${Date.now()}`,
        projectPath: workspace,
      };
      const sourceId = `agent-runtime-root-${Date.now()}`;
      const token = `runtime-module-${Date.now()}`;
      let runtime: SessionRuntime | undefined;

      try {
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        resetSubagentState();
        registerMemoryAgent();
        getState().config.actions.setConfig(runtimeConfig);
        const root = await taskTool
          .build({
            subagent_type: 'durable-memory',
            description: 'Remember runtime token',
            prompt:
              `For this code review, the selected module codename is ${token}. ` +
              'Acknowledge the selection in one short sentence.',
            run_in_background: false,
            subagent_session_id: sourceId,
          })
          .execute(new AbortController().signal, undefined, {
            sessionId: owner.sessionId,
            workspaceRoot: owner.projectPath,
            modelId: runtimeConfig.currentModelId,
            permissionMode: PermissionMode.YOLO,
          });
        expect(root.success).toBe(true);
        const sourcePath = path.join(
          storageRoot,
          'agents',
          'sessions',
          `${sourceId}.json`
        );
        const sourceBefore = await readFile(sourcePath, 'utf8');

        resetSubagentState();
        registerMemoryAgent();
        runtime = await SessionRuntime.create({
          sessionId: owner.sessionId,
          workspaceRoot: owner.projectPath,
          modelId: runtimeConfig.currentModelId,
        });
        const resumed = runtime.resumeSubagent({
          agentId: sourceId,
          prompt:
            'What module codename did we select earlier? Answer in one short sentence.',
        });
        const child = await waitForTerminal(resumed.session.id, owner);
        assertResumeResult(sourceId, child, token);
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceBefore);
        await expect(
          SessionService.findSessionMetadata(child.id, workspace)
        ).resolves.toMatchObject({
          relationType: 'subagent',
          resumedFrom: sourceId,
          rootAgentId: sourceId,
          resumeDepth: 1,
        });
        expect(JSON.stringify(child)).not.toContain(modelConfig.apiKey);
      } finally {
        await runtime?.dispose().catch(() => undefined);
        resetSubagentState();
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} resumes through Web HTTP and SSE`, async () => {
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-web-subagent-resume-')
      );
      const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
      const owner = {
        sessionId: `web-subagent-${Date.now()}`,
        projectPath: workspace,
      };
      const sourceId = `agent-web-root-${Date.now()}`;
      const token = `web-module-${Date.now()}`;
      const app = SessionRoutes();
      let collector: SseCollector | undefined;

      try {
        process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
        resetSubagentState();
        registerMemoryAgent();
        getState().config.actions.setConfig(runtimeConfig);
        await SessionService.createSessionMetadata(owner.sessionId, owner.projectPath, {
          title: 'Web subagent resume',
        });
        seedSource({
          id: sourceId,
          owner,
          modelId: runtimeConfig.currentModelId,
          token,
        });
        collector = await createSseCollector(app, owner);
        await collector.waitFor((event) => event.type === 'connected', 'connected');

        const response = await app.request(
          `/${owner.sessionId}/subagents/${sourceId}/resume?projectPath=${encodeURIComponent(owner.projectPath)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt:
                'What module codename did we select earlier? Answer in one short sentence.',
            }),
          }
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          source: { id: string };
          session: { id: string; resumedFrom?: string; resumeDepth: number };
        };
        expect(body).toMatchObject({
          source: { id: sourceId },
          session: { resumedFrom: sourceId, resumeDepth: 1 },
        });
        await collector.waitFor(
          (event) =>
            event.type === 'subagent.complete' &&
            event.properties.subagentSessionId === body.session.id,
          'subagent.complete'
        );
        const child = await waitForTerminal(body.session.id, owner);
        assertResumeResult(sourceId, child, token);
        expect(
          collector.events
            .filter((event) => event.type === 'subagent.delta')
            .map((event) => String(event.properties.delta ?? ''))
            .join('')
        ).toContain(token);
        expect(
          collector.events.find((event) => event.type === 'subagent.start')
        ).toMatchObject({
          properties: {
            subagentSessionId: body.session.id,
            resumedFrom: sourceId,
            rootAgentId: sourceId,
            resumeDepth: 1,
          },
        });
      } finally {
        await collector?.close();
        await app.request(
          `/${owner.sessionId}?projectPath=${encodeURIComponent(owner.projectPath)}`,
          { method: 'DELETE' }
        );
        resetSubagentState();
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} resumes through ACP slash control`, async () => {
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-acp-subagent-resume-')
      );
      const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
      const owner = {
        sessionId: `acp-subagent-${Date.now()}`,
        projectPath: workspace,
      };
      const sourceId = `agent-acp-root-${Date.now()}`;
      const token = `acp-module-${Date.now()}`;
      const client = createMockACPClient();
      const session = new AcpSession(
        owner.sessionId,
        owner.projectPath,
        client as never,
        {}
      );

      try {
        process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
        resetSubagentState();
        registerMemoryAgent();
        getState().config.actions.setConfig(runtimeConfig);
        seedSource({
          id: sourceId,
          owner,
          modelId: runtimeConfig.currentModelId,
          token,
        });
        await session.initialize();
        const response = await session.prompt({
          sessionId: owner.sessionId,
          prompt: [
            {
              type: 'text',
              text: `/tasks resume ${sourceId} What module codename did we select earlier? Answer in one short sentence.`,
            },
          ],
        });
        expect(response.stopReason).toBe('end_turn');

        const childId = (
          client.sessionUpdates.find(
            (notification) =>
              notification.update.sessionUpdate === 'tool_call' &&
              notification.update.title === 'Resuming durable-memory subagent'
          )?.update as { toolCallId?: string } | undefined
        )?.toolCallId;
        expect(childId).toBeTruthy();
        const child = await waitForTerminal(childId!, owner);
        assertResumeResult(sourceId, child, token);
        expect(client.sessionUpdates).toContainEqual(
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              toolCallId: childId,
              status: 'completed',
              content: expect.arrayContaining([
                expect.objectContaining({
                  content: expect.objectContaining({
                    text: expect.stringContaining(token),
                  }),
                }),
              ]),
            }),
          })
        );
        expect(JSON.stringify(client.sessionUpdates)).not.toContain(modelConfig.apiKey);
      } finally {
        await session.destroy().catch(() => undefined);
        resetSubagentState();
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
