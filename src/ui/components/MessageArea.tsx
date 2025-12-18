import { Box, Static } from 'ink';
import React, { ReactNode, useMemo } from 'react';
import {
  useIsThinking,
  useMessages,
  usePendingCommands,
  useShowTodoPanel,
  useTodos,
} from '../../store/selectors/index.js';
import type { SessionMessage } from '../../store/types.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
import { Header } from './Header.js';
import { MessageRenderer } from './MessageRenderer.js';
import { TodoPanel } from './TodoPanel.js';

/**
 * 消息区域组件
 * 负责显示消息列表
 *
 * 性能优化：
 * - 使用 Ink 的 Static 组件将已完成的消息隔离，避免重新渲染
 * - 只有正在流式传输的消息会重新渲染
 * - 使用 useMemo 缓存计算结果
 *
 * 布局优化：
 * - Header 作为 Static 的第一个子项，确保永远在历史消息顶部
 * - TodoPanel 独立显示在动态区域底部，不随消息滚动被冻结
 * - 只在有活动 TODO（pending/in_progress）时显示 TodoPanel
 *
 * 状态管理：
 * - 使用 Zustand selectors 内部获取状态，消除 Props Drilling
 */
export const MessageArea: React.FC = React.memo(() => {
  // 使用 Zustand selectors 获取状态
  const messages = useMessages();
  const isThinking = useIsThinking();
  const todos = useTodos();
  const showTodoPanel = useShowTodoPanel();
  const pendingCommands = usePendingCommands();

  // 使用 useTerminalWidth hook 获取终端宽度
  const terminalWidth = useTerminalWidth();

  // 分离已完成的消息和正在流式传输的消息
  const { completedMessages, streamingMessage } = useMemo(() => {
    // 如果正在思考，最后一条消息视为流式传输中
    if (isThinking && messages.length > 0) {
      return {
        completedMessages: messages.slice(0, -1),
        streamingMessage: messages[messages.length - 1],
      };
    }

    // 否则所有消息都是已完成的
    return {
      completedMessages: messages,
      streamingMessage: null,
    };
  }, [messages, isThinking]);

  // 检测是否有活动的 TODO（进行中或待处理）
  const hasActiveTodos = useMemo(() => {
    return todos.some(
      (todo) => todo.status === 'pending' || todo.status === 'in_progress'
    );
  }, [todos]);

  // 渲染单个消息（用于 Static 和 dynamic 区域）
  const renderMessage = (msg: SessionMessage, _index: number, isPending = false) => (
    <Box key={msg.id} flexDirection="column">
      <MessageRenderer
        content={msg.content}
        role={msg.role}
        terminalWidth={terminalWidth}
        metadata={msg.metadata as Record<string, unknown>}
        isPending={isPending}
      />
    </Box>
  );

  // 构建 Static items：Header + 已完成的消息
  const staticItems = useMemo(() => {
    const items: ReactNode[] = [];

    // 1. Header 作为第一个子项
    items.push(<Header key="header" />);

    // 2. 已完成的消息
    completedMessages.forEach((msg, index) => {
      items.push(renderMessage(msg, index));
    });

    return items;
  }, [completedMessages, terminalWidth]);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      <Box flexDirection="column" flexGrow={1}>
        {/* 静态区域：Header + 已完成的消息永不重新渲染 */}
        <Static items={staticItems}>{(item) => item}</Static>

        {/* 动态区域：只有流式传输的消息会重新渲染 */}
        {streamingMessage &&
          renderMessage(streamingMessage, completedMessages.length, true)}

        {/* TodoPanel 独立显示（仅在有活动 TODO 时） */}
        {showTodoPanel && hasActiveTodos && (
          <Box marginTop={1}>
            <TodoPanel todos={todos} visible={true} compact={false} />
          </Box>
        )}

        {/* 待处理命令队列（显示在最底部，作为下一轮对话的开始） */}
        {pendingCommands.map((cmd, index) => (
          <Box key={`pending-${index}`} flexDirection="column">
            <MessageRenderer
              content={cmd}
              role="user"
              terminalWidth={terminalWidth}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
});
