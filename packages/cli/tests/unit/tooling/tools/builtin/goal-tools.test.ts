import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
} from '../../../../../src/acp/AcpRemoteWorkspace.js';
import { getProjectStoragePath } from '../../../../../src/context/storage/pathUtils.js';
import { createRemoteSessionStateStorage } from '../../../../../src/context/storage/SessionStateStorage.js';
import { getGoalTaskListId } from '../../../../../src/goals/executionFrontier.js';
import { GoalStore } from '../../../../../src/goals/GoalStore.js';
import { createGoalTools } from '../../../../../src/tools/builtin/goal/index.js';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index.js';
import { TaskListManager } from '../../../../../src/tools/builtin/task/TaskListManager.js';
import { executeToolInvocation } from '../../../../../src/tools/execution/ToolInvocationRunner.js';

describe('goal tools', () => {
  let storageRoot: string;
  let previousBladeStorageRoot: string | undefined;
  const sessionId = 'goal-tool-session';
  const workspaceRoot = '/tmp/goal-tool-workspace';

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-goal-tools-'));
    previousBladeStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousBladeStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousBladeStorageRoot;
    }
    rmSync(storageRoot, { recursive: true, force: true });
  });

  function getTool(name: string) {
    const tool = createGoalTools({
      sessionId,
      workspaceRoot,
      configDir: storageRoot,
    }).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool as any;
  }

  function execute(name: string, params: Record<string, unknown>) {
    return getTool(name)
      .build(params)
      .execute(new AbortController().signal, undefined, {
        sessionId,
        workspaceRoot,
      });
  }

  it('creates, reads, and submits a host-verified completion candidate', async () => {
    const created = await execute('CreateGoal', {
      objective: 'finish the migration',
      tokenBudget: 500,
    });
    expect(created).toMatchObject({
      success: true,
      llmContent: {
        goal: {
          objective: 'finish the migration',
          status: 'active',
          tokenBudget: 500,
        },
      },
    });

    await expect(execute('GetGoal', {})).resolves.toMatchObject({
      success: true,
      llmContent: {
        goal: {
          objective: 'finish the migration',
          status: 'active',
        },
      },
    });

    await expect(execute('UpdateGoal', { status: 'complete' })).resolves.toMatchObject({
      success: true,
      llmContent: {
        goal: {
          status: 'verifying',
          completionVerification: {
            attempt: 1,
            status: 'pending',
          },
        },
      },
      metadata: {
        goalCompletionRequested: true,
        goalObjective: 'finish the migration',
        goalCompletionAttempt: 1,
        goalCompletionRequestedAt: expect.any(String),
      },
    });
  });

  it('requires a concrete reason when the model marks a goal blocked', async () => {
    await execute('CreateGoal', { objective: 'finish the migration' });

    await expect(execute('UpdateGoal', { status: 'blocked' })).resolves.toMatchObject({
      success: false,
      error: { code: 'GOAL_OPERATION_FAILED' },
    });
    await expect(
      execute('UpdateGoal', {
        status: 'blocked',
        reason: 'external credential is unavailable',
      })
    ).resolves.toMatchObject({
      success: true,
      llmContent: { goal: { status: 'blocked' } },
      metadata: { goalStatus: 'blocked' },
    });
  });

  it('rejects completion while the goal-scoped task list is unfinished', async () => {
    const created = await execute('CreateGoal', { objective: 'finish every task' });
    const goal = (created.llmContent as { goal: { goalId: string } }).goal;
    const taskManager = TaskListManager.getInstance(
      getGoalTaskListId({ sessionId, goalId: goal.goalId }),
      storageRoot
    );
    await taskManager.createTask({
      subject: 'Run the final test',
      description: 'The final test must pass',
    });

    await expect(execute('UpdateGoal', { status: 'complete' })).resolves.toMatchObject({
      success: false,
      error: { code: 'GOAL_OPERATION_FAILED' },
      llmContent: { error: expect.stringContaining('unfinished') },
    });
    await expect(new GoalStore(workspaceRoot, sessionId).get()).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('retries a transient GetGoal failure identified only by errno', async () => {
    await execute('CreateGoal', { objective: 'finish the migration' });
    const get = vi.spyOn(GoalStore.prototype, 'get').mockRejectedValueOnce(
      Object.assign(new Error('resource temporarily unavailable'), {
        code: 'EAGAIN',
      })
    );

    const result = await executeToolInvocation(getTool('GetGoal').build({}), {
      sessionId,
      workspaceRoot,
    });

    expect(result).toMatchObject({
      success: true,
      llmContent: {
        goal: {
          objective: 'finish the migration',
        },
      },
      metadata: { retriedAttempts: 1 },
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('routes builtin goal tool persistence through the remote host state root', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/blade-goal-tools')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const builtinOptions = {
      sessionId,
      configDir: storageRoot,
      workspaceRoot: hostStateRoot,
      stateStorage: remoteStorage,
    };
    const tools = await getBuiltinTools(builtinOptions);
    const createGoalTool = tools.find((tool) => tool.name === 'CreateGoal');
    const getGoalTool = tools.find((tool) => tool.name === 'GetGoal');
    if (!createGoalTool || !getGoalTool) {
      throw new Error('Goal builtin tools were not registered');
    }

    await expect(
      createGoalTool
        .build({ objective: 'persist remotely' })
        .execute(new AbortController().signal, undefined, {
          sessionId,
          workspaceRoot: hostStateRoot,
        })
    ).resolves.toMatchObject({
      success: true,
      llmContent: { goal: { objective: 'persist remotely' } },
    });

    await expect(
      getGoalTool.build({}).execute(new AbortController().signal, undefined, {
        sessionId,
        workspaceRoot: hostStateRoot,
      })
    ).resolves.toMatchObject({
      success: true,
      llmContent: { goal: { objective: 'persist remotely' } },
    });

    expect(existsSync(path.join(hostStateRoot, `${sessionId}.goal.json`))).toBe(true);
    expect(existsSync(getProjectStoragePath(hostStateRoot))).toBe(false);
  });
});
