import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forkSession: vi.fn(),
  toUISafeMessages: vi.fn(),
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionService: {
    forkSession: mocks.forkSession,
    toUISafeMessages: mocks.toUISafeMessages,
  },
}));

import branchCommand from '../../../../src/slash-commands/branch.js';

describe('/branch command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forks committed history and returns an atomic TUI session switch', async () => {
    const rawMessages = [{ id: 'message-1', role: 'user', content: 'parent context' }];
    const visibleMessages = [
      {
        id: 'visible-1',
        role: 'user',
        content: 'parent context',
        timestamp: 1,
      },
    ];
    mocks.forkSession.mockResolvedValue({
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
      projectPath: '/workspace',
      messages: rawMessages,
    });
    mocks.toUISafeMessages.mockReturnValue(visibleMessages);

    const result = await branchCommand.handler([], {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      sessionId: 'parent-session',
    });

    expect(mocks.forkSession).toHaveBeenCalledWith('parent-session', {
      sourceProjectPath: '/workspace',
      targetProjectPath: '/workspace',
    });
    expect(result).toEqual({
      success: true,
      message: 'session_forked',
      data: {
        action: 'restore_forked_session',
        sessionId: 'child-session',
        parentSessionId: 'parent-session',
        messages: rawMessages,
        visibleMessages,
      },
    });
  });

  it('returns an ACP-loadable child session handoff', async () => {
    mocks.forkSession.mockResolvedValue({
      sessionId: 'acp-child-session',
      parentSessionId: 'acp-parent-session',
      projectPath: '/workspace',
      messages: [],
    });
    mocks.toUISafeMessages.mockReturnValue([]);

    const result = await branchCommand.handler([], {
      cwd: '/workspace',
      sessionId: 'acp-parent-session',
      acp: { sendMessage: vi.fn() },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('acp-child-session');
    expect(result.content).toContain('session/load');
  });
});
