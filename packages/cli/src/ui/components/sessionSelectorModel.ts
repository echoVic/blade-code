import { basename } from 'node:path';
import type { SessionSurfaceSummary } from '../../api/sessionSurfaceSchemas.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';

export function getSessionCandidateKey(session: SessionSurfaceSummary): string {
  const { locator } = session;
  if (locator.workspace.kind === 'acp-remote') {
    return [
      locator.version,
      locator.workspace.kind,
      locator.workspace.workspaceRef,
      locator.sessionId,
    ].join('\0');
  }
  return [
    locator.version,
    locator.workspace.kind,
    locator.workspace.projectPath,
    locator.sessionId,
  ].join('\0');
}

export function getSessionDisplayTitle(session: SessionSurfaceSummary): string {
  const title = session.title?.trim();
  return title || `Session ${session.locator.sessionId.slice(0, 8)}`;
}

export function getVisibleSessionCandidates(
  sessions: readonly SessionSurfaceSummary[],
  intent: SessionSelectionIntent
): SessionSurfaceSummary[] {
  const userSessions = sessions.filter(
    (session) => session.relationType !== 'subagent'
  );
  if (intent !== 'fork') {
    return userSessions;
  }
  return userSessions.filter(
    (session) => session.archivedAt === undefined && session.capabilities.history.fork
  );
}

export function getMostRecentLocalSessionCandidate(
  sessions: readonly SessionSurfaceSummary[]
): SessionSurfaceSummary | undefined {
  return sessions.find(
    (session) =>
      session.relationType !== 'subagent' && session.locator.workspace.kind === 'local'
  );
}

export function getSessionSelectorLabel(
  session: SessionSurfaceSummary,
  timestamp: string
): string {
  const title = getSessionDisplayTitle(session);
  if (session.locator.workspace.kind === 'acp-remote') {
    const archived = session.archivedAt ? ' · archived' : '';
    return `[remote · ${session.capabilities.connection} · history${archived}] ${title}\n${session.displayCwd} · ${session.messageCount} messages · ${timestamp}${session.hasErrors ? ' [!]' : ''}`;
  }

  const status = formatTaskStatus(session.taskStatus);
  const relation =
    session.relationType === 'subagent'
      ? ' ↳ subagent'
      : session.relationType === 'fork'
        ? ' ↳ fork'
        : '';
  return `[${status}] ${title} · ${timestamp} | ${basename(session.displayCwd)} | ${session.messageCount} 条消息${session.hasErrors ? ' [!]' : ''}${relation}`;
}

export function getSessionSelectorCopy(intent: SessionSelectionIntent): {
  title: string;
  instructions: string;
} {
  return {
    title: intent === 'fork' ? '选择要 fork 的会话:' : '选择要恢复的会话:',
    instructions:
      '(Left/Right to page | Up/Down to select | Enter to confirm | Esc to cancel)',
  };
}

function formatTaskStatus(status: SessionSurfaceSummary['taskStatus']): string {
  switch (status) {
    case 'queued':
      return 'QUEUED';
    case 'running':
      return 'RUNNING';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    case 'interrupted':
      return 'INTERRUPTED';
    case 'completed':
      return 'DONE';
  }
}
