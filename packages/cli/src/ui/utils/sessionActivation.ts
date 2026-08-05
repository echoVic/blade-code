import path from 'node:path';
import { SessionService } from '../../services/SessionService.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { SessionMetadata } from '../../services/SessionService.js';
import type { SessionMessage } from '../../store/types.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';

export interface SessionActivationActions {
  restoreSession: (
    sessionId: string,
    messages: SessionMessage[],
    rawMessages: Message[]
  ) => void;
}

export type CleanupAgent = () => Promise<void>;

interface SessionSelectionInput {
  intent: SessionSelectionIntent;
  session: SessionMetadata;
  newSessionId?: string;
  announceFork?: boolean;
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

export async function listSessionCandidatesForIntent(
  _intent: SessionSelectionIntent,
  workspaceRoot: string
): Promise<SessionMetadata[]> {
  return SessionService.listSessions({
    cwd: resolveWorkspace(workspaceRoot),
    includeSubagents: false,
  });
}

export async function activateSessionSelection(
  selection: SessionSelectionInput,
  workspaceRoot: string,
  actions: SessionActivationActions,
  cleanupAgent: CleanupAgent
): Promise<{ sessionId: string; messages: Message[] }> {
  const { intent, session, newSessionId, announceFork } = selection;
  const resolvedWorkspace = resolveWorkspace(workspaceRoot);

  const sourceWorkspace = resolveWorkspace(session.projectPath);
  if (sourceWorkspace !== resolvedWorkspace) {
    throw new Error(
      'Interactive session activation is limited to the current workspace'
    );
  }

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
    actions.restoreSession(forked.sessionId, visibleMessages, forked.messages);
    return {
      sessionId: forked.sessionId,
      messages: forked.messages,
    };
  }

  const messages = await SessionService.loadSession(
    session.sessionId,
    session.projectPath
  );
  const uiMessages = SessionService.toUISafeMessages(messages);
  await cleanupAgent();
  actions.restoreSession(session.sessionId, uiMessages, messages);
  return {
    sessionId: session.sessionId,
    messages,
  };
}
