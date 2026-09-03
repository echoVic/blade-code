import { describe, expect, it } from 'vitest';
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

    const label = getSessionSelectorLabel(createLocalSummary(), '今天 16:20');

    expect(label).toContain('[DONE]');
    expect(label).toContain('| a |');
    expect(label).not.toContain('[remote');
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
