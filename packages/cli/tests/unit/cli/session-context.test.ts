import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../../../src/services/SessionService.js';
import { SessionService } from '../../../src/services/SessionService.js';

vi.mock('../../../src/utils/cwd.js', () => ({
  getCwd: () => '/workspace',
}));

function makeMetadata(sessionId: string, projectPath = '/workspace'): SessionMetadata {
  return {
    sessionId,
    projectPath,
    rootId: sessionId,
    taskStatus: 'completed',
    messageCount: 1,
    firstMessageTime: '2024-01-01T00:00:00.000Z',
    lastMessageTime: '2024-01-01T00:00:00.000Z',
    hasErrors: false,
  };
}

describe('resolveNonInteractiveSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(SessionService, 'listSessions').mockResolvedValue([]);
    vi.spyOn(SessionService, 'loadSession').mockResolvedValue([]);
    vi.spyOn(SessionService, 'findSessionMetadata').mockResolvedValue(undefined);
    vi.spyOn(SessionService, 'forkSession').mockResolvedValue({
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
      projectPath: '/workspace',
      messages: [{ role: 'assistant', content: 'inherited history' }],
      metadata: {
        ...makeMetadata('child-session'),
        rootId: 'parent-session',
        parentId: 'parent-session',
        relationType: 'fork',
      },
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
      parentSessionId: 'parent-session',
      projectPath: '/workspace',
      messages: [{ role: 'assistant', content: 'inherited history' }],
      metadata: expect.objectContaining({ sessionId: 'child-session' }),
    });
    expect(SessionService.forkSession).toHaveBeenCalledWith('parent-session', {
      newSessionId: 'child-session',
      sourceProjectPath: '/workspace',
      targetProjectPath: '/workspace',
    });
    expect(SessionService.loadSession).not.toHaveBeenCalled();
  });

  it('scopes forked continue discovery to the current workspace', async () => {
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeMetadata('latest-session'),
      makeMetadata('older-session'),
    ]);
    const { resolveNonInteractiveSession } = await import(
      '../../../src/commands/shared/sessionContext.js'
    );

    await resolveNonInteractiveSession({
      continue: true,
      forkSession: true,
      fallbackSessionPrefix: 'print',
    });

    expect(SessionService.listSessions).toHaveBeenCalledWith({ cwd: '/workspace' });
    expect(SessionService.forkSession).toHaveBeenCalledWith('latest-session', {
      newSessionId: undefined,
      sourceProjectPath: '/workspace',
      targetProjectPath: '/workspace',
    });
  });

  it('keeps non-fork continue discovery and loading global', async () => {
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeMetadata('global-latest', '/another-workspace'),
    ]);
    vi.mocked(SessionService.loadSession).mockResolvedValue([
      { role: 'assistant', content: 'global history' },
    ]);
    const { resolveNonInteractiveSession } = await import(
      '../../../src/commands/shared/sessionContext.js'
    );

    await expect(
      resolveNonInteractiveSession({
        continue: true,
        fallbackSessionPrefix: 'print',
      })
    ).resolves.toEqual({
      sessionId: 'global-latest',
      messages: [{ role: 'assistant', content: 'global history' }],
      metadata: makeMetadata('global-latest', '/another-workspace'),
    });

    expect(SessionService.listSessions).toHaveBeenCalledWith();
    expect(SessionService.loadSession).toHaveBeenCalledWith('global-latest');
    expect(SessionService.forkSession).not.toHaveBeenCalled();
  });

  it('returns durable settings when explicitly resuming a session', async () => {
    const metadata = {
      ...makeMetadata('resume-session'),
      permissionMode: 'plan' as const,
    };
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.loadSession).mockResolvedValue([
      { role: 'assistant', content: 'resume history' },
    ]);
    const { resolveNonInteractiveSession } = await import(
      '../../../src/commands/shared/sessionContext.js'
    );

    await expect(
      resolveNonInteractiveSession({
        resume: 'resume-session',
        fallbackSessionPrefix: 'headless',
      })
    ).resolves.toEqual({
      sessionId: 'resume-session',
      messages: [{ role: 'assistant', content: 'resume history' }],
      metadata,
    });
  });
});
