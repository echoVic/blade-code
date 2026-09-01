import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { createRemoteSessionStateStorage } from '../../../../src/context/storage/SessionStateStorage.js';
import {
  formatGoalExecutionFrontier,
  getGoalTaskListId,
  readGoalExecutionFrontier,
} from '../../../../src/goals/executionFrontier.js';
import { buildGoalContinuationPrompt } from '../../../../src/goals/prompts.js';
import { TaskListManager } from '../../../../src/tools/builtin/task/TaskListManager.js';

describe('goal execution frontier', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-frontier-'));
    vi.stubEnv('BLADE_STORAGE_ROOT', configDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(configDir, { recursive: true, force: true });
  });

  it('isolates goals and selects the highest-priority executable task', async () => {
    const goal = { sessionId: 'session-a', goalId: 'goal-1' };
    expect(getGoalTaskListId(goal)).toBe('goal:session-a:goal-1');

    const manager = TaskListManager.getInstance(getGoalTaskListId(goal), configDir);
    await manager.createTask({
      subject: 'Low priority task',
      description: 'The lower priority task',
      priority: 'low',
    });
    await manager.createTask({
      subject: 'High priority task',
      description: 'The higher priority task',
      priority: 'high',
    });

    const result = await readGoalExecutionFrontier(goal, { configDir });

    expect(result.tasks).toHaveLength(2);
    expect(result.frontier).toMatchObject({
      taskListId: 'goal:session-a:goal-1',
      total: 2,
      completed: 0,
      inProgress: 0,
      pending: 2,
      blocked: 0,
      nextTask: {
        subject: 'High priority task',
        priority: 'high',
      },
    });

    const otherGoal = await readGoalExecutionFrontier(
      { sessionId: 'session-a', goalId: 'goal-2' },
      { configDir }
    );
    expect(otherGoal.tasks).toEqual([]);
    expect(otherGoal.frontier.taskListId).toBe('goal:session-a:goal-2');
  });

  it('counts pending tasks blocked by incomplete dependencies', async () => {
    const goal = { sessionId: 'session-a', goalId: 'goal-1' };
    const manager = TaskListManager.getInstance(getGoalTaskListId(goal), configDir);
    const blocker = await manager.createTask({
      subject: 'Complete blocker',
      description: 'This must finish first',
    });
    await manager.createTask({
      subject: 'Blocked task',
      description: 'This waits for the blocker',
      blockedBy: [blocker.id],
    });

    const { frontier } = await readGoalExecutionFrontier(goal, { configDir });

    expect(frontier).toMatchObject({
      total: 2,
      pending: 2,
      blocked: 1,
      nextTask: { subject: 'Complete blocker' },
    });
  });

  it('changes the digest when task state changes and keeps it stable otherwise', async () => {
    const goal = { sessionId: 'session-a', goalId: 'goal-1' };
    const manager = TaskListManager.getInstance(getGoalTaskListId(goal), configDir);
    const task = await manager.createTask({
      subject: 'Inspect state',
      description: 'Inspect durable state',
    });

    const first = await readGoalExecutionFrontier(goal, { configDir });
    const second = await readGoalExecutionFrontier(goal, { configDir });
    expect(second.frontier.digestSha256).toBe(first.frontier.digestSha256);

    await manager.updateTask(task.id, { status: 'in_progress' });
    const changed = await readGoalExecutionFrontier(goal, { configDir });
    expect(changed.frontier.digestSha256).not.toBe(first.frontier.digestSha256);
    expect(changed.frontier.inProgress).toBe(1);
  });

  it('reads goal frontier tasks from the remote host state root without projects escaping', async () => {
    const goal = { sessionId: 'session-remote', goalId: 'goal-1' };
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/frontier')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const manager = TaskListManager.getInstance(
      getGoalTaskListId(goal),
      configDir,
      remoteStorage
    );
    await manager.createTask({
      subject: 'Remote frontier task',
      description: 'Persisted below hostStateRoot',
      priority: 'high',
    });

    const result = await readGoalExecutionFrontier(goal, {
      configDir,
      stateStorage: remoteStorage,
    });

    expect(result.frontier.nextTask).toMatchObject({
      subject: 'Remote frontier task',
      priority: 'high',
    });
    expect(
      existsSync(
        path.join(
          hostStateRoot,
          'tasks',
          `${encodeURIComponent(getGoalTaskListId(goal))}-agent-${encodeURIComponent(getGoalTaskListId(goal))}.json`
        )
      )
    ).toBe(true);
  });

  it('escapes and bounds the model-visible frontier block', () => {
    const prompt = formatGoalExecutionFrontier({
      taskListId: 'goal:session-a:goal-1',
      total: 1,
      completed: 0,
      inProgress: 1,
      pending: 0,
      blocked: 0,
      nextTask: {
        id: '1',
        subject: '<unsafe & subject>'.repeat(100),
        priority: 'high',
      },
      digestSha256: 'a'.repeat(64),
      observedAt: '2026-08-28T00:00:00.000Z',
    });

    expect(prompt).toContain('<goal-execution-frontier>');
    expect(prompt).toContain('&lt;unsafe &amp; subject&gt;');
    expect(prompt).not.toContain('<unsafe & subject>');
    expect(prompt.length).toBeLessThan(4_500);
  });

  it('injects the persisted frontier into a goal continuation prompt', () => {
    const prompt = buildGoalContinuationPrompt({
      version: 2,
      sessionId: 'session-a',
      goalId: 'goal-1',
      objective: 'finish the task list',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationCount: 1,
      executionFrontier: {
        taskListId: 'goal:session-a:goal-1',
        total: 1,
        completed: 0,
        inProgress: 0,
        pending: 1,
        blocked: 0,
        nextTask: { id: '1', subject: 'Run the focused test', priority: 'high' },
        digestSha256: 'b'.repeat(64),
        observedAt: '2026-08-28T00:00:00.000Z',
      },
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    });

    expect(prompt).toContain('<goal-execution-frontier>');
    expect(prompt).toContain('Run the focused test');
  });

  it('injects a bounded frontier stall strategy block into continuation prompts', () => {
    const prompt = buildGoalContinuationPrompt({
      version: 2,
      sessionId: 'session-a',
      goalId: 'goal-1',
      objective: 'finish the task list',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationCount: 2,
      executionFrontier: {
        taskListId: 'goal:session-a:goal-1',
        total: 1,
        completed: 0,
        inProgress: 1,
        pending: 0,
        blocked: 0,
        digestSha256: 'b'.repeat(64),
        observedAt: '2026-08-28T00:00:00.000Z',
      },
      frontierStall: {
        category: 'repeated_deferral',
        consecutiveCount: 2,
        digestSha256: 'b'.repeat(64),
        detectedAt: '2026-08-28T00:00:00.000Z',
      },
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    });

    expect(prompt).toContain('<goal-frontier-stall>');
    expect(prompt).toContain('repeated_deferral');
    expect(prompt).toContain('Required action:');
  });
});
