import path from 'node:path';
import {
  type SessionSurfaceSummary,
  SessionSurfaceSummarySchema,
} from '../../api/sessionSurfaceSchemas.js';
import type { PermissionMode } from '../../config/types.js';
import { normalizeLocalWorkspacePath } from '../../server/sessionRef.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { SessionMetadata } from '../../services/SessionService.js';
import { SessionService } from '../../services/SessionService.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';
import type { SessionMessage } from '../../store/types.js';
import { getModelById, getState } from '../../store/vanilla.js';
import { getVisibleSessionCandidates } from '../components/sessionSelectorModel.js';

export interface SessionActivationActions {
  restoreSession: (
    sessionId: string,
    messages: SessionMessage[],
    rawMessages: Message[],
    workspaceRoot?: string
  ) => void;
}

export type CleanupAgent = () => Promise<void>;

export interface SessionSurfaceCatalogSource {
  listAll(): Promise<SessionSurfaceSummary[]>;
}

interface SessionSurfaceDispatch {
  openHistory: (
    summary: SessionSurfaceSummary,
    intent: SessionSelectionIntent
  ) => void | Promise<void>;
  activateLocal: (
    metadata: SessionMetadata,
    intent: SessionSelectionIntent
  ) => void | Promise<void>;
}

interface SessionSurfaceSelectionOptions {
  newSessionId?: string;
}

export async function dispatchSessionSurfaceSelection(
  summary: SessionSurfaceSummary,
  intent: SessionSelectionIntent,
  dispatch: SessionSurfaceDispatch,
  options: SessionSurfaceSelectionOptions = {}
): Promise<'history-only' | 'interactive'> {
  if (summary.locator.workspace.kind === 'acp-remote') {
    if (intent === 'fork' && options.newSessionId) {
      throw new Error('Custom Session IDs are unavailable for remote history forks');
    }
    await dispatch.openHistory(summary, intent);
    return 'history-only';
  }
  const metadata = await resolveLocalSessionSurface(summary);
  await dispatch.activateLocal(metadata, intent);
  return 'interactive';
}

export function toLocalSessionSurfaceSummary(
  metadata: SessionMetadata
): SessionSurfaceSummary {
  if (metadata.remoteWorkspace) {
    throw new Error('Remote history cannot enter the local compatibility path');
  }
  const archived = metadata.archivedAt !== undefined;
  return SessionSurfaceSummarySchema.parse({
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
    taskCompletedAt: metadata.taskCompletedAt,
    messageCount: metadata.messageCount,
    firstMessageTime: metadata.firstMessageTime,
    lastMessageTime: metadata.lastMessageTime,
    hasErrors: metadata.hasErrors,
    archivedAt: metadata.archivedAt,
    selectedModelId: metadata.selectedModelId,
    capabilities: {
      connection: 'local',
      history: { read: true, fork: !archived },
      turn: archived ? { start: false, reason: 'archived' } : { start: true },
      files: archived
        ? { readText: false, writeText: false, browse: 'none', reason: 'archived' }
        : { readText: true, writeText: true, browse: 'tree' },
      terminal: archived
        ? { mode: 'none', owner: 'none', reason: 'archived' }
        : { mode: 'interactive', owner: 'local' },
    },
  });
}

export async function resolveLocalSessionSurface(
  summary: SessionSurfaceSummary
): Promise<SessionMetadata> {
  if (summary.locator.workspace.kind !== 'local') {
    throw new Error('Remote history cannot enter the local activation path');
  }
  const projectPath = normalizeLocalWorkspacePath(
    summary.locator.workspace.projectPath
  );
  const metadata = await SessionService.findSessionMetadata(
    summary.locator.sessionId,
    projectPath
  );
  if (!metadata) {
    throw new Error('Session history is no longer available');
  }
  if (metadata.remoteWorkspace) {
    throw new Error('Remote history cannot enter the local activation path');
  }
  return metadata;
}

interface SessionSelectionInput {
  intent: SessionSelectionIntent;
  session: SessionMetadata;
  newSessionId?: string;
  announceFork?: boolean;
  permissionModeOverride?: PermissionMode;
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 8) {
    return sessionId;
  }
  return `${sessionId.slice(0, 8)}…`;
}

function resolveWorkspace(workspace: string): string {
  return path.resolve(workspace);
}

function activateModelInMemory(modelId?: string): void {
  if (!modelId || !getModelById(modelId)) return;
  getState().config.actions.updateConfig({ currentModelId: modelId });
}

function activatePermissionModeInMemory(
  permissionMode?: SessionMetadata['permissionMode']
): void {
  if (!permissionMode) return;
  getState().config.actions.updateConfig({
    permissionMode: permissionMode as PermissionMode,
  });
}

export async function listSessionCandidatesForIntent(
  intent: SessionSelectionIntent,
  _workspaceRoot: string,
  surfaceCatalog?: SessionSurfaceCatalogSource
): Promise<SessionSurfaceSummary[]> {
  const sessions = surfaceCatalog
    ? await surfaceCatalog.listAll()
    : (await SessionService.listSessions({ includeSubagents: false })).map(
        toLocalSessionSurfaceSummary
      );
  return getVisibleSessionCandidates(sessions, intent);
}

export async function activateSessionSelection(
  selection: SessionSelectionInput,
  _workspaceRoot: string,
  actions: SessionActivationActions,
  cleanupAgent: CleanupAgent
): Promise<{ sessionId: string; messages: Message[] }> {
  const { intent, session, newSessionId, announceFork, permissionModeOverride } =
    selection;
  const resolvedWorkspace = resolveWorkspace(session.projectPath);

  if (intent === 'fork') {
    const forked = await SessionService.forkSession(session.sessionId, {
      ...(newSessionId ? { newSessionId } : {}),
      sourceProjectPath: resolvedWorkspace,
      targetProjectPath: resolvedWorkspace,
    });
    const modelContext = await SessionService.loadSessionModelContext(
      forked.sessionId,
      forked.metadata.projectPath
    );
    const visibleMessages = [...SessionService.toUISafeMessages(forked.messages)];
    if (announceFork !== false) {
      const announcementTimestamp = Date.parse(forked.metadata.lastMessageTime);
      visibleMessages.push({
        id: 'fork-announcement-' + forked.sessionId,
        role: 'assistant',
        content:
          'Forked ' +
          shortSessionId(session.sessionId) +
          ' → ' +
          shortSessionId(forked.sessionId),
        timestamp: Number.isNaN(announcementTimestamp) ? 0 : announcementTimestamp,
      });
    }
    await cleanupAgent();
    activatePermissionModeInMemory(
      permissionModeOverride ?? forked.metadata.permissionMode
    );
    activateModelInMemory(forked.metadata.selectedModelId);
    actions.restoreSession(
      forked.sessionId,
      visibleMessages,
      modelContext,
      forked.metadata.projectPath
    );
    return {
      sessionId: forked.sessionId,
      messages: modelContext,
    };
  }

  await SessionService.assertSessionWritable(session.sessionId, session.projectPath);
  const [messages, modelContext] = await Promise.all([
    SessionService.loadSession(session.sessionId, session.projectPath),
    SessionService.loadSessionModelContext(session.sessionId, session.projectPath),
  ]);
  const uiMessages = SessionService.toUISafeMessages(messages);
  await cleanupAgent();
  activatePermissionModeInMemory(permissionModeOverride ?? session.permissionMode);
  activateModelInMemory(session.selectedModelId);
  actions.restoreSession(
    session.sessionId,
    uiMessages,
    modelContext,
    session.projectPath
  );
  return {
    sessionId: session.sessionId,
    messages: modelContext,
  };
}
