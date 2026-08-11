import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t } from '@/i18n';
import { sessionTaskReason } from '@/lib/sessionTaskReason';
import type { Session } from '@/services';

function reviewSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'review-session',
    projectPath: '/workspace/blade',
    rootId: 'review-session',
    taskStatus: 'running',
    taskPromptSummary: '/review uncommitted',
    taskStatusReason: 'Reviewing uncommitted changes',
    messageCount: 1,
    firstMessageTime: '2026-08-11T00:00:00.000Z',
    lastMessageTime: '2026-08-11T00:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('sessionTaskReason', () => {
  afterEach(() => setLocale('en'));

  it('localizes durable review states instead of exposing server prose', () => {
    setLocale('zh');
    expect(sessionTaskReason(reviewSession(), t)).toBe('只读代码评审正在进行');
    expect(
      sessionTaskReason(
        reviewSession({
          taskStatus: 'completed',
          taskStatusReason:
            'Code review stale: the review target changed while the reviewer was running',
        }),
        t
      )
    ).toBe('评审期间目标已发生变化');
    expect(
      sessionTaskReason(
        reviewSession({
          taskStatus: 'failed',
          taskStatusReason: 'Code review failed',
        }),
        t
      )
    ).toBe('代码评审失败');
  });
});
