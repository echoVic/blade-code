// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecentTasksStrip } from '@/components/tasks/RecentTasksStrip';
import type { Session } from '@/services';

function session(overrides: Partial<Session>): Session {
  return {
    sessionId: 'session',
    projectPath: '/workspace/blade',
    rootId: 'session',
    taskStatus: 'completed',
    messageCount: 1,
    firstMessageTime: '2026-08-01T00:00:00.000Z',
    lastMessageTime: '2026-08-01T00:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('RecentTasksStrip', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders attention and live work before recent terminal history', async () => {
    const sessions = [
      session({
        sessionId: 'old-failure',
        title: 'Old failure',
        taskStatus: 'failed',
        lastMessageTime: '2026-01-01T00:00:00.000Z',
      }),
      session({
        sessionId: 'recent-completion',
        title: 'Recent completion',
        lastMessageTime: '2026-08-07T10:00:00.000Z',
      }),
      session({
        sessionId: 'recent-cancellation',
        title: 'Recent cancellation',
        taskStatus: 'cancelled',
        lastMessageTime: '2026-08-07T09:30:00.000Z',
      }),
      session({
        sessionId: 'queued',
        title: 'Queued task',
        taskStatus: 'queued',
        lastMessageTime: '2026-08-07T09:00:00.000Z',
      }),
      session({
        sessionId: 'running',
        title: 'Running task',
        taskStatus: 'running',
        lastMessageTime: '2026-08-07T08:00:00.000Z',
      }),
      session({
        sessionId: 'approval',
        title: 'Approval task',
        taskStatus: 'running',
        pendingInteraction: {
          type: 'permission',
          requestId: 'permission-1',
        },
        lastMessageTime: '2026-08-07T07:00:00.000Z',
      }),
    ];

    await act(async () => {
      root.render(
        <RecentTasksStrip
          sessions={sessions}
          cancellingTaskKeys={[]}
          retryingTaskKeys={[]}
          unreadTaskKeys={[]}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
        />
      );
    });

    const renderedTitles = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[class*="min-w-0"][class*="flex-1"]'
      )
    )
      .map((button) => button.querySelector('span.truncate')?.textContent)
      .filter((title): title is string => Boolean(title));

    expect(renderedTitles).toEqual([
      'Approval task',
      'Running task',
      'Queued task',
      'Recent completion',
    ]);
    expect(container.textContent).toContain('Needs approval');
    expect(container.textContent).not.toContain('Old failure');
    expect(container.textContent).not.toContain('Recent cancellation');
  });

  it('labels progressive catalog counts without presenting them as final', async () => {
    await act(async () => {
      root.render(
        <RecentTasksStrip
          sessions={[session({ sessionId: 'loaded-task' })]}
          catalogLoadState="hydrating"
          cancellingTaskKeys={[]}
          retryingTaskKeys={[]}
          unreadTaskKeys={[]}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('1 loaded · syncing');
  });

  it('shows catalog progress before the first recent task is available', async () => {
    await act(async () => {
      root.render(
        <RecentTasksStrip
          sessions={[]}
          catalogLoadState="loading"
          cancellingTaskKeys={[]}
          retryingTaskKeys={[]}
          unreadTaskKeys={[]}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
        />
      );
    });

    expect(container.querySelector('[role="status"]')).toBeTruthy();
    expect(container.textContent).toContain('Syncing task history');
  });
});
