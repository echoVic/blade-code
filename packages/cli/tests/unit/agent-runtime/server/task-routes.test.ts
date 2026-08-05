import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { SessionRouteController } from '../../../../src/server/routes/session.js';
import { TaskRoutes } from '../../../../src/server/routes/task.js';

function createController(
  dispatchTask: SessionRouteController['dispatchTask'],
  getTaskDiff: SessionRouteController['getTaskDiff'] = vi.fn()
): SessionRouteController {
  return {
    app: new Hono(),
    dispatchTask,
    getTaskDiff,
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
      sourceProjectPath: '/tmp/source',
      isolation: 'worktree',
      permissionMode: 'default',
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
});
