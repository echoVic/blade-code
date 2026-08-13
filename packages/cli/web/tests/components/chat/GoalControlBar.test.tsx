// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  goal: {
    version: 1 as const,
    sessionId: 'goal-session',
    goalId: 'goal-1',
    objective: 'Finish the migration and verify every production caller.',
    status: 'paused' as const,
    tokenBudget: 10_000,
    tokensUsed: 1_250,
    timeUsedSeconds: 95,
    continuationCount: 3,
    statusReason: 'paused by user',
    completionVerification: undefined as
      | undefined
      | {
          attempt: number;
          status: 'pending' | 'pass' | 'fail' | 'partial';
          requestedAt: string;
          completedAt?: string;
          verifierSessionId?: string;
          summary?: string;
          evidenceSha256?: string;
        },
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:01:35.000Z',
  },
  pauseGoal: vi.fn().mockResolvedValue(undefined),
  resumeGoal: vi.fn().mockResolvedValue(undefined),
  editGoal: vi.fn().mockResolvedValue(undefined),
  clearGoal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/store/session', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) =>
    selector(sessionState),
}));

import { GoalControlBar } from '../../../src/components/chat/GoalControlBar';

describe('GoalControlBar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    vi.clearAllMocks();
    (sessionState.goal as { status: string }).status = 'paused';
    sessionState.goal.statusReason = 'paused by user';
    sessionState.goal.completionVerification = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the paused goal toolbar and expands usage details', async () => {
    act(() => {
      root.render(<GoalControlBar />);
    });

    expect(container.textContent).toContain('Goal paused');
    expect(container.textContent).toContain('Finish the migration');
    expect(container.querySelector('[data-blade-goal-status="paused"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Resume goal"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Pause goal"]')).toBeNull();

    await act(async () => {
      container
        .querySelector('[aria-label="Expand goal details"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('1.3K / 10.0K tokens');
    expect(container.textContent).toContain('1m 35s');
    expect(container.textContent).toContain('3 continuations');
    expect(container.textContent).toContain('paused by user');
  });

  it('pauses an active goal from the toolbar', async () => {
    (sessionState.goal as { status: string }).status = 'active';
    act(() => {
      root.render(<GoalControlBar />);
    });

    expect(container.querySelector('[aria-label="Pause goal"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Resume goal"]')).toBeNull();
    await act(async () => {
      container
        .querySelector('[aria-label="Pause goal"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(sessionState.pauseGoal).toHaveBeenCalledOnce();
  });

  it('renders durable independent verification evidence', async () => {
    (sessionState.goal as { status: string }).status = 'verifying';
    sessionState.goal.statusReason =
      'independent completion verification returned partial';
    sessionState.goal.completionVerification = {
      attempt: 2,
      status: 'partial',
      requestedAt: '2026-08-04T00:01:00.000Z',
      completedAt: '2026-08-04T00:01:30.000Z',
      verifierSessionId: 'verifier-session-123456',
      summary: 'Independent verifier returned PARTIAL.',
      evidenceSha256: 'a'.repeat(64),
    };
    act(() => {
      root.render(<GoalControlBar />);
    });

    expect(container.textContent).toContain('Verifying');
    expect(container.querySelector('[aria-label="Pause goal"]')).toBeTruthy();
    await act(async () => {
      container
        .querySelector('[aria-label="Expand goal details"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-goal-verification="partial"]')).toBeTruthy();
    expect(container.textContent).toContain('#2 · PARTIAL');
    expect(container.textContent).toContain('verifier-ses');
    expect(container.textContent).toContain('Independent verifier returned PARTIAL.');
    expect(container.textContent).toContain('sha256:aaaaaaaaaaaa');
  });

  it('edits without resuming and exposes resume as a separate action', async () => {
    act(() => {
      root.render(<GoalControlBar />);
    });

    await act(async () => {
      container
        .querySelector('[aria-label="Edit goal"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const textarea = container.querySelector(
      '#goal-objective'
    ) as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();
    await act(async () => {
      if (textarea) {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )?.set;
        setValue?.call(textarea, 'Ship the revised migration safely.');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await Promise.resolve();
    });

    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    );
    await act(async () => {
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(sessionState.editGoal).toHaveBeenCalledWith(
      'Ship the revised migration safely.'
    );
    expect(sessionState.resumeGoal).not.toHaveBeenCalled();

    await act(async () => {
      container
        .querySelector('[aria-label="Resume goal"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(sessionState.resumeGoal).toHaveBeenCalledOnce();
  });

  it('requires confirmation before deleting the goal', async () => {
    act(() => {
      root.render(<GoalControlBar />);
    });

    await act(async () => {
      container
        .querySelector('[aria-label="Delete goal"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Delete this goal?');
    expect(sessionState.clearGoal).not.toHaveBeenCalled();

    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Delete goal'
    );
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(sessionState.clearGoal).toHaveBeenCalledOnce();
  });
});
