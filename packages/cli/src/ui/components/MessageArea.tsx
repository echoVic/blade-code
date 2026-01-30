import ansiEscapes from 'ansi-escapes';
import { Box, Static, useStdout } from 'ink';
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
import { useTerminalHeight } from '../hooks/useTerminalHeight.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
import { getMarkdownBlocksSnapshot, getMarkdownTailSnapshot } from '../utils/markdownIncremental.js';
import type { ParsedBlock } from '../utils/markdownParser.js';
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
  const [streamingStaticItems, setStreamingStaticItems] = useState<
    React.ReactElement[]
  >([]);
  const [streamedAssistantMessageIds, setStreamedAssistantMessageIds] = useState<
    Set<string>
  >(new Set());

  const prevHistoryExpandedRef = useRef(historyExpanded);
  const streamingMessageIdRef = useRef<string | null>(null);
  const streamingBlockCountRef = useRef(0);
  const streamingChunkIndexRef = useRef(0);
  const streamingToolMessageIdsRef = useRef<Set<string>>(new Set());
  const streamingToolBaselineIdsRef = useRef<Set<string>>(new Set());
  const streamingPendingEmptyBlocksRef = useRef<ParsedBlock[]>([]);
  const finalizingCleanupRef = useRef<string | null>(null);

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

  const skipFinalizingMessageId = finalizingStreamingMessageId;

  useEffect(() => {
    if (!finalizingStreamingMessageId || isProcessing) {
      finalizingCleanupRef.current = null;
      return;
    }
    if (finalizingCleanupRef.current === finalizingStreamingMessageId) {
      return;
    }
    finalizingCleanupRef.current = finalizingStreamingMessageId;
    const timer = setTimeout(() => {
      if (stdout) {
        stdout.write(ansiEscapes.clearTerminal);
      }
      streamingToolMessageIdsRef.current = new Set();
      streamingToolBaselineIdsRef.current = new Set(
        historyMessages.filter((msg) => msg.role === 'tool').map((msg) => msg.id)
      );
      streamingMessageIdRef.current = null;
      streamingBlockCountRef.current = 0;
      streamingChunkIndexRef.current = 0;
      streamingPendingEmptyBlocksRef.current = [];
      setStreamingStaticItems([]);
      setStreamedAssistantMessageIds(new Set());
      sessionActions.incrementClearCount();
      sessionActions.clearFinalizingStreamingMessageId();
    }, 50);
    return () => clearTimeout(timer);
  }, [
    finalizingStreamingMessageId,
    isProcessing,
    stdout,
    sessionActions,
    historyMessages,
  ]);

  const activeStreamingMessageId =
    currentStreamingMessageId ?? finalizingStreamingMessageId;

  useEffect(() => {
    streamingMessageIdRef.current = null;
    streamingBlockCountRef.current = 0;
    streamingChunkIndexRef.current = 0;
    streamingToolMessageIdsRef.current = new Set();
    streamingToolBaselineIdsRef.current = new Set(
      historyMessages.filter((msg) => msg.role === 'tool').map((msg) => msg.id)
    );
    streamingPendingEmptyBlocksRef.current = [];
    setStreamingStaticItems([]);
    setStreamedAssistantMessageIds(new Set());
  }, [clearCount]);

  useEffect(() => {
    if (!activeStreamingMessageId) {
      return;
    }
    if (streamingMessageIdRef.current === activeStreamingMessageId) {
      return;
    }
    streamingMessageIdRef.current = activeStreamingMessageId;
    streamingBlockCountRef.current = 0;
    streamingChunkIndexRef.current = 0;
    streamingToolBaselineIdsRef.current = new Set(
      historyMessages.filter((msg) => msg.role === 'tool').map((msg) => msg.id)
    );
    streamingPendingEmptyBlocksRef.current = [];
    setStreamingStaticItems([]);
  }, [activeStreamingMessageId, historyMessages]);

  useEffect(() => {
    if (!activeStreamingMessageId) {
      return;
    }
    const blocksSnapshot = getMarkdownBlocksSnapshot(activeStreamingMessageId);
    if (!blocksSnapshot || blocksSnapshot.length <= streamingBlockCountRef.current) {
      return;
    }

    const newBlocks = blocksSnapshot.slice(streamingBlockCountRef.current);
    streamingBlockCountRef.current = blocksSnapshot.length;

    let blocksToRender = newBlocks;
    const pendingEmpty = streamingPendingEmptyBlocksRef.current;
    if (pendingEmpty.length > 0) {
      if (blocksToRender.some((block) => block.type !== 'empty')) {
        blocksToRender = [...pendingEmpty, ...blocksToRender];
        streamingPendingEmptyBlocksRef.current = [];
      } else {
        streamingPendingEmptyBlocksRef.current = [...pendingEmpty, ...blocksToRender];
        return;
      }
    }

    let trimmedEnd = blocksToRender.length;
    while (trimmedEnd > 0 && blocksToRender[trimmedEnd - 1].type === 'empty') {
      trimmedEnd -= 1;
    }
    if (trimmedEnd !== blocksToRender.length) {
      streamingPendingEmptyBlocksRef.current = blocksToRender.slice(trimmedEnd);
      blocksToRender = blocksToRender.slice(0, trimmedEnd);
    }
    if (blocksToRender.length === 0) {
      return;
    }

    const chunkIndex = streamingChunkIndexRef.current;
    streamingChunkIndexRef.current += 1;
    const hidePrefix = chunkIndex > 0;

    setStreamedAssistantMessageIds((prev) => {
      if (!activeStreamingMessageId || prev.has(activeStreamingMessageId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(activeStreamingMessageId);
      return next;
    });

    setStreamingStaticItems((prev) => [
      ...prev,
      <Box
        key={`streaming-${activeStreamingMessageId}-${chunkIndex}`}
        flexDirection="column"
      >
        <MessageRenderer
          content=""
          role="assistant"
          terminalWidth={terminalWidth}
          isPending={false}
          hidePrefix={hidePrefix}
          noMargin={true}
          blocksOverride={blocksToRender}
          renderCodeBlocksAsPlainText={true}
        />
      </Box>,
    ]);
  }, [
    activeStreamingMessageId,
    currentStreamingBuffer.version,
    terminalWidth,
    clearCount,
  ]);

  useEffect(() => {
    if (!activeStreamingMessageId) {
      return;
    }
    const baseline = streamingToolBaselineIdsRef.current;
    const newToolMessages = historyMessages.filter(
      (msg) =>
        msg.role === 'tool' &&
        !baseline.has(msg.id) &&
        !streamingToolMessageIdsRef.current.has(msg.id)
    );
    if (newToolMessages.length === 0) {
      return;
    }
    for (const msg of newToolMessages) {
      streamingToolMessageIdsRef.current.add(msg.id);
    }
    setStreamingStaticItems((prev) => [
      ...prev,
      ...newToolMessages.map((msg) => (
        <Box key={`streaming-tool-${msg.id}`} flexDirection="column">
          <MessageRenderer
            content={msg.content}
            role={msg.role}
            terminalWidth={terminalWidth}
            metadata={msg.metadata as Record<string, unknown>}
            isPending={false}
            messageId={msg.id}
          />
        </Box>
      )),
    ]);
  }, [activeStreamingMessageId, historyMessages, terminalWidth]);

  const streamingTailViewport = useMemo(() => {
    if (!activeStreamingMessageId) {
      return null;
    }
    const tailSnapshot = getMarkdownTailSnapshot(activeStreamingMessageId);
    if (!tailSnapshot || tailSnapshot.lines.length === 0) {
      return null;
    }

    const RESERVED_LINES = 8;
    const maxDisplayLines = Math.max(1, terminalHeight - RESERVED_LINES);
    const hiddenLines = Math.max(0, tailSnapshot.lines.length - maxDisplayLines);
    const visibleLines = tailSnapshot.lines.slice(-maxDisplayLines);
    return { visibleLines, hiddenLines, mode: tailSnapshot.mode };
  }, [activeStreamingMessageId, currentStreamingBuffer.version, terminalHeight]);

  const streamingHasBlocks = useMemo(() => {
    if (!activeStreamingMessageId) {
      return false;
    }
    const blocksSnapshot = getMarkdownBlocksSnapshot(activeStreamingMessageId);
    return (blocksSnapshot?.length ?? 0) > 0;
  }, [activeStreamingMessageId, currentStreamingBuffer.version]);

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
      if (skipFinalizingMessageId && msg.id === skipFinalizingMessageId) {
        continue;
      }
      if (msg.role === 'tool' && streamingToolMessageIdsRef.current.has(msg.id)) {
        continue;
      }
      if (
        msg.role === 'assistant' &&
        streamedAssistantMessageIds.has(msg.id)
      ) {
        continue;
      }
      items.push(
        <Box key={msg.id} flexDirection="column">
          <MessageRenderer
            content={msg.content}
            role={msg.role}
            terminalWidth={terminalWidth}
            metadata={msg.metadata as Record<string, unknown>}
            isPending={false}
            messageId={msg.id}
          />
        </Box>
      );
    }

    return items;
  }, [
    historyMessages,
    collapsePoint,
    collapsedCount,
    terminalWidth,
    skipFinalizingMessageId,
    streamedAssistantMessageIds,
  ]);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box flexDirection="column">
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

        {streamingStaticItems.length > 0 && (
          <Static
            key={`streaming-${clearCount}`}
            items={streamingStaticItems}
          >
            {(item) => item}
          </Static>
        )}

        {streamingTailViewport && (
          <Box flexDirection="column">
            <MessageRenderer
              content=""
              role="assistant"
              terminalWidth={terminalWidth}
              isPending={true}
              hidePrefix={streamingHasBlocks}
              streamingLines={streamingTailViewport.visibleLines}
              streamingHiddenLines={streamingTailViewport.hiddenLines}
              streamingMode={streamingTailViewport.mode}
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
