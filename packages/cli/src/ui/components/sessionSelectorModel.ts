import type { SessionMetadata } from '../../services/SessionService.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';

export function getSessionCandidateKey(session: SessionMetadata): string {
  return `${session.projectPath}\0${session.sessionId}`;
}

export function getVisibleSessionCandidates(
  sessions: readonly SessionMetadata[],
  intent: SessionSelectionIntent
): SessionMetadata[] {
  if (intent !== 'fork') {
    return [...sessions];
  }
  return sessions.filter((session) => session.relationType !== 'subagent');
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
