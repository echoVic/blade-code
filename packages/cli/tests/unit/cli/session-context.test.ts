import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  loadSession: vi.fn(),
}));

vi.mock('../../../src/services/SessionService.js', () => ({
  SessionService: sessionState,
}));

vi.mock('../../../src/utils/cwd.js', () => ({
  getCwd: () => '/workspace',
}));

describe('resolveNonInteractiveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.listSessions.mockResolvedValue([]);
    sessionState.loadSession.mockResolvedValue([]);
    sessionState.forkSession.mockResolvedValue({
      sessionId: 'child-session',
      messages: [{ role: 'assistant', content: 'inherited history' }],
    });
  });

  it('forks an explicitly resumed session into the requested child ID', async () => {
    const { resolveNonInteractiveSession } = await import(
      '../../../src/commands/shared/sessionContext.js'
    );

    await expect(
      resolveNonInteractiveSession({
        resume: 'parent-session',
        forkSession: true,
        sessionId: 'child-session',
        fallbackSessionPrefix: 'headless',
      })
    ).resolves.toEqual({
      sessionId: 'child-session',
      messages: [{ role: 'assistant', content: 'inherited history' }],
    });
    expect(sessionState.forkSession).toHaveBeenCalledWith('parent-session', {
      newSessionId: 'child-session',
      sourceProjectPath: '/workspace',
      targetProjectPath: '/workspace',
    });
    expect(sessionState.loadSession).not.toHaveBeenCalled();
  });

  it('forks the latest session when used with continue', async () => {
    sessionState.listSessions.mockResolvedValue([
      { sessionId: 'latest-session' },
      { sessionId: 'older-session' },
    ]);
    const { resolveNonInteractiveSession } = await import(
      '../../../src/commands/shared/sessionContext.js'
    );

    await resolveNonInteractiveSession({
      continue: true,
      forkSession: true,
      fallbackSessionPrefix: 'print',
    });

    expect(sessionState.forkSession).toHaveBeenCalledWith('latest-session', {
      newSessionId: undefined,
      sourceProjectPath: '/workspace',
      targetProjectPath: '/workspace',
    });
  });
});
