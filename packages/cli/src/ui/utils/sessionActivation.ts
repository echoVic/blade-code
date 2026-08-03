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
  addAssistantMessage: (message: string) => void;
}

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

export async function activateSessionSelection(
  selection: SessionSelectionInput,
  workspaceRoot: string,
  actions: SessionActivationActions
): Promise<{ sessionId: string; messages: Message[] }> {
  const { intent, session, newSessionId, announceFork } = selection;
  const resolvedWorkspace = resolveWorkspace(workspaceRoot);

  if (intent === 'fork') {
    const sourceWorkspace = resolveWorkspace(session.projectPath);
    if (sourceWorkspace !== resolvedWorkspace) {
      throw new Error('Interactive session forks are limited to the current workspace');
    }

    const forked = await SessionService.forkSession(session.sessionId, {
      ...(newSessionId ? { newSessionId } : {}),
      sourceProjectPath: resolvedWorkspace,
      targetProjectPath: resolvedWorkspace,
    });
    const uiMessages = SessionService.toUISafeMessages(forked.messages);
    actions.restoreSession(forked.sessionId, uiMessages, forked.messages);
    if (announceFork !== false) {
      actions.addAssistantMessage(
        `Forked ${shortSessionId(session.sessionId)} → ${shortSessionId(forked.sessionId)}`
      );
    }
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
  actions.restoreSession(session.sessionId, uiMessages, messages);
  return {
    sessionId: session.sessionId,
    messages,
  };
}
