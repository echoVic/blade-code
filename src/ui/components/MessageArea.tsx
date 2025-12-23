import { Box, Static } from 'ink';
import React, { ReactNode, useEffect, useMemo } from 'react';
import {
  useClearCount,
  useCurrentThinkingContent,
  useIsProcessing,
  useMessages,
  usePendingCommands,
  useShowTodoPanel,
  useThinkingExpanded,
  useTodos,
} from '../../store/selectors/index.js';
import type { SessionMessage } from '../../store/types.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
import { Header } from './Header.js';
import { MessageRenderer } from './MessageRenderer.js';
import { ThinkingBlock } from './ThinkingBlock.js';
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
  const isProcessing = useIsProcessing();
  const todos = useTodos();
  const showTodoPanel = useShowTodoPanel();
  const pendingCommands = usePendingCommands();
  const currentThinkingContent = useCurrentThinkingContent();
  const thinkingExpanded = useThinkingExpanded();
  const clearCount = useClearCount(); // 用于强制 Static 组件重新挂载

  // 使用 useTerminalWidth hook 获取终端宽度
  const terminalWidth = useTerminalWidth();

  // 追踪已渲染到 Static 的消息数量（防止重复渲染）
  const renderedCountRef = React.useRef(0);

  // 当 clearCount 变化时（/clear 命令），重置渲染计数
  useEffect(() => {
    renderedCountRef.current = 0;
  }, [clearCount]);

  // 分离已完成的消息和正在流式传输的消息
  const { completedMessages, streamingMessage } = useMemo(() => {
    // Static 组件的特性：items 只能追加，不能减少
    // 所以 completedMessages 只能增长，不能缩小
    const safeCompletedCount = Math.max(
      renderedCountRef.current,
      isProcessing && messages.length > 0 ? messages.length - 1 : messages.length
    );

    // 更新已渲染数量
    renderedCountRef.current = safeCompletedCount;

    const completed = messages.slice(0, safeCompletedCount);
    const streaming = safeCompletedCount < messages.length ? messages[safeCompletedCount] : null;

    return {
      completedMessages: completed,
      streamingMessage: streaming,
    };
  }, [messages, isProcessing]);

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
        {/* key={clearCount} 确保 /clear 时强制重新挂载，清除已冻结的内容 */}
        <Static key={clearCount} items={staticItems}>
          {(item) => item}
        </Static>

        {/* 流式接收的 Thinking 内容（在消息之前显示） */}
        {currentThinkingContent && (
          <Box marginBottom={1}>
            <ThinkingBlock
              content={currentThinkingContent}
              isStreaming={isProcessing}
              isExpanded={thinkingExpanded}
            />
          </Box>
        )}

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
              content={cmd.displayText}
              role="user"
              terminalWidth={terminalWidth}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
});
