import { Box, Static } from 'ink';
import React, { ReactNode, useEffect, useMemo } from 'react';
import {
  useClearCount,
  useCurrentThinkingContent,
  useExpandedMessageCount,
  useHistoryExpanded,
  useIsProcessing,
  useMessages,
  usePendingCommands,
  useShowTodoPanel,
  useThinkingExpanded,
  useTodos,
} from '../../store/selectors/index.js';
import type { SessionMessage } from '../../store/types.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
import { CollapsedHistorySummary } from './CollapsedHistorySummary.js';
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
  const expandedMessageCount = useExpandedMessageCount(); // 保持展开的最近消息数
  const historyExpanded = useHistoryExpanded(); // 是否展开所有历史消息

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
    const streaming =
      safeCompletedCount < messages.length ? messages[safeCompletedCount] : null;

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

  // 计算"最近消息"的起始索引（这些消息始终显示完整内容）
  // 当 historyExpanded=true 时，显示所有消息；否则只显示最近 N 条
  const recentMessageStartIndex = useMemo(() => {
    if (historyExpanded) {
      return 0; // 展开时显示所有消息
    }
    return Math.max(0, messages.length - expandedMessageCount);
  }, [messages.length, expandedMessageCount, historyExpanded]);

  // 渲染单个消息（用于 Static 和 dynamic 区域）
  const renderMessage = (msg: SessionMessage, isPending = false) => (
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

  // 计算折叠的消息数量
  const collapsedCount = useMemo(() => {
    return Math.min(recentMessageStartIndex, completedMessages.length);
  }, [recentMessageStartIndex, completedMessages.length]);

  // 构建 Static items：Header + 折叠汇总 + 已完成的消息
  const staticItems = useMemo(() => {
    const items: ReactNode[] = [];

    // 1. Header 始终在最顶部
    items.push(<Header key="header" />);

    // 2. 如果有折叠的消息，显示单行汇总
    if (collapsedCount > 0) {
      items.push(
        <CollapsedHistorySummary
          key="collapsed-summary"
          collapsedCount={collapsedCount}
        />
      );
    }

    // 3. 只渲染需要显示的消息（从 recentMessageStartIndex 开始）
    completedMessages.forEach((msg, index) => {
      if (index >= recentMessageStartIndex) {
        items.push(renderMessage(msg));
      }
    });

    return items;
  }, [completedMessages, terminalWidth, recentMessageStartIndex, collapsedCount]);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      <Box flexDirection="column" flexGrow={1}>
        {/* 静态区域：Header + 折叠汇总 + 最近消息 */}
        {/* key 包含 clearCount 和 historyExpanded，确保状态变化时强制重新挂载 */}
        <Static key={`${clearCount}-${historyExpanded}`} items={staticItems}>
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
        {streamingMessage && renderMessage(streamingMessage, true)}

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
