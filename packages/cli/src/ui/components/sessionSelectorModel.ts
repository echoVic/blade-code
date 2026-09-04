import { basename } from 'node:path';
import type {
  SessionLocatorV2,
  SessionSurfaceSummary,
} from '../../api/sessionSurfaceSchemas.js';
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

interface TaskAttentionVisibilityBoundary {
  acknowledge(summary: SessionSurfaceSummary): Promise<void>;
  setVisibleLocator(locator?: SessionSurfaceSummary['locator']): Promise<void>;
}

interface TaskAttentionStarter {
  start(): Promise<void>;
  getState(): { readonly sessions: readonly SessionSurfaceSummary[] };
}

interface TaskAttentionStartupIdentity {
  continueSession: boolean;
  resume: string | undefined;
  forkSession: boolean;
  requestedSessionId: string | undefined;
  locator: SessionLocatorV2;
}

export async function initializeTuiTaskAttentionVisibility(
  controller: TaskAttentionStarter,
  visibility: TuiTaskAttentionVisibilityCoordinator,
  identity: TaskAttentionStartupIdentity
): Promise<void> {
  await controller.start();
  if (
    identity.continueSession ||
    identity.resume !== undefined ||
    identity.forkSession
  ) {
    return;
  }
  if (
    identity.requestedSessionId !== undefined &&
    controller
      .getState()
      .sessions.some((session) => sameLocator(session.locator, identity.locator))
  ) {
    return;
  }
  await visibility.proveLocal(identity.locator);
}

function sameLocator(left: SessionLocatorV2, right: SessionLocatorV2): boolean {
  if (
    left.sessionId !== right.sessionId ||
    left.workspace.kind !== right.workspace.kind
  ) {
    return false;
  }
  return left.workspace.kind === 'local' && right.workspace.kind === 'local'
    ? left.workspace.projectPath === right.workspace.projectPath
    : left.workspace.kind === 'acp-remote' &&
        right.workspace.kind === 'acp-remote' &&
        left.workspace.workspaceRef === right.workspace.workspaceRef;
}

export async function commitLocalTaskAttention(
  intent: SessionSelectionIntent,
  summary: SessionSurfaceSummary,
  attention: TaskAttentionVisibilityBoundary,
  activatedLocator?: SessionLocatorV2
): Promise<void> {
  if (intent === 'resume') {
    await attention.acknowledge(summary);
    await attention.setVisibleLocator(summary.locator);
    return;
  }
  if (activatedLocator) await attention.setVisibleLocator(activatedLocator);
}

export function finishLocalTaskAttention(
  intent: SessionSelectionIntent,
  source: SessionSurfaceSummary,
  activated: { sessionId: string; projectPath: string },
  visibility: TuiTaskAttentionVisibilityCoordinator
): Promise<void> {
  const locator: SessionLocatorV2 = {
    version: 2,
    sessionId: activated.sessionId,
    workspace: { kind: 'local', projectPath: activated.projectPath },
  };
  return commitLocalTaskAttention(
    intent,
    source,
    {
      acknowledge: (summary) => visibility.acknowledge(summary),
      setVisibleLocator: (visible) =>
        visible ? visibility.proveLocal(visible) : Promise.resolve(),
    },
    locator
  );
}

export function proveContinueFallbackVisibility(
  visibility: TuiTaskAttentionVisibilityCoordinator,
  locator: SessionLocatorV2
): Promise<void> {
  return visibility.proveLocal(locator);
}

export class TuiTaskAttentionVisibilityCoordinator {
  readonly remote: RemoteHistoryAttentionAcknowledger;
  private remoteEpoch = 0;
  private provenLocalLocator?: SessionLocatorV2;
  private remoteActive = false;

  constructor(private readonly attention: TaskAttentionVisibilityBoundary) {
    this.remote = new RemoteHistoryAttentionAcknowledger((summary) =>
      attention.acknowledge(summary)
    );
  }

  acknowledge(summary: SessionSurfaceSummary): Promise<void> {
    return this.attention.acknowledge(summary);
  }

  async proveLocal(locator: SessionLocatorV2): Promise<void> {
    this.provenLocalLocator = locator;
    if (this.remoteActive) return;
    this.remoteEpoch += 1;
    this.remote.reset();
    await this.attention.setVisibleLocator(locator);
  }

  async beginRemote(
    viewer: { intent: SessionSelectionIntent; session: SessionSurfaceSummary },
    generation: number
  ): Promise<void> {
    this.remoteActive = true;
    this.remoteEpoch += 1;
    this.remote.begin(viewer, generation);
    await this.attention.setVisibleLocator(undefined);
  }

  async endRemote(): Promise<void> {
    if (!this.remoteActive) return;
    this.remoteActive = false;
    this.remoteEpoch += 1;
    this.remote.reset();
    await this.attention.setVisibleLocator(this.provenLocalLocator);
  }

  async updateRemote(
    viewer: { intent: SessionSelectionIntent; session: SessionSurfaceSummary },
    history: SessionHistoryViewState
  ): Promise<void> {
    const epoch = this.remoteEpoch;
    if (!(await this.remote.update(viewer, history)) || epoch !== this.remoteEpoch) {
      return;
    }
    await this.attention.setVisibleLocator(history.session?.locator);
  }
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
      if (
        this.expectedView?.generation !== history.viewGeneration ||
        this.expectedView.key !== getSessionCandidateKey(history.session)
      ) {
        return false;
      }
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
  hasUnreadAttention = false
): string {
  const title = getSessionDisplayTitle(session);
  const attention = hasUnreadAttention ? '[NEW] ' : '';
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
