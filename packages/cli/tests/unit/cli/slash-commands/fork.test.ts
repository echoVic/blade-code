import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../../../../src/services/SessionService.js';
import { builtinCommands } from '../../../../src/slash-commands/builtinCommands.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

const sessionServiceMocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  restoreSession: vi.fn(),
  sessionActions: vi.fn(() => ({
    restoreSession: storeMocks.restoreSession,
  })),
}));

vi.mock('../../../../src/services/SessionService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/services/SessionService.js')
  >('../../../../src/services/SessionService.js');
  return {
    ...actual,
    SessionService: {
      ...actual.SessionService,
      listSessions: sessionServiceMocks.listSessions,
    },
  };
});

vi.mock('../../../../src/store/vanilla.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/store/vanilla.js')
  >('../../../../src/store/vanilla.js');
  return {
    ...actual,
    sessionActions: storeMocks.sessionActions,
  };
});

function createSessionMetadata(
  overrides: Partial<SessionMetadata> = {}
): SessionMetadata {
  return {
    sessionId: 'parent-session',
    projectPath: '/workspace/a',
    gitBranch: 'main',
    rootId: 'root-parent',
    parentId: undefined,
    relationType: undefined,
    title: 'Parent Session',
    agentType: 'default',
    model: 'gpt-5',
    taskStatus: 'completed',
    messageCount: 12,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('/fork slash command', () => {
  const context: SlashCommandContext = {
    cwd: '/workspace/a',
  };

  beforeEach(() => {
    sessionServiceMocks.listSessions.mockReset();
    storeMocks.restoreSession.mockReset();
    storeMocks.sessionActions.mockClear();
  });

  it('returns a select_session action with only current-workspace forkable sessions', async () => {
    const parentMetadata = createSessionMetadata();
    const otherWorkspaceMetadata = createSessionMetadata({
      sessionId: 'workspace-b-session',
      projectPath: '/workspace/b',
      rootId: 'root-b',
    });
    const subagentMetadata = createSessionMetadata({
      sessionId: 'subagent-session',
      rootId: 'root-subagent',
      relationType: 'subagent',
    });

    sessionServiceMocks.listSessions.mockResolvedValue([
      parentMetadata,
      otherWorkspaceMetadata,
      subagentMetadata,
    ]);

    const { forkCommand } = await import('../../../../src/slash-commands/fork.js');

    await expect(forkCommand.handler([], context)).resolves.toEqual({
      success: true,
      data: {
        action: 'select_session',
        intent: 'fork',
        sessions: [parentMetadata],
      },
    });

    expect(sessionServiceMocks.listSessions).toHaveBeenCalledWith({
      cwd: context.cwd,
      includeSubagents: false,
    });
    expect(storeMocks.restoreSession).not.toHaveBeenCalled();
    expect(storeMocks.sessionActions).not.toHaveBeenCalled();
  });

  it('returns an activate_session action for an exact source session ID match', async () => {
    const parentMetadata = createSessionMetadata();
    const forkedMetadata = createSessionMetadata({
      sessionId: 'forked-session',
      rootId: 'root-parent',
      relationType: 'fork',
    });

    sessionServiceMocks.listSessions.mockResolvedValue([
      forkedMetadata,
      parentMetadata,
    ]);

    const { forkCommand } = await import('../../../../src/slash-commands/fork.js');

    await expect(forkCommand.handler(['parent-session'], context)).resolves.toEqual({
      success: true,
      data: {
        action: 'activate_session',
        intent: 'fork',
        session: parentMetadata,
      },
    });
  });

  it('rejects missing sessions, subagent sessions, and cross-workspace sessions', async () => {
    const ordinary = createSessionMetadata();
    const workspaceB = createSessionMetadata({
      sessionId: 'workspace-b-session',
      projectPath: '/workspace/b',
      rootId: 'root-b',
    });
    const subagent = createSessionMetadata({
      sessionId: 'subagent-session',
      rootId: 'root-subagent',
      relationType: 'subagent',
    });
    sessionServiceMocks.listSessions.mockResolvedValue([
      ordinary,
      workspaceB,
      subagent,
    ]);

    const { forkCommand } = await import('../../../../src/slash-commands/fork.js');

    await expect(forkCommand.handler(['missing'], context)).resolves.toEqual({
      success: false,
      error: 'Session not found: missing',
    });
    await expect(
      forkCommand.handler(['workspace-b-session'], context)
    ).resolves.toEqual({
      success: false,
      error: 'Session not found: workspace-b-session',
    });
    await expect(forkCommand.handler(['subagent-session'], context)).resolves.toEqual({
      success: false,
      error: 'Cannot fork subagent session: subagent-session',
    });
  });

  it('returns a usage error when more than one argument is provided', async () => {
    sessionServiceMocks.listSessions.mockResolvedValue([]);

    const { forkCommand } = await import('../../../../src/slash-commands/fork.js');

    await expect(forkCommand.handler(['one', 'two'], context)).resolves.toMatchObject({
      success: false,
      error: 'Usage: /fork [sessionId]',
    });
    expect(sessionServiceMocks.listSessions).not.toHaveBeenCalled();
  });

  it('registers /fork in builtin commands, updates /help copy, and does not import store', async () => {
    const forkModule = await import('../../../../src/slash-commands/fork.js');
    const sourcePath = path.join(process.cwd(), 'src/slash-commands/fork.ts');
    const source = await readFile(sourcePath, 'utf8');

    expect(forkModule.default).toBe(forkModule.forkCommand);
    expect(builtinCommands.fork).toBe(forkModule.forkCommand);

    const helpContext: SlashCommandContext = {
      cwd: '/workspace/a',
      acp: {
        sendMessage: vi.fn(),
      },
    };
    const helpResult = await builtinCommands.help.handler([], helpContext);
    expect(helpResult.content).toContain(
      '**/fork [sessionId]** - 从历史会话创建独立分支'
    );
    expect(source).not.toMatch(/store\//);
  });
});
