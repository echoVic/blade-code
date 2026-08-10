import type { Message } from '../../services/ChatServiceInterface.js';
import {
  renderUserShellCommandForModel,
  userShellCommandRecordFromMetadata,
} from '../../services/UserShellCommandService.js';
import type { SessionMessage, SessionState } from '../../store/types.js';

function toContextMessage(message: SessionMessage): Message {
  const userShellCommand = userShellCommandRecordFromMetadata(message.metadata);
  return {
    role: message.role,
    content: userShellCommand
      ? renderUserShellCommandForModel(userShellCommand)
      : message.content,
    ...(message.metadata ? { metadata: message.metadata as never } : {}),
  };
}

/**
 * 构建发送给 Agent 的上下文消息。
 * - 普通会话：直接使用当前 UI 消息
 * - resume 会话：使用恢复时保存的原始消息（保留 summary / multimodal），
 *   再拼接恢复后新增的 UI 消息，避免丢上下文或重复历史
 */
export function buildContextMessagesFromSession(
  session: Pick<
    SessionState,
    'messages' | 'restoredContextMessages' | 'restoredVisibleMessageCount'
  >
): Message[] {
  if (!session.restoredContextMessages || session.restoredVisibleMessageCount <= 0) {
    return session.messages.map(toContextMessage);
  }

  const appendedMessages = session.messages
    .slice(session.restoredVisibleMessageCount)
    .map(toContextMessage);

  return [...session.restoredContextMessages, ...appendedMessages];
}
