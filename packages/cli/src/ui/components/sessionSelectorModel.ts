import { basename } from 'node:path';
import type { SessionSurfaceSummary } from '../../api/sessionSurfaceSchemas.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';
import type { SessionHistoryViewState } from '../services/SessionHistoryController.js';
import { getTuiTaskAttentionKey } from '../services/TuiTaskAttentionStore.js';

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

export function getTaskAttentionKey(session: SessionSurfaceSummary): string {
  return getTuiTaskAttentionKey(session.locator);
}

interface LocalTaskAttentionBoundary {
  acknowledge(summary: SessionSurfaceSummary): Promise<void>;
  setVisibleLocator(locator: SessionSurfaceSummary['locator']): Promise<void>;
}

export async function commitLocalTaskAttention(
  intent: SessionSelectionIntent,
  summary: SessionSurfaceSummary,
  attention: LocalTaskAttentionBoundary
): Promise<void> {
  if (intent !== 'resume') return;
  await attention.acknowledge(summary);
  await attention.setVisibleLocator(summary.locator);
}

export class RemoteHistoryAttentionAcknowledger {
  private acknowledgedView?: string;
  private pendingView?: string;
  private expectedView?: { key: string; generation: number };

  constructor(
    private readonly acknowledge: (summary: SessionSurfaceSummary) => Promise<void>
  ) {}

  begin(
    viewer: { intent: SessionSelectionIntent; session: SessionSurfaceSummary },
    generation: number
  ): void {
    this.expectedView =
      viewer.intent === 'resume'
        ? { key: getSessionCandidateKey(viewer.session), generation }
        : undefined;
  }

  reset(): void {
    this.expectedView = undefined;
  }

  async update(
    viewer: { intent: SessionSelectionIntent; session: SessionSurfaceSummary },
    history: SessionHistoryViewState
  ): Promise<boolean> {
    if (
      viewer.intent !== 'resume' ||
      history.status !== 'ready' ||
      !history.session ||
      !this.expectedView ||
      history.viewGeneration !== this.expectedView.generation ||
      getSessionCandidateKey(viewer.session) !== this.expectedView.key ||
      getSessionCandidateKey(viewer.session) !== getSessionCandidateKey(history.session)
    ) {
      return false;
    }
    const view = `${history.viewGeneration}\0${getSessionCandidateKey(history.session)}`;
    if (view === this.acknowledgedView || view === this.pendingView) return false;
    this.pendingView = view;
    try {
      await this.acknowledge(history.session);
      this.acknowledgedView = view;
      return true;
    } finally {
      if (this.pendingView === view) this.pendingView = undefined;
    }
  }
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
  timestamp: string,
  intent: SessionSelectionIntent = 'resume',
  taskAttentionUnreadKeys: readonly string[] = []
): string {
  const title = getSessionDisplayTitle(session);
  const attention =
    intent === 'resume' &&
    taskAttentionUnreadKeys.includes(getTaskAttentionKey(session))
      ? '[NEW] '
      : '';
  if (session.locator.workspace.kind === 'acp-remote') {
    const archived = session.archivedAt ? ' · archived' : '';
    return `${attention}[remote · ${session.capabilities.connection} · history${archived}] ${title}\n${session.displayCwd} · ${session.messageCount} messages · ${timestamp}${session.hasErrors ? ' [!]' : ''}`;
  }

  const status = formatTaskStatus(session.taskStatus);
  const relation =
    session.relationType === 'subagent'
      ? ' ↳ subagent'
      : session.relationType === 'fork'
        ? ' ↳ fork'
        : '';
  return `${attention}[${status}] ${title} · ${timestamp} | ${basename(session.displayCwd)} | ${session.messageCount} 条消息${session.hasErrors ? ' [!]' : ''}${relation}`;
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
