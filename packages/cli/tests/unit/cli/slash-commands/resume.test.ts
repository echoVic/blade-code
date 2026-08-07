import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../../../../src/services/SessionService.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
}));

vi.mock('../../../../src/services/SessionService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/services/SessionService.js')
  >('../../../../src/services/SessionService.js');
  return {
    ...actual,
    SessionService: {
      ...actual.SessionService,
      listSessions: mocks.listSessions,
    },
  };
});

function session(sessionId: string, projectPath: string): SessionMetadata {
  return {
    sessionId,
    projectPath,
    rootId: sessionId,
    taskStatus: 'completed',
    messageCount: 1,
    firstMessageTime: '2026-08-01T00:00:00.000Z',
    lastMessageTime: '2026-08-01T00:00:00.000Z',
    hasErrors: false,
  };
}

describe('/resume slash command', () => {
  const context: SlashCommandContext = { cwd: '/workspace/a' };

  beforeEach(() => {
    mocks.listSessions.mockReset();
  });

  it('offers sessions from every workspace', async () => {
    const sessions = [
      session('session-a', '/workspace/a'),
      session('session-b', '/workspace/b'),
    ];
    mocks.listSessions.mockResolvedValue(sessions);
    const { default: resumeCommand } = await import(
      '../../../../src/slash-commands/resume.js'
    );

    await expect(resumeCommand.handler([], context)).resolves.toEqual({
      success: true,
      data: {
        action: 'select_session',
        intent: 'resume',
        sessions,
      },
    });
    expect(mocks.listSessions).toHaveBeenCalledWith({ includeSubagents: false });
  });

  it('activates a unique session from another workspace', async () => {
    const target = session('session-b', '/workspace/b');
    mocks.listSessions.mockResolvedValue([target]);
    const { default: resumeCommand } = await import(
      '../../../../src/slash-commands/resume.js'
    );

    await expect(resumeCommand.handler(['session-b'], context)).resolves.toEqual({
      success: true,
      data: {
        action: 'activate_session',
        intent: 'resume',
        session: target,
      },
    });
  });

  it('requires the selector for duplicate IDs across workspaces', async () => {
    mocks.listSessions.mockResolvedValue([
      session('shared', '/workspace/a'),
      session('shared', '/workspace/b'),
    ]);
    const { default: resumeCommand } = await import(
      '../../../../src/slash-commands/resume.js'
    );

    await expect(resumeCommand.handler(['shared'], context)).resolves.toEqual({
      success: false,
      error: 'Multiple workspaces contain session shared; use /resume to select one',
    });
  });
});
