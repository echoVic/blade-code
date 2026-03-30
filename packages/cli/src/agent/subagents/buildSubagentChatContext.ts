import type { Message } from '../../services/ChatServiceInterface.js';
import type { ChatContext } from '../types.js';

export function buildSubagentChatContext({
  messages = [],
  sessionId,
  workspaceRoot = process.cwd(),
  permissionMode,
  systemPrompt,
  parentSessionId,
  subagentType,
}: {
  messages?: Message[];
  sessionId: string;
  workspaceRoot?: string;
  permissionMode?: ChatContext['permissionMode'];
  systemPrompt?: string;
  parentSessionId?: string;
  subagentType: string;
}): ChatContext {
  return {
    messages,
    userId: 'subagent',
    sessionId,
    workspaceRoot,
    permissionMode,
    systemPrompt,
    subagentInfo: {
      parentSessionId: parentSessionId || '',
      subagentType,
      isSidechain: false,
    },
  };
}
