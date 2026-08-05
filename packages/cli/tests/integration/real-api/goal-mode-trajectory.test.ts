import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AcpSession } from '../../../src/acp/Session.js';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import type { LoopEvent } from '../../../src/agent/loop/types.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { GoalStore } from '../../../src/goals/GoalStore.js';
import { Bus } from '../../../src/server/bus.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
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

describe.skipIf(!enabled)('Goal mode trajectory (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} verifies the objective and lets the model complete the goal`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-mode-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const sessionId = `goal-mode-${modelConfig.id}-${Date.now()}`;
      const resultPath = path.join(workspace, 'goal-result.txt');
      let runtime: SessionRuntime | undefined;
      let agent: Agent | undefined;

      try {
        runtime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        const created = await runtime.createGoal({
          objective:
            'Create goal-result.txt in the workspace with the exact content ' +
            'GOAL_MODE_COMPLETE. Read the file after writing it and verify the exact ' +
            'content. Only after that verification, call UpdateGoal with status complete.',
          tokenBudget: 200_000,
        });
        expect(created.status).toBe('active');

        agent = await Agent.createWithRuntime(runtime, { sessionId });
        const context: ChatContext = {
          messages: [],
          userId: 'goal-mode-real-api',
          sessionId,
          workspaceRoot: workspace,
          permissionMode: 'yolo' as ChatContext['permissionMode'],
        };
        const events: LoopEvent[] = [];
        const result = await drainLoop(
          agent.chatStream('', context, {
            stream: true,
            goalContinuationOnly: true,
          }),
          (event) => {
            events.push(event);
          }
        );

        expect(result.success).toBe(true);
        await expect(access(resultPath)).resolves.toBeUndefined();
        expect((await readFile(resultPath, 'utf8')).trim()).toBe('GOAL_MODE_COMPLETE');
        await expect(runtime.getGoal()).resolves.toMatchObject({
          status: 'complete',
          objective: created.objective,
        });

        const toolNames = events.flatMap((event) =>
          event.kind === 'tool_start' && 'function' in event.toolCall
            ? [event.toolCall.function.name]
            : []
        );
        expect(toolNames.some((name) => name === 'Write' || name === 'Bash')).toBe(
          true
        );
        expect(toolNames).toContain('Read');
        expect(toolNames).toContain('UpdateGoal');
        expect(toolNames.indexOf('Read')).toBeLessThan(toolNames.indexOf('UpdateGoal'));
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'goal_continuation_started',
          })
        );
        expect(context.messages).not.toContainEqual(
          expect.objectContaining({
            metadata: { transientGoalContinuation: true },
          })
        );

        const transcript = await readFile(
          getSessionFilePath(workspace, sessionId),
          'utf8'
        );
        expect(transcript).not.toContain('transientGoalContinuation');
        expect(transcript).not.toContain('<goal-state>');
        expect(JSON.stringify(events)).not.toContain(modelConfig.apiKey);
      } finally {
        await agent?.destroy().catch(() => undefined);
        await runtime?.dispose().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} completes a goal through Web REST and lifecycle events`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-web-goal-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const resultPath = path.join(workspace, 'web-goal-result.txt');
      const events: Array<{
        type: string;
        sessionId: string;
        properties: Record<string, unknown>;
      }> = [];
      const unsubscribe = Bus.subscribe((event) => {
        events.push({
          type: event.type,
          sessionId: event.sessionId,
          properties: event.properties,
        });
      });
      const app = SessionRoutes();
      let sessionId = '';

      try {
        const createdSession = await app.request('/', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectPath: workspace,
            title: 'Web goal real API',
          }),
        });
        expect(createdSession.status).toBe(200);
        sessionId = ((await createdSession.json()) as { sessionId: string }).sessionId;

        const response = await app.request(`/${sessionId}/goal`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            objective:
              'Create web-goal-result.txt with the exact content WEB_GOAL_COMPLETE. ' +
              'Read it back, verify the exact content, then call UpdateGoal complete.',
            tokenBudget: 200_000,
            permissionMode: 'yolo',
          }),
        });
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({
          status: 'running',
          goal: { status: 'active' },
        });

        await vi.waitUntil(
          async () => {
            const goal = await new GoalStore(workspace, sessionId).get();
            if (goal && goal.status !== 'active' && goal.status !== 'complete') {
              const tools = events.flatMap((event) =>
                event.type === 'tool.start' &&
                typeof event.properties.toolName === 'string'
                  ? [event.properties.toolName]
                  : []
              );
              throw new Error(
                `Web goal stopped as ${goal.status} after ` +
                  `${goal.continuationCount} continuations and ` +
                  `${goal.tokensUsed} tokens; tools=${tools.join(',')}`
              );
            }
            return goal?.status === 'complete';
          },
          { timeout: 180_000, interval: 100 }
        );
        await vi.waitFor(
          () => {
            expect(
              events.some(
                (event) =>
                  event.sessionId === sessionId &&
                  event.type === 'goal.continuation.started'
              )
            ).toBe(true);
            expect(
              events.some(
                (event) =>
                  event.sessionId === sessionId && event.type === 'session.completed'
              )
            ).toBe(true);
          },
          { timeout: 30_000, interval: 50 }
        );
        expect((await readFile(resultPath, 'utf8')).trim()).toBe('WEB_GOAL_COMPLETE');
      } finally {
        unsubscribe();
        if (sessionId) {
          await app.request(`/${sessionId}`, { method: 'DELETE' });
        }
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} completes a goal started by ACP slash command`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-goal-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const sessionId = `acp-goal-${modelConfig.id}-${Date.now()}`;
      const resultPath = path.join(workspace, 'acp-goal-result.txt');
      const client = createMockACPClient();
      const session = new AcpSession(sessionId, workspace, client as never, {});

      try {
        await session.initialize();
        await session.setMode('yolo');
        const response = await session.prompt({
          sessionId,
          prompt: [
            {
              type: 'text',
              text:
                '/goal Create acp-goal-result.txt with the exact content ' +
                'ACP_GOAL_COMPLETE. Read it back, verify the exact content, then ' +
                'call UpdateGoal complete. --budget 200000',
            },
          ],
        });
        expect(response.stopReason).toBe('end_turn');

        await vi.waitFor(
          async () => {
            await expect(
              new GoalStore(workspace, sessionId).get()
            ).resolves.toMatchObject({
              status: 'complete',
            });
            expect((await readFile(resultPath, 'utf8')).trim()).toBe(
              'ACP_GOAL_COMPLETE'
            );
          },
          { timeout: 180_000, interval: 100 }
        );
        expect(
          client.sessionUpdates.some(
            (notification) =>
              notification.update.sessionUpdate === 'tool_call' &&
              notification.update.title.includes('UpdateGoal')
          )
        ).toBe(true);
        expect(JSON.stringify(client.sessionUpdates)).not.toContain(modelConfig.apiKey);
      } finally {
        await session.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
