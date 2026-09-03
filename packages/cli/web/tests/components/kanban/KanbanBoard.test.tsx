// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from '@/components/kanban/KanbanBoard';
import { setLocale } from '@/i18n';
import type { Session } from '@/services';
import { useSessionStore } from '@/store/session';
import type { SessionSurfaceSelection } from '@/store/session/types';

function task(
  sessionId: string,
  taskStatus: Session['taskStatus'],
  overrides: Partial<Session> = {}
): Session {
  return {
    sessionId,
    projectPath: '/workspace/blade',
    rootId: sessionId,
    title: sessionId,
    taskStatus,
    taskIsolation: 'local',
    messageCount: 1,
    firstMessageTime: '2026-08-20T08:00:00.000Z',
    lastMessageTime: '2026-08-20T09:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

function historySelection(): SessionSurfaceSelection {
  return {
    locator: {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
      },
    },
    displayCwd: '/remote/project',
    mode: 'history-only',
    capabilities: {
      connection: 'online',
      history: { read: true, fork: true },
      turn: { start: false, reason: 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: 'history-only',
      },
      terminal: { mode: 'none', owner: 'none', reason: 'history-only' },
    },
  };
}

describe('KanbanBoard', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const setTaskAdmissionPaused = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    setLocale('en');
    setTaskAdmissionPaused.mockClear();
    useSessionStore.setState({
      historySurfaceSelection: null,
      sessions: [
        task('waiting-task', 'queued', { taskQueuePosition: 1 }),
        task('active-task', 'running'),
        task('blocked-task', 'running', {
          pendingInteraction: { type: 'question', requestId: 'question-1' },
        }),
        task('review-task', 'completed', {
          taskPriority: 'high',
          taskKind: 'bug',
        }),
      ],
      boundProjects: [
        {
          path: '/workspace/blade',
          name: 'blade',
          available: true,
          isCurrent: true,
          boundAt: '2026-08-20T08:00:00.000Z',
        },
      ],
      selectedProjectPath: '/workspace/blade',
      taskWorkspaceInfo: {
        cwd: '/workspace/blade',
        taskAdmission: {
          inFlight: 2,
          queued: 1,
          maxConcurrent: 3,
          maxQueued: 100,
          paused: false,
        },
      },
      taskEventConnectionState: 'connected',
      catalogLoadState: 'ready',
      isDispatchingTask: false,
      isUpdatingTaskAdmission: false,
      cancellingTaskKeys: [],
      retryingTaskKeys: [],
      updatingTaskKeys: [],
      unreadTaskKeys: [],
      error: null,
      setTaskAdmissionPaused,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders every lifecycle stage and controls automatic claiming', async () => {
    await act(async () => {
      root.render(<KanbanBoard />);
    });

    expect(container.querySelectorAll('[data-kanban-task]')).toHaveLength(4);
    for (const column of ['waiting', 'active', 'blocked', 'review']) {
      expect(
        container.querySelector(`[data-kanban-column="${column}"]`)
      ).not.toBeNull();
    }

    const autoClaim = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(autoClaim?.getAttribute('aria-checked')).toBe('true');
    await act(async () => autoClaim?.click());
    expect(setTaskAdmissionPaused).toHaveBeenCalledWith(true);
  });

  it('opens a local-workspace dispatch form', async () => {
    await act(async () => {
      root.render(<KanbanBoard />);
    });
    const create = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'New task'
    );
    await act(async () => create?.click());

    expect(document.body.textContent).toContain(
      'Local workspace · no worktree isolation'
    );
    expect(document.body.querySelector('textarea[required]')).not.toBeNull();
  });

  it('hides mutation controls and rejects a stale admission handler in history-only mode', async () => {
    await act(async () => root.render(<KanbanBoard />));
    const autoClaim = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(autoClaim).not.toBeNull();

    await act(async () => {
      useSessionStore.setState({ historySurfaceSelection: historySelection() });
      autoClaim?.click();
    });

    expect(setTaskAdmissionPaused).not.toHaveBeenCalled();
    expect(container.querySelector('[data-kanban-board]')).toBeNull();
  });
});
