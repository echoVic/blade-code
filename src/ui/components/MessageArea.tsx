import { Box } from 'ink';
import React from 'react';
import type { TodoItem } from '../../tools/builtin/todo/types.js';
import type { SessionState } from '../contexts/SessionContext.js';
import { MessageRenderer } from './MessageRenderer.js';
import { TodoPanel } from './TodoPanel.js';

interface MessageAreaProps {
  sessionState: SessionState;
  terminalWidth: number;
  todos?: TodoItem[];
  showTodoPanel?: boolean;
}

/**
 * 消息区域组件
 * 负责显示消息列表
 */
export const MessageArea: React.FC<MessageAreaProps> = React.memo(
  ({ sessionState, terminalWidth, todos = [], showTodoPanel = false }) => {
    // 找到最后一条用户消息的索引（TodoPanel 将显示在这之后）
    const lastUserMessageIndex = sessionState.messages.findLastIndex(
      (msg) => msg.role === 'user'
    );

    return (
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        <Box flexDirection="column" flexGrow={1}>
          {/* 渲染消息列表 */}
          {sessionState.messages.map((msg, index) => (
            <Box key={msg.id} flexDirection="column">
              <MessageRenderer
                content={msg.content}
                role={msg.role}
                terminalWidth={terminalWidth}
                metadata={msg.metadata as Record<string, unknown>}
              />
              {/* 在最后一条用户消息后显示 TodoPanel */}
              {index === lastUserMessageIndex && showTodoPanel && todos.length > 0 && (
                <TodoPanel todos={todos} visible={true} compact={false} />
              )}
            </Box>
          ))}
        </Box>
      </Box>
    );
  }
);
