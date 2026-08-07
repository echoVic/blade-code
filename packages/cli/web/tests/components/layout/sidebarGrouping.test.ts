import { describe, expect, it } from 'vitest';
import { groupByProject } from '@/components/layout/sidebarGrouping';
import { sessionsForProject } from '@/lib/projectIdentity';
import type { Session } from '@/services';

function session(
  sessionId: string,
  projectPath: string,
  taskSourceProjectPath?: string
): Session {
  return {
    sessionId,
    projectPath,
    taskSourceProjectPath,
    rootId: sessionId,
    taskStatus: 'completed',
    messageCount: 1,
    firstMessageTime: '2026-08-06T10:00:00.000Z',
    lastMessageTime: '2026-08-06T10:00:00.000Z',
    hasErrors: false,
  };
}

describe('groupByProject', () => {
  it('folds legacy managed worktrees into their project bucket', () => {
    const activePath = '/Users/example/Documents/GitHub/Blade';
    const groups = groupByProject(
      [
        session('direct', activePath),
        session(
          'legacy-blade',
          '/Users/example/.blade/worktrees/Blade-2b59bfd4a757/task+legacy-blade'
        ),
        session(
          'maestro-1',
          '/Users/example/.blade/worktrees/Maestro-aabbccddeeff/task+maestro-1'
        ),
        session(
          'maestro-2',
          '/Users/example/.blade/worktrees/Maestro-aabbccddeeff/task+maestro-2'
        ),
      ],
      activePath
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      path: activePath,
      name: 'Blade',
      isActive: true,
    });
    expect(groups[0]?.sessions.map((item) => item.sessionId)).toEqual([
      'direct',
      'legacy-blade',
    ]);
    expect(groups[1]).toMatchObject({
      name: 'Maestro',
      isActive: false,
    });
    expect(groups[1]?.sessions).toHaveLength(2);
  });

  it('prefers explicit source project metadata over worktree inference', () => {
    const sourcePath = '/Users/example/Documents/GitHub/Other';
    const groups = groupByProject(
      [
        session(
          'explicit',
          '/Users/example/.blade/worktrees/Blade-2b59bfd4a757/task+explicit',
          sourcePath
        ),
      ],
      '/Users/example/Documents/GitHub/Blade'
    );

    expect(groups[0]).toMatchObject({
      path: sourcePath,
      name: 'Other',
      isActive: false,
    });
  });

  it('coalesces randomized test workspaces under a stable temporary project', () => {
    const groups = groupByProject(
      [
        session('test-a', '/var/folders/example/T/session-persistence-test-a1B2c3'),
        session('test-b', '/var/folders/example/T/session-persistence-test-Z9y8X7'),
        session('config', '/private/tmp/session-openai-config-Ab12Cd'),
      ],
      '/Users/example/Documents/GitHub/Blade'
    );

    expect(groups).toHaveLength(2);
    expect(
      groups.find((group) => group.name === 'session-persistence-test')
    ).toMatchObject({
      path: '/var/folders/example/T/session-persistence-test',
    });
    expect(
      groups.find((group) => group.name === 'session-persistence-test')?.sessions
    ).toHaveLength(2);
    expect(
      groups.find((group) => group.name === 'session-openai-config')
    ).toMatchObject({
      path: '/private/tmp/session-openai-config',
    });
  });

  it('keeps registry order stable when another project is selected', () => {
    const workspaceA = '/workspace/a';
    const workspaceB = '/workspace/b';
    const groups = groupByProject(
      [
        session('history-new', '/history/new'),
        session('workspace-a', workspaceA),
        session('workspace-b', workspaceB),
      ],
      workspaceA,
      [workspaceB, workspaceA]
    );

    expect(
      groups.map((group) => ({
        path: group.path,
        isActive: group.isActive,
        isBound: group.isBound,
      }))
    ).toEqual([
      { path: workspaceB, isActive: false, isBound: true },
      { path: workspaceA, isActive: true, isBound: true },
      { path: '/history/new', isActive: false, isBound: false },
    ]);
  });

  it('prioritizes live work but sorts all terminal history by recent activity', () => {
    const projectPath = '/workspace/a';
    const groups = groupByProject(
      [
        {
          ...session('old-failure', projectPath),
          taskStatus: 'failed',
          lastMessageTime: '2026-01-01T00:00:00.000Z',
        },
        {
          ...session('recent-completion', projectPath),
          lastMessageTime: '2026-08-07T10:00:00.000Z',
        },
        {
          ...session('queued', projectPath),
          taskStatus: 'queued',
          lastMessageTime: '2026-08-07T09:00:00.000Z',
        },
        {
          ...session('running', projectPath),
          taskStatus: 'running',
          lastMessageTime: '2026-08-07T08:00:00.000Z',
        },
        {
          ...session('approval', projectPath),
          taskStatus: 'running',
          pendingInteraction: {
            type: 'permission',
            requestId: 'permission-1',
          },
          lastMessageTime: '2026-08-07T07:00:00.000Z',
        },
      ],
      projectPath,
      [projectPath]
    );

    expect(groups[0]?.sessions.map((item) => item.sessionId)).toEqual([
      'approval',
      'running',
      'queued',
      'recent-completion',
      'old-failure',
    ]);
  });
});

describe('sessionsForProject', () => {
  it('keeps the home task history scoped to the selected source project', () => {
    const activePath = '/Users/example/Documents/GitHub/Blade';
    const blade = session(
      'blade-worktree',
      '/Users/example/.blade/worktrees/Blade-2b59bfd4a757/task+blade'
    );
    const other = session(
      'other-worktree',
      '/Users/example/.blade/worktrees/Other-aabbccddeeff/task+other',
      '/Users/example/Documents/GitHub/Other'
    );

    expect(sessionsForProject([blade, other], activePath, activePath)).toEqual([blade]);
    expect(
      sessionsForProject(
        [blade, other],
        '/Users/example/Documents/GitHub/Other',
        activePath
      )
    ).toEqual([other]);
  });
});
