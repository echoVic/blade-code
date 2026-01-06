import ansiEscapes from 'ansi-escapes';
import { Box, Static, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useClearCount,
  useCurrentStreamingContent,
  useCurrentStreamingMessageId,
  useCurrentThinkingContent,
  useExpandedMessageCount,
  useHistoryExpanded,
  useIsProcessing,
  useMessages,
  usePendingCommands,
  useSessionActions,
  useShowTodoPanel,
  useThinkingExpanded,
  useTodos,
} from '../../store/selectors/index.js';
import { useTerminalHeight } from '../hooks/useTerminalHeight.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
import { CollapsedHistorySummary } from './CollapsedHistorySummary.js';
import { Header } from './Header.js';
import { MessageRenderer } from './MessageRenderer.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { TodoPanel } from './TodoPanel.js';

/**
 * 消息区域组件
 *
 * 渲染策略：
 * - 使用 Ink 的 Static 组件渲染已完成的消息（不会重新渲染）
 * - 流式消息在 Static 外部单独渲染
 * - 流式消息完成后自动移入 messages，触发 Static 更新
 */
export const MessageArea: React.FC = React.memo(() => {
  const messages = useMessages();
  const currentStreamingMessageId = useCurrentStreamingMessageId();
  const currentStreamingContent = useCurrentStreamingContent();
  const isProcessing = useIsProcessing();
  const todos = useTodos();
  const showTodoPanel = useShowTodoPanel();
  const pendingCommands = usePendingCommands();
  const currentThinkingContent = useCurrentThinkingContent();
  const thinkingExpanded = useThinkingExpanded();
  const clearCount = useClearCount();
  const expandedMessageCount = useExpandedMessageCount();
  const historyExpanded = useHistoryExpanded();

  const terminalWidth = useTerminalWidth();
  const terminalHeight = useTerminalHeight();
  const { stdout } = useStdout();
  const sessionActions = useSessionActions();

  const [collapsePointState, setCollapsePointState] = useState<number | null>(null);

  const prevHistoryExpandedRef = useRef(historyExpanded);

  useEffect(() => {
    if (prevHistoryExpandedRef.current !== historyExpanded) {
      if (stdout) {
        stdout.write(ansiEscapes.clearTerminal);
      }
      sessionActions.incrementClearCount();
      prevHistoryExpandedRef.current = historyExpanded;
    }
  }, [historyExpanded, stdout, sessionActions]);

  const historyMessages = messages;

  const streamingMessage = useMemo(() => {
    if (!currentStreamingMessageId || !currentStreamingContent) {
      return null;
    }
    return {
      id: currentStreamingMessageId,
      role: 'assistant' as const,
      content: currentStreamingContent,
    };
  }, [currentStreamingMessageId, currentStreamingContent]);

  useEffect(() => {
    if (collapsePointState === null && historyMessages.length > expandedMessageCount) {
      setCollapsePointState(historyMessages.length);
      if (stdout) {
        stdout.write(ansiEscapes.clearTerminal);
      }
      sessionActions.incrementClearCount();
    }
  }, [
    historyMessages.length,
    expandedMessageCount,
    collapsePointState,
    stdout,
    sessionActions,
  ]);

  const hasActiveTodos = useMemo(() => {
    return todos.some(
      (todo) => todo.status === 'pending' || todo.status === 'in_progress'
    );
  }, [todos]);

  const collapsePoint = historyExpanded ? 0 : (collapsePointState ?? 0);
  const collapsedCount = collapsePoint;

  const staticItems = useMemo(() => {
    const items: React.ReactElement[] = [];

    items.push(<Header key="header" />);

    if (collapsedCount > 0) {
      items.push(
        <CollapsedHistorySummary
          key="collapsed-summary"
          collapsedCount={collapsedCount}
        />
      );
    }

    for (let i = collapsePoint; i < historyMessages.length; i++) {
      const msg = historyMessages[i];
      items.push(
        <Box key={msg.id} flexDirection="column">
          <MessageRenderer
            content={msg.content}
            role={msg.role}
            terminalWidth={terminalWidth}
            metadata={msg.metadata as Record<string, unknown>}
            isPending={false}
          />
        </Box>
      );
    }

    return items;
  }, [historyMessages, collapsePoint, collapsedCount, terminalWidth]);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      <Box flexDirection="column" flexGrow={1}>
        <Static key={clearCount} items={staticItems}>
          {(item) => item}
        </Static>

        {currentThinkingContent && (
          <Box marginBottom={1}>
            <ThinkingBlock
              content={currentThinkingContent}
              isStreaming={isProcessing}
              isExpanded={thinkingExpanded}
            />
          </Box>
        )}

        {streamingMessage && (
          <Box flexDirection="column">
            <MessageRenderer
              content={streamingMessage.content}
              role={streamingMessage.role}
              terminalWidth={terminalWidth}
              isPending={true}
              availableTerminalHeight={terminalHeight}
            />
          </Box>
        )}

        {showTodoPanel && hasActiveTodos && (
          <Box marginTop={1}>
            <TodoPanel todos={todos} visible={true} compact={false} />
          </Box>
        )}

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
