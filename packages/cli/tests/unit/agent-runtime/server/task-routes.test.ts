import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { MAX_INLINE_ATTACHMENT_BYTES } from '../../../../src/api/attachmentLimits.js';
import { TooManyRequestsError } from '../../../../src/server/error.js';
import type { SessionRouteController } from '../../../../src/server/routes/session.js';
import { TaskRoutes } from '../../../../src/server/routes/task.js';

function createController(
  dispatchTask: SessionRouteController['dispatchTask'],
  getTaskDiff: SessionRouteController['getTaskDiff'] = vi.fn(),
  retryTask: SessionRouteController['retryTask'] = vi.fn(),
  deliverTask: SessionRouteController['deliverTask'] = vi.fn(),
  updateTask: SessionRouteController['updateTask'] = vi.fn()
): SessionRouteController {
  return {
    app: new Hono(),
    dispatchTask,
    retryTask,
    updateTask,
    getTaskDiff,
    deliverTask,
    recoverQueuedTasks: vi.fn(async () => ({
      scheduled: 0,
      failed: 0,
      deferred: 0,
    })),
    getRuntimeResidencyStats: vi.fn(() => ({
      resident: 0,
      reserved: 0,
      pinned: 0,
      maxResident: 32,
    })),
    getCoordinationStats: vi.fn(() => ({
      messageSubmissions: { keys: 0, operations: 0 },
      taskDeliveries: { keys: 0, operations: 0 },
    })),
    shutdown: vi.fn(async () => undefined),
  };
}

describe('TaskRoutes', () => {
  it('defaults to worktree isolation and returns the accepted durable run', async () => {
    const dispatchTask = vi.fn<SessionRouteController['dispatchTask']>(
      async (input) => ({
        session: {
          sessionId: 'task-1',
          projectPath: '/tmp/worktree',
          title: 'Task one',
          rootId: 'task-1',
          taskStatus: 'running',
          taskIsolation: input.isolation,
          taskSourceProjectPath: input.sourceProjectPath,
          messageCount: 0,
          firstMessageTime: '2026-08-06T00:00:00.000Z',
          lastMessageTime: '2026-08-06T00:00:00.000Z',
          hasErrors: false,
          isActive: true,
        },
        runId: 'run-1',
        messageId: 'message-1',
        status: 'running',
      })
    );
    const app = TaskRoutes(createController(dispatchTask));

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Implement task dispatch',
        projectPath: '/tmp/source',
      }),
    });

    expect(response.status).toBe(202);
    expect(dispatchTask).toHaveBeenCalledWith({
      prompt: 'Implement task dispatch',
      title: undefined,
      taskPriority: 'medium',
      taskKind: 'feature',
      taskDueAt: undefined,
      sourceProjectPath: '/tmp/source',
      isolation: 'worktree',
      permissionMode: 'default',
      modelId: undefined,
      attachments: undefined,
    });
    await expect(response.json()).resolves.toMatchObject({
      session: {
        sessionId: 'task-1',
        taskIsolation: 'worktree',
      },
      runId: 'run-1',
      messageId: 'message-1',
      status: 'running',
    });
  });

  it('rejects blank prompts before dispatch', async () => {
    const dispatchTask = vi.fn<SessionRouteController['dispatchTask']>();
    const app = TaskRoutes(createController(dispatchTask));

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    });

    expect(response.status).toBe(400);
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it('rejects task attachments above the shared inline budget', async () => {
    const dispatchTask = vi.fn<SessionRouteController['dispatchTask']>();
    const app = TaskRoutes(createController(dispatchTask));
    const halfBudget = 'x'.repeat(Math.floor(MAX_INLINE_ATTACHMENT_BYTES / 2) + 1);

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Inspect these screenshots',
        attachments: [
          { type: 'image', content: halfBudget },
          { type: 'image', content: halfBudget },
        ],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: 'Task attachments exceed the 5 MiB limit',
      },
    });
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it('updates planning metadata for the exact task', async () => {
    const updateTask = vi.fn<SessionRouteController['updateTask']>(
      async (sessionId, update, projectPath) => ({
        sessionId,
        projectPath: projectPath ?? '/tmp/source',
        title: update.title ?? 'Task one',
        rootId: sessionId,
        taskStatus: 'queued',
        taskPriority: update.taskPriority,
        taskKind: update.taskKind,
        taskDueAt: update.taskDueAt ?? undefined,
        messageCount: 0,
        firstMessageTime: '2026-08-20T00:00:00.000Z',
        lastMessageTime: '2026-08-20T00:00:00.000Z',
        hasErrors: false,
        isActive: true,
      })
    );
    const app = TaskRoutes(
      createController(vi.fn(), vi.fn(), vi.fn(), vi.fn(), updateTask)
    );

    const response = await app.request('/task-1?projectPath=%2Ftmp%2Fsource', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Fix scheduler',
        taskPriority: 'high',
        taskKind: 'bug',
        taskDueAt: '2026-08-21T09:30:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      {
        title: 'Fix scheduler',
        taskPriority: 'high',
        taskKind: 'bug',
        taskDueAt: '2026-08-21T09:30:00.000Z',
      },
      '/tmp/source'
    );
    await expect(response.json()).resolves.toMatchObject({
      taskPriority: 'high',
      taskKind: 'bug',
    });
  });

  it('rejects empty task metadata updates', async () => {
    const updateTask = vi.fn<SessionRouteController['updateTask']>();
    const app = TaskRoutes(
      createController(vi.fn(), vi.fn(), vi.fn(), vi.fn(), updateTask)
    );

    const response = await app.request('/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('does not expose worktree or provider failures', async () => {
    const dispatchTask = vi.fn<SessionRouteController['dispatchTask']>(async () => {
      throw new Error('/private/path provider-key-value');
    });
    const app = TaskRoutes(createController(dispatchTask));

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Run a task',
        projectPath: '/tmp/source',
        isolation: 'local',
      }),
    });

    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('Failed to dispatch task');
    expect(body).not.toContain('/private/path');
    expect(body).not.toContain('provider-key-value');
  });

  it('returns a retryable 429 when admission is full', async () => {
    const dispatchTask = vi.fn<SessionRouteController['dispatchTask']>(async () => {
      throw new TooManyRequestsError('Task admission capacity is full', {
        resource: 'pending_bytes',
      });
    });
    const app = TaskRoutes(createController(dispatchTask));

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Queue this task',
        projectPath: '/tmp/source',
      }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Task admission capacity is full',
        details: {
          resource: 'pending_bytes',
        },
      },
    });
  });

  it('retries the exact compound task and returns the new accepted run', async () => {
    const retryTask = vi.fn<SessionRouteController['retryTask']>(async () => ({
      session: {
        sessionId: 'task-retry',
        projectPath: '/tmp/retry-worktree',
        title: 'Retried task',
        rootId: 'task-retry',
        taskStatus: 'running',
        taskRetryAvailable: true,
        taskRetriedFrom: {
          sessionId: 'task-source',
          projectPath: '/tmp/source-worktree',
        },
        messageCount: 0,
        firstMessageTime: '2026-08-06T00:00:00.000Z',
        lastMessageTime: '2026-08-06T00:00:00.000Z',
        hasErrors: false,
        isActive: true,
      },
      runId: 'run-retry',
      messageId: 'message-retry',
      status: 'running',
    }));
    const app = TaskRoutes(createController(vi.fn(), vi.fn(), retryTask));

    const response = await app.request(
      '/task-source/retry?projectPath=%2Ftmp%2Fsource-worktree',
      { method: 'POST' }
    );

    expect(response.status).toBe(202);
    expect(retryTask).toHaveBeenCalledWith('task-source', '/tmp/source-worktree');
    await expect(response.json()).resolves.toMatchObject({
      session: {
        sessionId: 'task-retry',
        taskRetriedFrom: {
          sessionId: 'task-source',
          projectPath: '/tmp/source-worktree',
        },
      },
      runId: 'run-retry',
    });
  });

  it('returns a bounded task diff artifact for the exact execution workspace', async () => {
    const getTaskDiff = vi.fn<SessionRouteController['getTaskDiff']>(async () => ({
      sessionId: 'task-1',
      projectPath: '/tmp/worktree',
      baseCommit: 'abc123',
      files: [
        {
          path: 'src/value.ts',
          patch: '@@ -1 +1 @@\n-old\n+new\n',
          additions: 1,
          deletions: 1,
          binary: false,
          truncated: false,
        },
      ],
      truncated: false,
    }));
    const app = TaskRoutes(createController(vi.fn(), getTaskDiff));

    const response = await app.request('/task-1/diff?projectPath=%2Ftmp%2Fworktree');

    expect(response.status).toBe(200);
    expect(getTaskDiff).toHaveBeenCalledWith('task-1', '/tmp/worktree');
    await expect(response.json()).resolves.toEqual({
      sessionId: 'task-1',
      projectPath: '/tmp/worktree',
      baseCommit: 'abc123',
      files: [
        {
          path: 'src/value.ts',
          patch: '@@ -1 +1 @@\n-old\n+new\n',
          additions: 1,
          deletions: 1,
          binary: false,
          truncated: false,
        },
      ],
      truncated: false,
    });
  });

  it('delivers an exact task workspace and returns its durable session state', async () => {
    const deliverTask = vi.fn<SessionRouteController['deliverTask']>(
      async (sessionId, action, projectPath) => ({
        sessionId,
        projectPath: projectPath ?? '/tmp/worktree',
        title: 'Task one',
        rootId: sessionId,
        taskStatus: 'completed',
        taskDelivery: {
          status: action === 'apply' ? 'applied' : 'discarded',
          updatedAt: '2026-08-07T00:00:00.000Z',
          changedFiles: 2,
        },
        messageCount: 2,
        firstMessageTime: '2026-08-07T00:00:00.000Z',
        lastMessageTime: '2026-08-07T00:00:00.000Z',
        hasErrors: false,
        isActive: true,
      })
    );
    const app = TaskRoutes(createController(vi.fn(), vi.fn(), vi.fn(), deliverTask));

    const response = await app.request(
      '/task-1/delivery?projectPath=%2Ftmp%2Fworktree',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      }
    );

    expect(response.status).toBe(200);
    expect(deliverTask).toHaveBeenCalledWith('task-1', 'apply', '/tmp/worktree');
    await expect(response.json()).resolves.toMatchObject({
      sessionId: 'task-1',
      taskDelivery: {
        status: 'applied',
        changedFiles: 2,
      },
    });
  });

  it('rejects malformed task delivery actions before invoking the controller', async () => {
    const deliverTask = vi.fn<SessionRouteController['deliverTask']>();
    const app = TaskRoutes(createController(vi.fn(), vi.fn(), vi.fn(), deliverTask));

    const response = await app.request('/task-1/delivery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'merge' }),
    });

    expect(response.status).toBe(400);
    expect(deliverTask).not.toHaveBeenCalled();
  });
});
