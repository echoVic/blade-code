import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../../src/services/ChatServiceInterface.js';
import type { SessionMetadata } from '../../../../../src/services/SessionService.js';
import type { SessionMessage } from '../../../../../src/store/types.js';

const serviceMocks = vi.hoisted(() => ({
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  loadSession: vi.fn(),
  toUISafeMessages: vi.fn(),
}));

vi.mock('../../../../../src/services/SessionService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../src/services/SessionService.js')
  >('../../../../../src/services/SessionService.js');
  return {
    ...actual,
    SessionService: {
      ...actual.SessionService,
      forkSession: serviceMocks.forkSession,
      listSessions: serviceMocks.listSessions,
      loadSession: serviceMocks.loadSession,
      toUISafeMessages: serviceMocks.toUISafeMessages,
    },
  };
});

function createSessionMetadata(
  overrides: Partial<SessionMetadata> = {}
): SessionMetadata {
  return {
    sessionId: 'parent-session-12345678',
    projectPath: '/workspace/parent',
    gitBranch: 'main',
    rootId: 'root-parent',
    parentId: undefined,
    relationType: undefined,
    title: 'Parent Session',
    agentType: 'default',
    model: 'gpt-5',
    messageCount: 8,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

function createMessage(
  role: Message['role'],
  content: string,
  metadata?: Message['metadata']
): Message {
  return {
    role,
    content,
    metadata,
  };
}

function createSessionMessage(
  id: string,
  role: SessionMessage['role'],
  content: string
): SessionMessage {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('activateSessionSelection', () => {
  const childMessages = [
    createMessage('user', 'hello'),
    createMessage('assistant', 'world'),
  ];
  const safeMessages = [
    createSessionMessage('safe-1', 'user', 'hello'),
    createSessionMessage('safe-2', 'assistant', 'world'),
  ];

  const actions = {
    restoreSession:
      vi.fn<
        (sessionId: string, messages: SessionMessage[], rawMessages: Message[]) => void
      >(),
    addAssistantMessage: vi.fn<(message: string) => void>(),
  };

  beforeEach(() => {
    serviceMocks.forkSession.mockReset();
    serviceMocks.listSessions.mockReset();
    serviceMocks.loadSession.mockReset();
    serviceMocks.toUISafeMessages.mockReset();
    actions.restoreSession.mockReset();
    actions.addAssistantMessage.mockReset();
  });

  it('forks inside the current workspace, restores child messages, and announces the fork', async () => {
    const parentMetadata = createSessionMetadata();
    serviceMocks.forkSession.mockResolvedValue({
      sessionId: 'child-session-abcdefgh',
      parentSessionId: parentMetadata.sessionId,
      projectPath: '/workspace/parent',
      messages: childMessages,
      metadata: createSessionMetadata({
        sessionId: 'child-session-abcdefgh',
        relationType: 'fork',
        parentId: parentMetadata.sessionId,
      }),
    });
    serviceMocks.toUISafeMessages.mockReturnValue(safeMessages);

    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      activateSessionSelection(
        { intent: 'fork', session: parentMetadata },
        '/workspace/parent',
        actions
      )
    ).resolves.toEqual({
      sessionId: 'child-session-abcdefgh',
      messages: childMessages,
    });

    expect(serviceMocks.forkSession).toHaveBeenCalledWith('parent-session-12345678', {
      sourceProjectPath: '/workspace/parent',
      targetProjectPath: '/workspace/parent',
    });
    expect(serviceMocks.toUISafeMessages).toHaveBeenCalledWith(childMessages);
    expect(actions.restoreSession).toHaveBeenCalledWith(
      'child-session-abcdefgh',
      safeMessages,
      childMessages
    );
    expect(actions.addAssistantMessage).toHaveBeenCalledWith(
      'Forked parent-s… → child-se…'
    );
  });

  it('throws before service calls when interactive fork crosses workspaces', async () => {
    const parentMetadata = createSessionMetadata({
      projectPath: '/workspace/other/../other',
    });
    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      activateSessionSelection(
        { intent: 'fork', session: parentMetadata },
        '/workspace/parent',
        actions
      )
    ).rejects.toThrow('Interactive session forks are limited to the current workspace');

    expect(serviceMocks.forkSession).not.toHaveBeenCalled();
    expect(actions.restoreSession).not.toHaveBeenCalled();
    expect(actions.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('passes through newSessionId and skips announcement when announceFork is false', async () => {
    const parentMetadata = createSessionMetadata();
    serviceMocks.forkSession.mockResolvedValue({
      sessionId: 'child-session-abcdefgh',
      parentSessionId: parentMetadata.sessionId,
      projectPath: '/workspace/parent',
      messages: childMessages,
      metadata: createSessionMetadata({
        sessionId: 'child-session-abcdefgh',
        relationType: 'fork',
        parentId: parentMetadata.sessionId,
      }),
    });
    serviceMocks.toUISafeMessages.mockReturnValue(safeMessages);

    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await activateSessionSelection(
      {
        intent: 'fork',
        session: parentMetadata,
        newSessionId: 'child-session-abcdefgh',
        announceFork: false,
      },
      '/workspace/parent',
      actions
    );

    expect(serviceMocks.forkSession).toHaveBeenCalledWith('parent-session-12345678', {
      newSessionId: 'child-session-abcdefgh',
      sourceProjectPath: '/workspace/parent',
      targetProjectPath: '/workspace/parent',
    });
    expect(actions.restoreSession).toHaveBeenCalledOnce();
    expect(actions.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('does not restore or announce when the fork service fails', async () => {
    const parentMetadata = createSessionMetadata();
    serviceMocks.forkSession.mockRejectedValue(new Error('fork failed'));

    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      activateSessionSelection(
        { intent: 'fork', session: parentMetadata },
        '/workspace/parent',
        actions
      )
    ).rejects.toThrow('fork failed');

    expect(serviceMocks.toUISafeMessages).not.toHaveBeenCalled();
    expect(actions.restoreSession).not.toHaveBeenCalled();
    expect(actions.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('loads and restores resume selections without current-workspace restrictions or fork announcements', async () => {
    const resumeMetadata = createSessionMetadata({
      sessionId: 'resume-session-12345678',
      projectPath: '/workspace/elsewhere',
    });
    serviceMocks.loadSession.mockResolvedValue(childMessages);
    serviceMocks.toUISafeMessages.mockReturnValue(safeMessages);

    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      activateSessionSelection(
        { intent: 'resume', session: resumeMetadata },
        '/workspace/parent',
        actions
      )
    ).resolves.toEqual({
      sessionId: 'resume-session-12345678',
      messages: childMessages,
    });

    expect(serviceMocks.loadSession).toHaveBeenCalledWith(
      'resume-session-12345678',
      '/workspace/elsewhere'
    );
    expect(serviceMocks.forkSession).not.toHaveBeenCalled();
    expect(serviceMocks.toUISafeMessages).toHaveBeenCalledWith(childMessages);
    expect(actions.restoreSession).toHaveBeenCalledWith(
      'resume-session-12345678',
      safeMessages,
      childMessages
    );
    expect(actions.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('restores only after service resolution and UI-safe conversion', async () => {
    const parentMetadata = createSessionMetadata();
    const calls: string[] = [];
    serviceMocks.forkSession.mockImplementation(async () => {
      calls.push('service');
      return {
        sessionId: 'child-session-abcdefgh',
        parentSessionId: parentMetadata.sessionId,
        projectPath: '/workspace/parent',
        messages: childMessages,
        metadata: createSessionMetadata({
          sessionId: 'child-session-abcdefgh',
          relationType: 'fork',
          parentId: parentMetadata.sessionId,
        }),
      };
    });
    serviceMocks.toUISafeMessages.mockImplementation((messages: Message[]) => {
      calls.push(`ui:${messages.length}`);
      return safeMessages;
    });
    actions.restoreSession.mockImplementation(() => {
      calls.push('restore');
    });
    actions.addAssistantMessage.mockImplementation(() => {
      calls.push('announce');
    });

    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await activateSessionSelection(
      { intent: 'fork', session: parentMetadata },
      '/workspace/parent',
      actions
    );

    expect(calls).toEqual(['service', 'ui:2', 'restore', 'announce']);
  });
});

describe('listSessionCandidatesForIntent', () => {
  beforeEach(() => {
    serviceMocks.listSessions.mockReset();
  });

  it('lists fork candidates from the resolved workspace only and excludes subagents', async () => {
    const candidates = [
      createSessionMetadata({
        sessionId: 'fork-source-1',
        projectPath: '/workspace/project',
      }),
    ];
    serviceMocks.listSessions.mockResolvedValue(candidates);

    const { listSessionCandidatesForIntent } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      listSessionCandidatesForIntent('fork', '/workspace/project/nested/..')
    ).resolves.toEqual(candidates);

    expect(serviceMocks.listSessions).toHaveBeenCalledWith({
      cwd: '/workspace/project',
      includeSubagents: false,
    });
  });

  it('lists resume candidates from the global catalog without cwd filtering', async () => {
    const candidates = [
      createSessionMetadata({
        sessionId: 'resume-source-1',
        projectPath: '/workspace/elsewhere',
      }),
    ];
    serviceMocks.listSessions.mockResolvedValue(candidates);

    const { listSessionCandidatesForIntent } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      listSessionCandidatesForIntent('resume', '/workspace/project')
    ).resolves.toEqual(candidates);

    expect(serviceMocks.listSessions).toHaveBeenCalledWith();
  });
});

describe('BladeInterface startup routing source contract', () => {
  it('uses shared session candidate discovery for startup continue and selector flows', () => {
    const bladeInterfacePath = path.resolve(
      import.meta.dirname,
      '../../../../../src/ui/components/BladeInterface.tsx'
    );
    const source = fs.readFileSync(bladeInterfacePath, 'utf8');

    expect(source).toContain('listSessionCandidatesForIntent');

    const handleContinueStart = source.indexOf(
      'const handleContinue = useMemoizedFn(async () => {'
    );
    const handleResumeStart = source.indexOf(
      'const handleResume = useMemoizedFn(async () => {'
    );
    const handleResponseStart = source.indexOf(
      'const handleResponse = useMemoizedFn(async (response: ConfirmationResponse) => {'
    );

    expect(handleContinueStart).toBeGreaterThanOrEqual(0);
    expect(handleResumeStart).toBeGreaterThan(handleContinueStart);
    expect(handleResponseStart).toBeGreaterThan(handleResumeStart);

    const handleContinueSource = source.slice(handleContinueStart, handleResumeStart);
    const handleResumeSource = source.slice(handleResumeStart, handleResponseStart);

    expect(handleContinueSource).toContain('listSessionCandidatesForIntent(');
    expect(handleContinueSource).not.toContain('SessionService.listSessions(');
    expect(handleResumeSource).toContain('listSessionCandidatesForIntent(');
    expect(handleResumeSource).not.toContain('SessionService.listSessions({');
  });
});
