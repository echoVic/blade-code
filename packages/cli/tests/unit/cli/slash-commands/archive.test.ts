import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  archiveSession: vi.fn(),
  listSessions: vi.fn(),
  unarchiveSession: vi.fn(),
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionArchiveConflictError: class SessionArchiveConflictError extends Error {},
  SessionService: mocks,
}));

import {
  archiveCommand,
  unarchiveCommand,
} from '../../../../src/slash-commands/archive.js';

const active = {
  sessionId: 'session-a',
  projectPath: '/workspace/a',
  rootId: 'session-a',
  taskStatus: 'completed' as const,
  messageCount: 2,
  firstMessageTime: '2026-08-09T00:00:00.000Z',
  lastMessageTime: '2026-08-09T00:01:00.000Z',
  hasErrors: false,
};

describe('session archive slash commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('archives a uniquely resolved inactive session', async () => {
    mocks.listSessions.mockResolvedValue([active]);
    mocks.archiveSession.mockResolvedValue({
      ...active,
      archivedAt: '2026-08-09T00:02:00.000Z',
      archivedBySessionId: active.sessionId,
    });

    const result = await archiveCommand.handler([active.sessionId], {
      cwd: '/workspace/current',
    });

    expect(result.success).toBe(true);
    expect(mocks.listSessions).toHaveBeenCalledWith({
      archived: false,
      includeSubagents: false,
    });
    expect(mocks.archiveSession).toHaveBeenCalledWith(
      active.sessionId,
      active.projectPath
    );
  });

  it('restores an archived root and rejects ambiguous IDs', async () => {
    mocks.listSessions.mockResolvedValueOnce([
      { ...active, archivedAt: '2026-08-09T00:02:00.000Z' },
    ]);
    mocks.unarchiveSession.mockResolvedValue(active);
    await expect(
      unarchiveCommand.handler([active.sessionId], { cwd: '/workspace/current' })
    ).resolves.toMatchObject({ success: true });

    mocks.listSessions.mockResolvedValueOnce([
      active,
      { ...active, projectPath: '/workspace/b' },
    ]);
    await expect(
      archiveCommand.handler([active.sessionId], { cwd: '/workspace/current' })
    ).resolves.toEqual({
      success: false,
      error: `Multiple workspaces contain session ${active.sessionId}`,
    });
  });

  it('archives the current TUI session through its owned lifecycle boundary', async () => {
    const archiveCurrent = vi.fn().mockResolvedValue({
      ...active,
      archivedAt: '2026-08-09T00:02:00.000Z',
      archivedBySessionId: active.sessionId,
    });
    await expect(
      archiveCommand.handler([], {
        cwd: '/workspace/current',
        sessionId: active.sessionId,
        lifecycle: { archiveCurrent },
      })
    ).resolves.toMatchObject({
      success: true,
      message: 'session_archived',
    });
    expect(archiveCurrent).toHaveBeenCalledOnce();
  });

  it('fails closed without an owned lifecycle and validates argument counts', async () => {
    await expect(
      archiveCommand.handler([], { cwd: '/workspace/current' })
    ).resolves.toEqual({
      success: false,
      error: 'Current surface cannot archive its active session; provide a session ID',
    });
    await expect(
      archiveCommand.handler(['one', 'two'], { cwd: '/workspace/current' })
    ).resolves.toEqual({
      success: false,
      error: 'Usage: /archive [sessionId]',
    });
    await expect(
      unarchiveCommand.handler([], { cwd: '/workspace/current' })
    ).resolves.toEqual({
      success: false,
      error: 'Usage: /unarchive <sessionId>',
    });
  });
});
