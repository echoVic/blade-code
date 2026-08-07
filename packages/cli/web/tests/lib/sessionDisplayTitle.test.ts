import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t } from '@/i18n';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import type { Session } from '@/services';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'abcdef123',
    projectPath: '/workspace/blade',
    rootId: 'abcdef123',
    taskStatus: 'completed',
    messageCount: 1,
    firstMessageTime: '2026-08-07T10:05:00',
    lastMessageTime: '2026-08-07T10:06:00',
    hasErrors: false,
    ...overrides,
  };
}

describe('sessionDisplayTitle', () => {
  afterEach(() => setLocale('en'));

  it('uses the same localized dated fallback across task surfaces', () => {
    setLocale('zh');
    expect(sessionDisplayTitle(session(), t)).toBe('会话 26-08-07 10:05');

    setLocale('en');
    expect(sessionDisplayTitle(session(), t)).toBe('Session 26-08-07 10:05');
  });

  it('trims semantic titles and falls back to a short session ID', () => {
    expect(sessionDisplayTitle(session({ title: '  Fix auth  ' }), t)).toBe('Fix auth');
    expect(
      sessionDisplayTitle(
        session({
          firstMessageTime: undefined,
          lastMessageTime: undefined,
        }),
        t
      )
    ).toBe('Session abcdef');
  });
});
