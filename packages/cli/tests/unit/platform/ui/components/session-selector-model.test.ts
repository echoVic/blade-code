import { describe, expect, it, vi } from 'vitest';
import type {
  SessionSurfaceCapabilities,
  SessionSurfaceSummary,
} from '../../../../../src/api/sessionSurfaceSchemas.js';

const REMOTE_WORKSPACE_REF_A = `acp-remote-workspace:${'A'.repeat(43)}`;
const REMOTE_WORKSPACE_REF_B = `acp-remote-workspace:${'B'.repeat(43)}`;

function createCapabilities(
  overrides: Partial<SessionSurfaceCapabilities> = {}
): SessionSurfaceCapabilities {
  return {
    connection: 'local',
    history: { read: true, fork: true },
    turn: { start: true },
    files: { readText: true, writeText: true, browse: 'tree' },
    terminal: { mode: 'interactive', owner: 'local' },
    ...overrides,
  };
}

function createLocalSummary(
  overrides: Partial<SessionSurfaceSummary> = {}
): SessionSurfaceSummary {
  return {
    locator: {
      version: 2,
      sessionId: 'session-1',
      workspace: { kind: 'local', projectPath: '/workspace/a' },
    },
    displayCwd: '/workspace/a',
    pathStyle: 'posix',
    title: 'Session One',
    rootId: 'root-1',
    taskStatus: 'completed',
    messageCount: 3,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    capabilities: createCapabilities(),
    ...overrides,
  };
}

function createRemoteSummary(
  overrides: Partial<SessionSurfaceSummary> = {}
): SessionSurfaceSummary {
  return {
    ...createLocalSummary(),
    locator: {
      version: 2,
      sessionId: 'remote-session-1',
      workspace: { kind: 'acp-remote', workspaceRef: REMOTE_WORKSPACE_REF_A },
    },
    displayCwd: 'C:\\Repo',
    pathStyle: 'win32',
    title: 'Fix Windows path handling',
    messageCount: 42,
    capabilities: createCapabilities({
      connection: 'offline',
      history: { read: true, fork: true },
      turn: { start: false, reason: 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: 'history-only',
      },
      terminal: { mode: 'none', owner: 'none', reason: 'history-only' },
    }),
    ...overrides,
  };
}

describe('sessionSelectorModel', () => {
  it('clears an old local visible locator before a remote viewer can refresh', async () => {
    const { TuiTaskAttentionVisibilityCoordinator, getSessionCandidateKey } =
      await import('../../../../../src/ui/components/sessionSelectorModel.js');
    const local = createLocalSummary({ taskStatus: 'running' });
    const remote = createRemoteSummary();
    let visibleLocator: SessionSurfaceSummary['locator'] | undefined = local.locator;
    const acknowledge = vi.fn(async (_summary: SessionSurfaceSummary) => undefined);
    const setVisibleLocator = vi.fn(
      async (locator: SessionSurfaceSummary['locator'] | undefined) => {
        visibleLocator = locator;
      }
    );
    const coordinator = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge,
      setVisibleLocator,
    });

    const clearing = coordinator.beginRemote({ intent: 'resume', session: remote }, 7);
    expect(setVisibleLocator).toHaveBeenCalledWith(undefined);
    await clearing;

    const completedLocal = {
      ...local,
      taskStatus: 'completed' as const,
      taskCompletedAt: '2026-09-05T10:00:00.000Z',
    };
    if (
      visibleLocator &&
      getSessionCandidateKey({ ...local, locator: visibleLocator }) ===
        getSessionCandidateKey(completedLocal)
    ) {
      await acknowledge(completedLocal);
    }
    expect(visibleLocator).toBeUndefined();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('marks a default new local session visible only after attention startup completes', async () => {
    const {
      initializeTuiTaskAttentionVisibility,
      TuiTaskAttentionVisibilityCoordinator,
    } = await import('../../../../../src/ui/components/sessionSelectorModel.js');
    let resolveStart = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const acknowledge = vi.fn(async (_summary: SessionSurfaceSummary) => undefined);
    const setVisibleLocator = vi.fn(
      async (_locator: SessionSurfaceSummary['locator'] | undefined) => undefined
    );
    const coordinator = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge,
      setVisibleLocator,
    });
    const local = createLocalSummary();

    const initialization = initializeTuiTaskAttentionVisibility(
      {
        start: vi.fn(() => started),
        getState: () => ({ sessions: [] }),
      },
      coordinator,
      {
        continueSession: false,
        resume: undefined,
        forkSession: false,
        requestedSessionId: undefined,
        locator: local.locator,
      }
    );
    await Promise.resolve();
    expect(setVisibleLocator).not.toHaveBeenCalled();

    resolveStart();
    await initialization;
    expect(setVisibleLocator).toHaveBeenCalledWith(local.locator);
  });

  it('does not infer visibility from a mounted explicit session id', async () => {
    const {
      initializeTuiTaskAttentionVisibility,
      TuiTaskAttentionVisibilityCoordinator,
    } = await import('../../../../../src/ui/components/sessionSelectorModel.js');
    const acknowledge = vi.fn(async (_summary: SessionSurfaceSummary) => undefined);
    const setVisibleLocator = vi.fn(
      async (_locator: SessionSurfaceSummary['locator'] | undefined) => undefined
    );
    const coordinator = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge,
      setVisibleLocator,
    });
    const local = createLocalSummary();

    await initializeTuiTaskAttentionVisibility(
      {
        start: vi.fn(async () => undefined),
        getState: () => ({ sessions: [local] }),
      },
      coordinator,
      {
        continueSession: false,
        resume: undefined,
        forkSession: false,
        requestedSessionId: local.locator.sessionId,
        locator: local.locator,
      }
    );

    expect(acknowledge).not.toHaveBeenCalled();
    expect(setVisibleLocator).not.toHaveBeenCalled();
  });

  it('proves an explicit session id that is absent from the startup catalog', async () => {
    const {
      initializeTuiTaskAttentionVisibility,
      TuiTaskAttentionVisibilityCoordinator,
    } = await import('../../../../../src/ui/components/sessionSelectorModel.js');
    const local = createLocalSummary();
    const setVisibleLocator = vi.fn(
      async (_locator: SessionSurfaceSummary['locator'] | undefined) => undefined
    );
    const coordinator = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge: vi.fn(async (_summary: SessionSurfaceSummary) => undefined),
      setVisibleLocator,
    });

    await initializeTuiTaskAttentionVisibility(
      {
        start: vi.fn(async () => undefined),
        getState: () => ({ sessions: [] }),
      },
      coordinator,
      {
        continueSession: false,
        resume: undefined,
        forkSession: false,
        requestedSessionId: local.locator.sessionId,
        locator: local.locator,
      }
    );

    expect(setVisibleLocator).toHaveBeenCalledWith(local.locator);
  });

  it('proves the new local identity when continue has no resumable local session', async () => {
    const { proveContinueFallbackVisibility, TuiTaskAttentionVisibilityCoordinator } =
      await import('../../../../../src/ui/components/sessionSelectorModel.js');
    const local = createLocalSummary();
    const setVisibleLocator = vi.fn(
      async (_locator: SessionSurfaceSummary['locator'] | undefined) => undefined
    );
    const coordinator = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge: vi.fn(async (_summary: SessionSurfaceSummary) => undefined),
      setVisibleLocator,
    });

    await proveContinueFallbackVisibility(coordinator, local.locator);

    expect(setVisibleLocator).toHaveBeenCalledWith(local.locator);
  });

  it('restores only a proven local locator when a remote viewer closes', async () => {
    const { TuiTaskAttentionVisibilityCoordinator } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );
    const local = createLocalSummary();
    const remote = createRemoteSummary();
    const setVisibleLocator = vi.fn(
      async (_locator: SessionSurfaceSummary['locator'] | undefined) => undefined
    );
    const coordinator = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge: vi.fn(async (_summary: SessionSurfaceSummary) => undefined),
      setVisibleLocator,
    });

    await coordinator.proveLocal(local.locator);
    await coordinator.beginRemote({ intent: 'resume', session: remote }, 7);
    setVisibleLocator.mockClear();
    await coordinator.endRemote();
    expect(setVisibleLocator).toHaveBeenCalledWith(local.locator);

    const withoutLocal = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge: vi.fn(async (_summary: SessionSurfaceSummary) => undefined),
      setVisibleLocator,
    });
    await withoutLocal.beginRemote({ intent: 'resume', session: remote }, 8);
    setVisibleLocator.mockClear();
    await withoutLocal.endRemote();
    expect(setVisibleLocator).toHaveBeenCalledWith(undefined);
    setVisibleLocator.mockClear();
    await withoutLocal.endRemote();
    expect(setVisibleLocator).not.toHaveBeenCalled();
  });

  it('does not write visibility when remote cleanup runs before any remote view', async () => {
    const { TuiTaskAttentionVisibilityCoordinator } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );
    const setVisibleLocator = vi.fn(
      async (_locator: SessionSurfaceSummary['locator'] | undefined) => undefined
    );
    const coordinator = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge: vi.fn(async (_summary: SessionSurfaceSummary) => undefined),
      setVisibleLocator,
    });

    await coordinator.endRemote();

    expect(setVisibleLocator).not.toHaveBeenCalled();
  });

  it('does not publish stale remote visibility when acknowledgement finishes after another view begins', async () => {
    const { TuiTaskAttentionVisibilityCoordinator } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );
    const first = createRemoteSummary();
    const second = createRemoteSummary({
      locator: {
        version: 2,
        sessionId: 'remote-session-2',
        workspace: { kind: 'acp-remote', workspaceRef: REMOTE_WORKSPACE_REF_B },
      },
    });
    let resolveAcknowledgement = (): void => undefined;
    const acknowledgement = new Promise<void>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    const setVisibleLocator = vi.fn(
      async (_locator: SessionSurfaceSummary['locator'] | undefined) => undefined
    );
    const coordinator = new TuiTaskAttentionVisibilityCoordinator({
      acknowledge: vi.fn(() => acknowledgement),
      setVisibleLocator,
    });
    await coordinator.beginRemote({ intent: 'resume', session: first }, 7);
    setVisibleLocator.mockClear();
    const staleUpdate = coordinator.updateRemote(
      { intent: 'resume', session: first },
      {
        viewGeneration: 7,
        status: 'ready',
        session: first,
        messages: [],
        truncated: false,
      }
    );
    await Promise.resolve();

    await coordinator.beginRemote({ intent: 'resume', session: second }, 8);
    setVisibleLocator.mockClear();
    resolveAcknowledgement();
    await staleUpdate;

    expect(setVisibleLocator).not.toHaveBeenCalled();
  });

  it('reports a deferred acknowledgement as stale after the expected remote view changes', async () => {
    const { RemoteHistoryAttentionAcknowledger } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );
    const first = createRemoteSummary();
    const second = createRemoteSummary({
      locator: {
        version: 2,
        sessionId: 'remote-session-2',
        workspace: { kind: 'acp-remote', workspaceRef: REMOTE_WORKSPACE_REF_B },
      },
    });
    let resolveAcknowledgement = (): void => undefined;
    const acknowledgement = new Promise<void>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    const acknowledger = new RemoteHistoryAttentionAcknowledger(() => acknowledgement);
    acknowledger.begin({ intent: 'resume', session: first }, 7);
    const staleUpdate = acknowledger.update(
      { intent: 'resume', session: first },
      {
        viewGeneration: 7,
        status: 'ready',
        session: first,
        messages: [],
        truncated: false,
      }
    );
    await Promise.resolve();
    acknowledger.begin({ intent: 'resume', session: second }, 8);
    resolveAcknowledgement();

    await expect(staleUpdate).resolves.toBe(false);
  });

  it('returns intent-specific selector copy', async () => {
    const { getSessionSelectorCopy } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );

    expect(getSessionSelectorCopy('fork')).toEqual({
      title: '选择要 fork 的会话:',
      instructions:
        '(Left/Right to page | Up/Down to select | Enter to confirm | Esc to cancel)',
    });
    expect(getSessionSelectorCopy('resume')).toEqual({
      title: '选择要恢复的会话:',
      instructions:
        '(Left/Right to page | Up/Down to select | Enter to confirm | Esc to cancel)',
    });
  });

  it('excludes subagents from the user catalog and filters fork capability', async () => {
    const ordinary = createLocalSummary();
    const subagent = createLocalSummary({
      locator: {
        version: 2,
        sessionId: 'subagent-1',
        workspace: { kind: 'local', projectPath: '/workspace/a' },
      },
      relationType: 'subagent',
      rootId: 'root-subagent',
    });
    const archivedRemote = createRemoteSummary({
      archivedAt: '2026-09-02T08:00:00.000Z',
      capabilities: createCapabilities({
        connection: 'offline',
        history: { read: true, fork: false },
      }),
    });

    const { getVisibleSessionCandidates } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );

    expect(
      getVisibleSessionCandidates([ordinary, subagent, archivedRemote], 'fork')
    ).toEqual([ordinary]);
    expect(
      getVisibleSessionCandidates([ordinary, subagent, archivedRemote], 'resume')
    ).toEqual([ordinary, archivedRemote]);
  });

  it('uses the complete locator for stable keys when session ids collide', async () => {
    const remoteA = createRemoteSummary();
    const remoteB = createRemoteSummary({
      locator: {
        version: 2,
        sessionId: 'remote-session-1',
        workspace: { kind: 'acp-remote', workspaceRef: REMOTE_WORKSPACE_REF_B },
      },
      displayCwd: '/same/display/path',
    });
    const local = createLocalSummary({
      locator: {
        version: 2,
        sessionId: 'remote-session-1',
        workspace: { kind: 'local', projectPath: '/workspace/a' },
      },
      displayCwd: '/same/display/path',
    });

    const { getSessionCandidateKey } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );

    const remoteAKey = getSessionCandidateKey(remoteA);
    const remoteBKey = getSessionCandidateKey(remoteB);
    const localKey = getSessionCandidateKey(local);

    expect(new Set([remoteAKey, remoteBKey, localKey]).size).toBe(3);
    expect(remoteAKey).toContain(REMOTE_WORKSPACE_REF_A);
    expect(remoteBKey).toContain(REMOTE_WORKSPACE_REF_B);
    expect(remoteAKey).not.toContain(remoteA.displayCwd);
    expect(remoteBKey).not.toContain(remoteB.displayCwd);
  });

  it('uses durable semantic titles with a stable legacy fallback', async () => {
    const { getSessionDisplayTitle } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );

    expect(
      getSessionDisplayTitle(createLocalSummary({ title: 'Implement navigation' }))
    ).toBe('Implement navigation');
    expect(
      getSessionDisplayTitle(
        createLocalSummary({
          locator: {
            version: 2,
            sessionId: 'legacy-session-id',
            workspace: { kind: 'local', projectPath: '/workspace/a' },
          },
          title: '   ',
        })
      )
    ).toBe('Session legacy-s');
  });

  it('labels remote history rows without treating display cwd as a local path', async () => {
    const { getSessionSelectorLabel } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );
    const remote = createRemoteSummary({ displayCwd: 'C:\\Repo' });

    const label = getSessionSelectorLabel(remote, '2026-09-02 16:20');

    expect(label).toContain('[remote · offline · history]');
    expect(label).toContain('Fix Windows path handling');
    expect(label).toContain('C:\\Repo');
    expect(label).toContain('C:\\Repo · 42 messages · 2026-09-02 16:20');
    expect(label).not.toContain(REMOTE_WORKSPACE_REF_A);
  });

  it('keeps local rows on the familiar compact path label', async () => {
    const { getSessionSelectorLabel } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );
    const session = createLocalSummary();

    const label = getSessionSelectorLabel(session, '今天 16:20');

    expect(label).toContain('[DONE]');
    expect(label).toContain('| a |');
    expect(label).not.toContain('[remote');

    expect(getSessionSelectorLabel(session, '今天 16:20', true)).toContain(
      '[NEW] [DONE] Session One'
    );
    expect(getSessionSelectorLabel(session, '今天 16:20', false)).not.toContain(
      '[NEW]'
    );
  });

  it('matches unread state by the exact locator when session ids collide', async () => {
    const { getSessionSelectorLabel, getTaskAttentionKey } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );
    const unread = createLocalSummary();
    const collision = createLocalSummary({
      locator: {
        version: 2,
        sessionId: unread.locator.sessionId,
        workspace: { kind: 'local', projectPath: '/workspace/b' },
      },
      displayCwd: '/workspace/b',
      title: 'Collision',
    });
    const unreadKeys = new Set([getTaskAttentionKey(unread)]);

    expect(
      getSessionSelectorLabel(
        unread,
        '今天 16:20',
        unreadKeys.has(getTaskAttentionKey(unread))
      )
    ).toContain('[NEW]');
    expect(
      getSessionSelectorLabel(
        collision,
        '今天 16:20',
        unreadKeys.has(getTaskAttentionKey(collision))
      )
    ).not.toContain('[NEW]');
  });

  it('preserves local-only automatic continue when a remote row is newer', async () => {
    const { getMostRecentLocalSessionCandidate } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );
    const remote = createRemoteSummary({
      lastMessageTime: '2026-09-02T12:00:00.000Z',
    });
    const local = createLocalSummary({
      lastMessageTime: '2026-09-02T11:00:00.000Z',
    });
    const subagent = createLocalSummary({
      locator: {
        version: 2,
        sessionId: 'newer-local-subagent',
        workspace: { kind: 'local', projectPath: '/workspace/a' },
      },
      relationType: 'subagent',
      rootId: 'root-subagent',
      lastMessageTime: '2026-09-02T13:00:00.000Z',
    });

    expect(getMostRecentLocalSessionCandidate([subagent, remote, local])).toBe(local);
    expect(getMostRecentLocalSessionCandidate([remote])).toBeUndefined();
  });
});
