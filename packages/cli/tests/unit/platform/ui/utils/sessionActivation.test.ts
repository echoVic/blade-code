import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../../src/acp/AcpRemotePath.js';
import { createAcpRemoteWorkspaceDescriptor } from '../../../../../src/acp/AcpRemoteWorkspace.js';
import type { SessionSurfaceSummary } from '../../../../../src/api/sessionSurfaceSchemas.js';
import { PermissionMode } from '../../../../../src/config/types.js';
import { getBladeStorageRoot } from '../../../../../src/context/storage/BladeStorageRoot.js';
import type { Message } from '../../../../../src/services/ChatServiceInterface.js';
import type { SessionMetadata } from '../../../../../src/services/SessionService.js';
import type { SessionMessage } from '../../../../../src/store/types.js';
import { buildContextMessagesFromSession } from '../../../../../src/ui/utils/sessionContext.js';

const serviceMocks = vi.hoisted(() => ({
  assertSessionWritable: vi.fn(),
  forkSession: vi.fn(),
  findSessionMetadata: vi.fn(),
  listSessions: vi.fn(),
  loadSession: vi.fn(),
  loadSessionModelContext: vi.fn(),
  toUISafeMessages: vi.fn(),
}));
const modelMocks = vi.hoisted(() => ({
  updateConfig: vi.fn(),
}));

vi.mock('../../../../../src/services/SessionService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../src/services/SessionService.js')
  >('../../../../../src/services/SessionService.js');
  return {
    ...actual,
    SessionService: {
      ...actual.SessionService,
      assertSessionWritable: serviceMocks.assertSessionWritable,
      forkSession: serviceMocks.forkSession,
      findSessionMetadata: serviceMocks.findSessionMetadata,
      listSessions: serviceMocks.listSessions,
      loadSession: serviceMocks.loadSession,
      loadSessionModelContext: serviceMocks.loadSessionModelContext,
      toUISafeMessages: serviceMocks.toUISafeMessages,
    },
  };
});

vi.mock('../../../../../src/store/vanilla.js', () => ({
  getState: () => ({
    config: {
      actions: {
        updateConfig: modelMocks.updateConfig,
      },
    },
  }),
  getModelById: (modelId: string) =>
    modelId === 'model-2' ? { id: modelId } : undefined,
}));

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
    taskStatus: 'completed',
    messageCount: 8,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

function createLocalSurfaceSummary(metadata: SessionMetadata): SessionSurfaceSummary {
  return {
    locator: {
      version: 2,
      sessionId: metadata.sessionId,
      workspace: { kind: 'local', projectPath: metadata.projectPath },
    },
    displayCwd: metadata.projectPath,
    title: metadata.title,
    rootId: metadata.rootId,
    parentId: metadata.parentId,
    relationType: metadata.relationType,
    taskStatus: metadata.taskStatus,
    messageCount: metadata.messageCount,
    firstMessageTime: metadata.firstMessageTime,
    lastMessageTime: metadata.lastMessageTime,
    hasErrors: metadata.hasErrors,
    archivedAt: metadata.archivedAt,
    selectedModelId: metadata.selectedModelId,
    capabilities: {
      connection: 'local',
      history: { read: true, fork: metadata.archivedAt === undefined },
      turn: metadata.archivedAt
        ? { start: false, reason: 'archived' }
        : { start: true },
      files: metadata.archivedAt
        ? { readText: false, writeText: false, browse: 'none', reason: 'archived' }
        : { readText: true, writeText: true, browse: 'tree' },
      terminal: metadata.archivedAt
        ? { mode: 'none', owner: 'none', reason: 'archived' }
        : { mode: 'interactive', owner: 'local' },
    },
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
        (
          sessionId: string,
          messages: SessionMessage[],
          rawMessages: Message[],
          workspaceRoot?: string
        ) => void
      >(),
    addAssistantMessage: vi.fn<(message: string) => void>(),
  };

  beforeEach(() => {
    modelMocks.updateConfig.mockReset();
  });
  const cleanupAgent = vi.fn<() => Promise<void>>();

  beforeEach(() => {
    serviceMocks.assertSessionWritable.mockReset();
    serviceMocks.assertSessionWritable.mockResolvedValue(undefined);
    serviceMocks.forkSession.mockReset();
    serviceMocks.findSessionMetadata.mockReset();
    serviceMocks.listSessions.mockReset();
    serviceMocks.loadSession.mockReset();
    serviceMocks.loadSessionModelContext.mockReset();
    serviceMocks.loadSessionModelContext.mockResolvedValue(childMessages);
    serviceMocks.toUISafeMessages.mockReset();
    actions.restoreSession.mockReset();
    actions.addAssistantMessage.mockReset();
    cleanupAgent.mockReset();
    cleanupAgent.mockResolvedValue(undefined);
  });

  it('resolves a V2 local summary through its exact locator before activation', async () => {
    const metadata = createSessionMetadata({
      sessionId: 'local-surface',
      projectPath: '/workspace/exact',
    });
    serviceMocks.findSessionMetadata.mockResolvedValue(metadata);
    const { resolveLocalSessionSurface } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      resolveLocalSessionSurface(createLocalSurfaceSummary(metadata))
    ).resolves.toBe(metadata);
    expect(serviceMocks.findSessionMetadata).toHaveBeenCalledWith(
      'local-surface',
      '/workspace/exact'
    );
  });

  it('rejects a remote summary before calling any local Session lookup', async () => {
    const summary = createLocalSurfaceSummary(createSessionMetadata());
    summary.locator = {
      version: 2,
      sessionId: 'remote-surface',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'R'.repeat(43)}`,
      },
    };
    const { resolveLocalSessionSurface } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(resolveLocalSessionSurface(summary)).rejects.toThrow(
      'Remote history cannot enter the local activation path'
    );
    expect(serviceMocks.findSessionMetadata).not.toHaveBeenCalled();
  });

  it('rejects a protected remote state root disguised as a local locator', async () => {
    const metadata = createSessionMetadata({
      sessionId: 'forged-local-surface',
      projectPath: path.join(
        getBladeStorageRoot(),
        'acp-remote-workspaces',
        'a'.repeat(64),
        'sessions'
      ),
    });
    const { resolveLocalSessionSurface } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      resolveLocalSessionSurface(createLocalSurfaceSummary(metadata))
    ).rejects.toThrow('projectPath must reference a local workspace');
    expect(serviceMocks.findSessionMetadata).not.toHaveBeenCalled();
  });

  it('rejects a local locator whose record became remote before activation', async () => {
    const catalogMetadata = createSessionMetadata({
      sessionId: 'reclassified-session',
      projectPath: '/workspace/exact',
    });
    serviceMocks.findSessionMetadata.mockResolvedValue({
      ...catalogMetadata,
      remoteWorkspace: createAcpRemoteWorkspaceDescriptor(
        createAcpRemotePathProfile('C:\\Remote\\Repo')
      ),
    });
    const { resolveLocalSessionSurface } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      resolveLocalSessionSurface(createLocalSurfaceSummary(catalogMetadata))
    ).rejects.toThrow('Remote history cannot enter the local activation path');
    expect(serviceMocks.findSessionMetadata).toHaveBeenCalledWith(
      'reclassified-session',
      '/workspace/exact'
    );
  });

  it('dispatches a remote summary only to the history surface', async () => {
    const summary = createLocalSurfaceSummary(createSessionMetadata());
    summary.locator = {
      version: 2,
      sessionId: 'remote-surface',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'R'.repeat(43)}`,
      },
    };
    const openHistory = vi.fn();
    const activateLocal = vi.fn();
    const { dispatchSessionSurfaceSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      dispatchSessionSurfaceSelection(summary, 'resume', { openHistory, activateLocal })
    ).resolves.toBe('history-only');

    expect(openHistory).toHaveBeenCalledWith(summary, 'resume');
    expect(activateLocal).not.toHaveBeenCalled();
    expect(serviceMocks.findSessionMetadata).not.toHaveBeenCalled();
  });

  it('rejects a custom child id for a remote fork before opening history', async () => {
    const summary = createLocalSurfaceSummary(createSessionMetadata());
    summary.locator = {
      version: 2,
      sessionId: 'remote-surface',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'R'.repeat(43)}`,
      },
    };
    const openHistory = vi.fn();
    const activateLocal = vi.fn();
    const { dispatchSessionSurfaceSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      dispatchSessionSurfaceSelection(
        summary,
        'fork',
        { openHistory, activateLocal },
        { newSessionId: 'requested-child' }
      )
    ).rejects.toThrow('Custom Session IDs are unavailable for remote history forks');

    expect(openHistory).not.toHaveBeenCalled();
    expect(activateLocal).not.toHaveBeenCalled();
    expect(serviceMocks.findSessionMetadata).not.toHaveBeenCalled();
  });

  it('does not switch stores or announce when cleanup fails after durable fork creation', async () => {
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
    cleanupAgent.mockRejectedValue(new Error('runtime cleanup failed'));

    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      activateSessionSelection(
        { intent: 'fork', session: parentMetadata },
        '/workspace/parent',
        actions,
        cleanupAgent
      )
    ).rejects.toThrow('runtime cleanup failed');

    expect(serviceMocks.forkSession).toHaveBeenCalledOnce();
    expect(serviceMocks.toUISafeMessages).toHaveBeenCalledWith(childMessages);
    expect(actions.restoreSession).not.toHaveBeenCalled();
    expect(actions.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('restores a UI-only fork announcement without adding it to model context', async () => {
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
      { intent: 'fork', session: parentMetadata },
      '/workspace/parent',
      actions,
      cleanupAgent
    );

    expect(actions.restoreSession).toHaveBeenCalledOnce();
    const [, visibleMessages, restoredContextMessages] =
      actions.restoreSession.mock.calls[0]!;
    expect(visibleMessages).toEqual([
      ...safeMessages,
      expect.objectContaining({
        role: 'assistant',
        content: 'Forked parent-s… → child-se…',
      }),
    ]);
    expect(restoredContextMessages).toBe(childMessages);
    expect(
      buildContextMessagesFromSession({
        messages: visibleMessages,
        restoredContextMessages,
        restoredVisibleMessageCount: visibleMessages.length,
      })
    ).toEqual(childMessages);
    expect(actions.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('activates resume selections from another workspace', async () => {
    const resumeMetadata = createSessionMetadata({
      sessionId: 'resume-session-12345678',
      projectPath: '/workspace/elsewhere',
      permissionMode: 'plan',
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
        actions,
        cleanupAgent
      )
    ).resolves.toEqual({
      sessionId: 'resume-session-12345678',
      messages: childMessages,
    });
    expect(modelMocks.updateConfig).toHaveBeenCalledWith({
      permissionMode: 'plan',
    });

    expect(serviceMocks.loadSession).toHaveBeenCalledWith(
      'resume-session-12345678',
      '/workspace/elsewhere'
    );
    expect(actions.restoreSession).toHaveBeenCalledWith(
      'resume-session-12345678',
      safeMessages,
      childMessages,
      '/workspace/elsewhere'
    );
  });

  it('gives an explicit invocation mode precedence over resumed metadata', async () => {
    const resumeMetadata = createSessionMetadata({
      sessionId: 'resume-session-explicit',
      projectPath: '/workspace/elsewhere',
      permissionMode: 'yolo',
    });
    serviceMocks.loadSession.mockResolvedValue(childMessages);
    serviceMocks.toUISafeMessages.mockReturnValue(safeMessages);
    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await activateSessionSelection(
      {
        intent: 'resume',
        session: resumeMetadata,
        permissionModeOverride: PermissionMode.DEFAULT,
      },
      '/workspace/parent',
      actions,
      cleanupAgent
    );

    expect(modelMocks.updateConfig).toHaveBeenCalledWith({
      permissionMode: 'default',
    });
  });

  it('forks inside the current workspace and restores child messages with a visible announcement', async () => {
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
        actions,
        cleanupAgent
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
      [
        ...safeMessages,
        expect.objectContaining({
          role: 'assistant',
          content: 'Forked parent-s… → child-se…',
        }),
      ],
      childMessages,
      '/workspace/parent'
    );
    expect(actions.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('forks in the selected session workspace when it differs from the launch workspace', async () => {
    const parentMetadata = createSessionMetadata({
      projectPath: '/workspace/other/../other',
    });
    serviceMocks.forkSession.mockResolvedValue({
      sessionId: 'child-session-abcdefgh',
      parentSessionId: parentMetadata.sessionId,
      projectPath: '/workspace/other',
      messages: childMessages,
      metadata: createSessionMetadata({
        sessionId: 'child-session-abcdefgh',
        projectPath: '/workspace/other',
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
        actions,
        cleanupAgent
      )
    ).resolves.toMatchObject({ sessionId: 'child-session-abcdefgh' });

    expect(serviceMocks.forkSession).toHaveBeenCalledWith('parent-session-12345678', {
      sourceProjectPath: '/workspace/other',
      targetProjectPath: '/workspace/other',
    });
    expect(actions.restoreSession).toHaveBeenCalledWith(
      'child-session-abcdefgh',
      expect.any(Array),
      childMessages,
      '/workspace/other'
    );
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
      actions,
      cleanupAgent
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
        actions,
        cleanupAgent
      )
    ).rejects.toThrow('fork failed');

    expect(serviceMocks.toUISafeMessages).not.toHaveBeenCalled();
    expect(actions.restoreSession).not.toHaveBeenCalled();
    expect(actions.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('loads and restores resume selections from the current workspace without announcements', async () => {
    const resumeMetadata = createSessionMetadata({
      sessionId: 'resume-session-12345678',
      projectPath: '/workspace/parent',
      selectedModelId: 'model-2',
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
        actions,
        cleanupAgent
      )
    ).resolves.toEqual({
      sessionId: 'resume-session-12345678',
      messages: childMessages,
    });

    expect(serviceMocks.loadSession).toHaveBeenCalledWith(
      'resume-session-12345678',
      '/workspace/parent'
    );
    expect(serviceMocks.forkSession).not.toHaveBeenCalled();
    expect(serviceMocks.toUISafeMessages).toHaveBeenCalledWith(childMessages);
    expect(actions.restoreSession).toHaveBeenCalledWith(
      'resume-session-12345678',
      safeMessages,
      childMessages,
      '/workspace/parent'
    );
    expect(modelMocks.updateConfig).toHaveBeenCalledWith({
      currentModelId: 'model-2',
    });
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
    cleanupAgent.mockImplementation(async () => {
      calls.push('cleanup');
    });

    const { activateSessionSelection } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await activateSessionSelection(
      { intent: 'fork', session: parentMetadata },
      '/workspace/parent',
      actions,
      cleanupAgent
    );

    expect(calls).toEqual(['service', 'ui:2', 'cleanup', 'restore']);
  });
});

describe('listSessionCandidatesForIntent', () => {
  beforeEach(() => {
    serviceMocks.listSessions.mockReset();
  });

  it('lists fork candidates across workspaces and excludes subagents', async () => {
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
    ).resolves.toEqual(candidates.map(createLocalSurfaceSummary));

    expect(serviceMocks.listSessions).toHaveBeenCalledWith({
      includeSubagents: false,
    });
  });

  it('lists resume candidates across workspaces and excludes subagents', async () => {
    const candidates = [
      createSessionMetadata({
        sessionId: 'resume-source-1',
        projectPath: '/workspace/project',
      }),
    ];
    serviceMocks.listSessions.mockResolvedValue(candidates);

    const { listSessionCandidatesForIntent } = await import(
      '../../../../../src/ui/utils/sessionActivation.js'
    );

    await expect(
      listSessionCandidatesForIntent('resume', '/workspace/project')
    ).resolves.toEqual(candidates.map(createLocalSurfaceSummary));

    expect(serviceMocks.listSessions).toHaveBeenCalledWith({
      includeSubagents: false,
    });
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
    expect(source).not.toContain('SessionService.findSessionMetadata(sourceSessionId)');
  });
});
