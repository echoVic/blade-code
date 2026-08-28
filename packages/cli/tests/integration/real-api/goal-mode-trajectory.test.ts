import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];
const modelConfigs =
  process.env.REAL_API_RELEASE_MATRIX === '1'
    ? enabledModels.filter((config) => config.id === 'deepseek').slice(0, 1)
    : enabledModels;
const enabled = modelConfigs.length > 0;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

async function createGoalFixture(
  workspace: string,
  resultFile: string,
  marker: string
): Promise<void> {
  await writeFile(path.join(workspace, resultFile), `${marker}\n`);
}

function formatGoalFailure(
  result: Awaited<ReturnType<typeof drainLoop>>,
  goal: Awaited<ReturnType<SessionRuntime['getGoal']>>,
  events: readonly LoopEvent[],
  runtime: SessionRuntime
): string {
  return JSON.stringify(
    {
      success: result.success,
      errorType: result.error?.type,
      errorMessage: result.error?.message,
      goalStatus: goal?.status,
      goalReason: goal?.statusReason,
      completionVerification: goal?.completionVerification,
      tools: events.flatMap((event) =>
        event.kind === 'tool_start' && 'function' in event.toolCall
          ? [event.toolCall.function.name]
          : []
      ),
      goalEvents: events.flatMap((event) =>
        event.kind === 'goal_updated' && event.goal
          ? [
              {
                status: event.goal.status,
                attempt: event.goal.completionVerification?.attempt,
                verificationStatus: event.goal.completionVerification?.status,
                verificationSummary: event.goal.completionVerification?.summary,
                verificationStall: event.goal.verificationStall,
              },
            ]
          : []
      ),
      subagents: runtime.listSubagents().map((session) => ({
        id: session.id,
        type: session.subagentType,
        status: session.status,
        verdict: session.result?.verificationVerdict,
        error: session.result?.error,
        message: session.result?.message.slice(0, 500),
      })),
    },
    null,
    2
  );
}

async function waitForWebGoalCompletion(
  workspace: string,
  sessionId: string,
  events: ReadonlyArray<{
    type: string;
    sessionId: string;
    properties: Record<string, unknown>;
  }>,
  timeoutMs = 180_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const goal = await new GoalStore(workspace, sessionId).get();
    if (goal?.status === 'complete') return;
    if (goal && goal.status !== 'active' && goal.status !== 'verifying') {
      throw new Error(formatWebGoalFailure(goal, events));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const goal = await new GoalStore(workspace, sessionId).get();
  throw new Error(formatWebGoalFailure(goal, events, 'timeout'));
}

function formatWebGoalFailure(
  goal: Awaited<ReturnType<GoalStore['get']>>,
  events: ReadonlyArray<{
    type: string;
    sessionId: string;
    properties: Record<string, unknown>;
  }>,
  reason = 'terminal'
): string {
  return JSON.stringify(
    {
      reason,
      goal,
      tools: events.flatMap((event) =>
        event.type === 'tool.start' && typeof event.properties.toolName === 'string'
          ? [event.properties.toolName]
          : []
      ),
      subagents: events
        .filter((event) => event.type === 'subagent.complete')
        .map((event) => event.properties),
      failures: events
        .filter(
          (event) =>
            event.type === 'session.failed' ||
            event.type === 'run.error' ||
            event.type === 'task.status'
        )
        .map((event) => ({
          type: event.type,
          properties: event.properties,
        })),
    },
    null,
    2
  );
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

describe.skipIf(!enabled)('Goal mode trajectory (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} completes only after an independent host verifier PASS`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-mode-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const sessionId = `goal-mode-${modelConfig.id}-${Date.now()}`;
      const resultPath = path.join(workspace, 'goal-result.txt');
      let runtime: SessionRuntime | undefined;
      let agent: Agent | undefined;

      try {
        await createGoalFixture(workspace, 'goal-result.txt', 'GOAL_MODE_COMPLETE');
        runtime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        const created = await runtime.createGoal({
          objective:
            'Inspect the existing goal-result.txt and verify that its exact trimmed ' +
            'content is GOAL_MODE_COMPLETE. Do not modify files or run unrelated ' +
            'checks. After Read proves the exact content, immediately call UpdateGoal ' +
            'with status complete.',
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

        const currentGoal = await runtime.getGoal();
        expect(
          result.success,
          formatGoalFailure(result, currentGoal, events, runtime)
        ).toBe(true);
        await expect(access(resultPath)).resolves.toBeUndefined();
        expect((await readFile(resultPath, 'utf8')).trim()).toBe('GOAL_MODE_COMPLETE');
        const completedGoal = await runtime.getGoal();
        expect(completedGoal).toMatchObject({
          status: 'complete',
          objective: created.objective,
          completionVerification: {
            status: 'pass',
            verifierSessionId: expect.any(String),
            summary: expect.any(String),
            evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        });
        expect(completedGoal?.completionVerification?.summary).not.toBe(
          'Independent verifier returned PASS.'
        );
        const verificationAttempt =
          completedGoal?.completionVerification?.attempt ?? Number.NaN;
        expect(Number.isSafeInteger(verificationAttempt)).toBe(true);
        expect(verificationAttempt).toBeGreaterThanOrEqual(1);

        const toolNames = events.flatMap((event) =>
          event.kind === 'tool_start' && 'function' in event.toolCall
            ? [event.toolCall.function.name]
            : []
        );
        expect(toolNames).toContain('Read');
        expect(toolNames).toContain('UpdateGoal');
        expect(toolNames).toContain('Task');
        expect(toolNames.indexOf('Read')).toBeLessThan(toolNames.indexOf('UpdateGoal'));
        expect(toolNames.indexOf('UpdateGoal')).toBeLessThan(
          toolNames.lastIndexOf('Task')
        );
        expect(
          events.some(
            (event) =>
              event.kind === 'goal_updated' && event.goal?.status === 'verifying'
          )
        ).toBe(true);
        expect(
          events.some(
            (event) =>
              event.kind === 'subagent_completed' &&
              event.type === 'goal-verification' &&
              event.verificationVerdict === 'pass'
          )
        ).toBe(true);
        expect(
          runtime
            .listSubagents()
            .some(
              (session) =>
                session.id ===
                  completedGoal?.completionVerification?.verifierSessionId &&
                session.subagentType === 'goal-verification' &&
                session.result?.verificationVerdict === 'pass'
            )
        ).toBe(true);
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'goal_continuation_started',
          })
        );
        const frontierEvent = events.find(
          (event): event is Extract<LoopEvent, { kind: 'goal_frontier_updated' }> =>
            event.kind === 'goal_frontier_updated'
        );
        expect(frontierEvent).toMatchObject({
          goal: { goalId: created.goalId },
          frontier: {
            taskListId: `goal:${sessionId}:${created.goalId}`,
            total: 0,
            completed: 0,
            inProgress: 0,
            pending: 0,
            blocked: 0,
          },
          tasks: [],
        });
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

    it(`${modelConfig.model} recovers a premature Goal stop without user input`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-recovery-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const sessionId = `goal-recovery-${modelConfig.id}-${Date.now()}`;
      const resultPath = path.join(workspace, 'goal-recovery.txt');
      let runtime: SessionRuntime | undefined;
      let agent: Agent | undefined;

      try {
        runtime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        await runtime.createGoal({
          tokenBudget: 120_000,
          objective:
            'Follow the Continuation number in the host goal-state exactly. When ' +
            'Continuation is 1, use no tools and output exactly: I will check back ' +
            'later. When Continuation is 2 or greater, write GOAL_RECOVERY_COMPLETE ' +
            'followed by a newline to goal-recovery.txt, read the file to verify its ' +
            'exact content, then call UpdateGoal with status complete.',
        });
        agent = await Agent.createWithRuntime(runtime, { sessionId });
        const context: ChatContext = {
          messages: [],
          userId: 'goal-recovery-real-api',
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

        const currentGoal = await runtime.getGoal();
        expect(
          result.success,
          formatGoalFailure(result, currentGoal, events, runtime)
        ).toBe(true);
        expect(await readFile(resultPath, 'utf8')).toBe('GOAL_RECOVERY_COMPLETE\n');
        expect(currentGoal).toMatchObject({
          status: 'complete',
          completionVerification: { attempt: 1, status: 'pass' },
        });
        expect(
          events.some(
            (event) =>
              event.kind === 'goal_updated' &&
              (event.goal?.completionVerification?.status === 'fail' ||
                event.goal?.completionVerification?.status === 'partial')
          )
        ).toBe(false);
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'goal_continuation_started',
            prematureStopPattern: 'self_deferral',
            prematureStopCount: 1,
          })
        );
        const transcript = await readFile(
          getSessionFilePath(workspace, sessionId),
          'utf8'
        );
        expect(transcript).toContain('I will check back later.');
        expect(transcript).not.toContain('<goal-liveness>');
        expect(JSON.stringify(events)).not.toContain(modelConfig.apiKey);
      } finally {
        await agent?.destroy().catch(() => undefined);
        await runtime?.dispose().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} repairs from durable verifier feedback`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-feedback-'));
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      const sessionId = `goal-feedback-${modelConfig.id}-${Date.now()}`;
      const resultPath = path.join(workspace, 'goal-feedback.txt');
      let runtime: SessionRuntime | undefined;
      let agent: Agent | undefined;
      let removedFirstCandidate = false;
      let deletionTimer: NodeJS.Timeout | undefined;
      let deletionChain = Promise.resolve();

      try {
        runtime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        await runtime.createGoal({
          tokenBudget: 160_000,
          objective:
            'Create goal-feedback.txt containing exactly GOAL_FEEDBACK_COMPLETE ' +
            'followed by a newline, read it back, and call UpdateGoal complete.',
        });
        agent = await Agent.createWithRuntime(runtime, { sessionId });
        const context: ChatContext = {
          messages: [],
          userId: 'goal-feedback-real-api',
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
          async (event) => {
            events.push(event);
            if (
              !removedFirstCandidate &&
              event.kind === 'goal_updated' &&
              event.goal?.status === 'verifying' &&
              event.goal.completionVerification?.status === 'pending' &&
              event.goal.completionVerification.attempt === 1
            ) {
              removedFirstCandidate = true;
              await rm(resultPath, { force: true });
              deletionTimer = setInterval(() => {
                deletionChain = deletionChain.then(() =>
                  rm(resultPath, { force: true })
                );
              }, 10);
            } else if (
              deletionTimer &&
              event.kind === 'goal_updated' &&
              event.goal?.completionVerification?.status !== undefined &&
              event.goal.completionVerification.status !== 'pending'
            ) {
              clearInterval(deletionTimer);
              deletionTimer = undefined;
              await deletionChain;
            }
          }
        );

        const currentGoal = await runtime.getGoal();
        expect(
          result.success,
          formatGoalFailure(result, currentGoal, events, runtime)
        ).toBe(true);
        expect(removedFirstCandidate).toBe(true);
        expect(await readFile(resultPath, 'utf8')).toBe('GOAL_FEEDBACK_COMPLETE\n');
        expect(currentGoal).toMatchObject({
          status: 'complete',
          completionVerification: {
            attempt: expect.any(Number),
            status: 'pass',
            summary: expect.any(String),
          },
        });
        expect(currentGoal?.verificationStall).toBeUndefined();
        expect(currentGoal?.completionVerification?.attempt).toBe(1);
        const verifierEvents = events.filter(
          (event): event is Extract<LoopEvent, { kind: 'subagent_completed' }> =>
            event.kind === 'subagent_completed' && event.type === 'goal-verification'
        );
        expect(verifierEvents.length).toBeGreaterThanOrEqual(2);
        expect(verifierEvents.map((event) => event.verificationVerdict)).toEqual(
          expect.arrayContaining(['fail', 'pass'])
        );
        const rejectedGoal = events.find(
          (event) =>
            event.kind === 'goal_updated' &&
            event.goal?.completionVerification?.status === 'fail'
        );
        expect(rejectedGoal).toMatchObject({
          kind: 'goal_updated',
          goal: {
            verificationStall: {
              feedbackSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              consecutiveCount: 1,
            },
          },
        });
        if (rejectedGoal?.kind !== 'goal_updated') {
          throw new Error('Expected a rejected Goal snapshot');
        }
        expect(rejectedGoal.goal?.completionVerification?.summary).toBeTruthy();
        expect(rejectedGoal.goal?.completionVerification?.summary).not.toBe(
          'Independent verifier returned FAIL.'
        );
        const transcript = await readFile(
          getSessionFilePath(workspace, sessionId),
          'utf8'
        );
        expect(transcript).toContain('"verificationFeedback"');
        expect(transcript).not.toContain('<goal-verification-feedback>');
        expect(transcript).not.toContain(modelConfig.apiKey);
      } finally {
        if (deletionTimer) clearInterval(deletionTimer);
        await deletionChain.catch(() => undefined);
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
        await createGoalFixture(workspace, 'web-goal-result.txt', 'WEB_GOAL_COMPLETE');
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
              'Inspect the existing web-goal-result.txt and verify that its exact ' +
              'trimmed content is WEB_GOAL_COMPLETE. Do not modify files or run ' +
              'unrelated checks. After Read proves the exact content, immediately ' +
              'call UpdateGoal complete.',
            permissionMode: 'yolo',
          }),
        });
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({
          status: 'running',
          goal: { status: 'active' },
        });

        await waitForWebGoalCompletion(workspace, sessionId, events);
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
        expect(
          events.some(
            (event) =>
              event.sessionId === sessionId &&
              event.type === 'goal.frontier.updated' &&
              (event.properties.frontier as { taskListId?: string } | undefined)
                ?.taskListId?.startsWith(`goal:${sessionId}:`)
          )
        ).toBe(true);
        expect((await readFile(resultPath, 'utf8')).trim()).toBe('WEB_GOAL_COMPLETE');
        const webGoal = await new GoalStore(workspace, sessionId).get();
        expect(webGoal).toMatchObject({
          status: 'complete',
          completionVerification: {
            status: 'pass',
            verifierSessionId: expect.any(String),
            evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        });
        expect(
          events.some(
            (event) =>
              event.sessionId === sessionId &&
              event.type === 'goal.updated' &&
              (event.properties.goal as { status?: string } | undefined)?.status ===
                'verifying'
          )
        ).toBe(true);
        expect(
          events.some(
            (event) =>
              event.sessionId === sessionId &&
              event.type === 'subagent.complete' &&
              event.properties.type === 'goal-verification' &&
              event.properties.verificationVerdict === 'pass'
          )
        ).toBe(true);
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
        await createGoalFixture(workspace, 'acp-goal-result.txt', 'ACP_GOAL_COMPLETE');
        await session.initialize();
        await session.setMode('yolo');
        const response = await session.prompt({
          sessionId,
          prompt: [
            {
              type: 'text',
              text:
                '/goal Inspect the existing acp-goal-result.txt and verify that its ' +
                'exact trimmed content is ACP_GOAL_COMPLETE. Do not modify files or ' +
                'run unrelated checks. After Read proves the exact content, ' +
                'immediately call UpdateGoal complete.',
            },
          ],
        });
        expect(response.stopReason).toBe('end_turn');

        const acpDeadline = Date.now() + 90_000;
        let acpGoal = await new GoalStore(workspace, sessionId).get();
        while (acpGoal?.status !== 'complete' && Date.now() < acpDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          acpGoal = await new GoalStore(workspace, sessionId).get();
        }
        if (acpGoal?.status !== 'complete') {
          const runtime = (
            session as unknown as {
              runtime?: SessionRuntime;
            }
          ).runtime;
          throw new Error(
            JSON.stringify(
              {
                goal: acpGoal,
                subagents: runtime?.listSubagents().map((child) => ({
                  id: child.id,
                  type: child.subagentType,
                  status: child.status,
                  verdict: child.result?.verificationVerdict,
                  error: child.result?.error,
                  message: child.result?.message.slice(0, 500),
                })),
                toolUpdates: client.sessionUpdates.flatMap((notification) =>
                  notification.update.sessionUpdate === 'tool_call'
                    ? [
                        {
                          title: notification.update.title,
                          status: notification.update.status,
                        },
                      ]
                    : []
                ),
                terminalCount: client.terminals.size,
              },
              null,
              2
            )
          );
        }
        expect((await readFile(resultPath, 'utf8')).trim()).toBe('ACP_GOAL_COMPLETE');
        expect(
          client.sessionUpdates.some(
            (notification) =>
              notification.update.sessionUpdate === 'tool_call' &&
              notification.update.title.includes('UpdateGoal')
          )
        ).toBe(true);
        const frontierIndex = client.sessionUpdates.findIndex(
          (notification) =>
            notification.update.sessionUpdate === 'session_info_update' &&
            notification.update._meta?.['blade/goalFrontier']
        );
        const planIndex = client.sessionUpdates.findIndex(
          (notification) => notification.update.sessionUpdate === 'plan'
        );
        expect(frontierIndex).toBeGreaterThanOrEqual(0);
        expect(planIndex).toBeGreaterThan(frontierIndex);
        expect(client.sessionUpdates[frontierIndex]?.update).toMatchObject({
          _meta: {
            'blade/goalFrontier': {
              taskListId: expect.stringContaining(`goal:${sessionId}:`),
              total: 0,
              completed: 0,
              pending: 0,
            },
          },
        });
        expect(
          client.sessionUpdates.some(
            (notification) =>
              notification.update.sessionUpdate === 'tool_call' &&
              notification.update.title.includes('Task')
          )
        ).toBe(true);
        await expect(new GoalStore(workspace, sessionId).get()).resolves.toMatchObject({
          status: 'complete',
          completionVerification: {
            status: 'pass',
            verifierSessionId: expect.any(String),
            evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        });
        expect(JSON.stringify(client.sessionUpdates)).not.toContain(modelConfig.apiKey);
      } finally {
        await session.destroy().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
