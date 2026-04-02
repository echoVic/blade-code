import ansiEscapes from 'ansi-escapes';
import { Box, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useClearCount,
  useCurrentStreamingBuffer,
  useCurrentStreamingMessageId,
  useCurrentThinkingContent,
  useExpandedMessageCount,
  useFinalizingStreamingMessageId,
  useHistoryExpanded,
  useIsProcessing,
  useMessages,
  usePendingCommands,
  useSessionActions,
  useShowTodoPanel,
  useThinkingExpanded,
  useTodos,
} from '../../store/selectors/index.js';
import type { SessionMessage } from '../../store/types.js';
import { useTerminalHeight } from '../hooks/useTerminalHeight.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
import {
  clearRawRenderer,
  isRawRendererActive,
} from '../utils/rawStreamRenderer.js';
import { CollapsedHistorySummary } from './CollapsedHistorySummary.js';
import { Header } from './Header.js';
import MessageList from './MessageList.js';
import { MessageRenderer } from './MessageRenderer.js';
import StreamingTail from './StreamingTail.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { TodoPanel } from './TodoPanel.js';

export const MessageArea: React.FC = React.memo(() => {
  const messages = useMessages();
  const currentStreamingMessageId = useCurrentStreamingMessageId();
  const currentStreamingBuffer = useCurrentStreamingBuffer();
  const finalizingStreamingMessageId = useFinalizingStreamingMessageId();
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
  const finalizingCleanupRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevHistoryExpandedRef.current !== historyExpanded) {
      if (isRawRendererActive()) {
        clearRawRenderer();
      }
      if (stdout) {
        stdout.write(ansiEscapes.clearTerminal);
      }
      sessionActions.incrementClearCount();
      prevHistoryExpandedRef.current = historyExpanded;
    }
  }, [historyExpanded, stdout, sessionActions]);

  useEffect(() => {
    if (!finalizingStreamingMessageId || isProcessing) {
      finalizingCleanupRef.current = null;
      return;
    }
    if (finalizingCleanupRef.current === finalizingStreamingMessageId) {
      return;
    }
    finalizingCleanupRef.current = finalizingStreamingMessageId;
    if (isRawRendererActive()) {
      clearRawRenderer();
    }
    if (stdout) {
      stdout.write(ansiEscapes.eraseScreen);
    }
    sessionActions.incrementClearCount();
    sessionActions.clearFinalizingStreamingMessageId();
  }, [
    finalizingStreamingMessageId,
    isProcessing,
    stdout,
    sessionActions,
    messages,
  ]);

  useEffect(() => {
    if (isRawRendererActive()) {
      clearRawRenderer();
    }
  }, [clearCount]);

  useEffect(() => {
    if (collapsePointState === null && messages.length > expandedMessageCount) {
      setCollapsePointState(messages.length);
      if (isRawRendererActive()) {
        clearRawRenderer();
      }
      if (stdout) {
        stdout.write(ansiEscapes.clearTerminal);
      }
      sessionActions.incrementClearCount();
    }
  }, [
    messages.length,
    expandedMessageCount,
    collapsePointState,
    stdout,
    sessionActions,
  ]);

  const collapsePoint = historyExpanded ? 0 : (collapsePointState ?? 0);
  const collapsedCount = collapsePoint;

  const visibleMessages = useMemo(() => {
    return messages.slice(collapsePoint);
  }, [messages, collapsePoint]);

  const hasActiveTodos = useMemo(() => {
    return todos.some(
      (todo) => todo.status === 'pending' || todo.status === 'in_progress'
    );
  }, [todos]);

  const streamingMessage = useMemo((): SessionMessage | null => {
    if (!currentStreamingMessageId) return null;
    const lines = currentStreamingBuffer.lines ?? [];
    const tail = currentStreamingBuffer.tail ?? '';
    const content = lines.length > 0
      ? lines.join('\n') + (tail ? '\n' + tail : '')
      : tail;
    return {
      id: currentStreamingMessageId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
  }, [currentStreamingMessageId, currentStreamingBuffer.lines, currentStreamingBuffer.tail, currentStreamingBuffer.version]); // version triggers recompute when buffer updates in-place

  const messageAreaHeight = Math.max(1, terminalHeight - 6);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Header />

      {collapsedCount > 0 && (
        <CollapsedHistorySummary collapsedCount={collapsedCount} />
      )}

      <MessageList
        key={clearCount}
        messages={visibleMessages}
        width={terminalWidth}
        height={messageAreaHeight}
      />

      {currentThinkingContent && (
        <Box marginBottom={1}>
          <ThinkingBlock
            content={currentThinkingContent}
            isStreaming={isProcessing}
            isExpanded={thinkingExpanded}
          />
        </Box>
      )}

      <StreamingTail
        streamingMessage={streamingMessage}
        thinkingContent=""
        width={terminalWidth}
      />

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
  );
});
