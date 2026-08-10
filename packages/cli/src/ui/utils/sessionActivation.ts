import path from 'node:path';
import type { PermissionMode } from '../../config/types.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { SessionMetadata } from '../../services/SessionService.js';
import { SessionService } from '../../services/SessionService.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';
import type { SessionMessage } from '../../store/types.js';
import { getModelById, getState } from '../../store/vanilla.js';

export interface SessionActivationActions {
  restoreSession: (
    sessionId: string,
    messages: SessionMessage[],
    rawMessages: Message[],
    workspaceRoot?: string
  ) => void;
}

export type CleanupAgent = () => Promise<void>;

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
  _intent: SessionSelectionIntent,
  _workspaceRoot: string
): Promise<SessionMetadata[]> {
  return SessionService.listSessions({
    includeSubagents: false,
  });
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
      forked.messages,
      forked.metadata.projectPath
    );
    return {
      sessionId: forked.sessionId,
      messages: forked.messages,
    };
  }

  await SessionService.assertSessionWritable(session.sessionId, session.projectPath);
  const messages = await SessionService.loadSession(
    session.sessionId,
    session.projectPath
  );
  const uiMessages = SessionService.toUISafeMessages(messages);
  await cleanupAgent();
  activatePermissionModeInMemory(permissionModeOverride ?? session.permissionMode);
  activateModelInMemory(session.selectedModelId);
  actions.restoreSession(session.sessionId, uiMessages, messages, session.projectPath);
  return {
    sessionId: session.sessionId,
    messages,
  };
}
