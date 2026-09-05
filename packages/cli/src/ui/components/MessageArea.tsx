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
  useSessionActions,
  useShowTaskPanel,
  useTaskList,
  useThinkingExpanded,
} from '../../store/selectors/index.js';
import { useTerminalDimensions } from '../hooks/useTerminalDimensions.js';
import {
  getMarkdownBlocksSnapshot,
  getMarkdownTailSnapshot,
} from '../utils/markdownIncremental.js';
import type { ParsedBlock } from '../utils/markdownParser.js';
import {
  activateRawRenderer,
  clearRawRenderer,
  isRawRendererActive,
  renderTail,
  updateRawRendererSize,
} from '../utils/rawStreamRenderer.js';
import { CollapsedHistorySummary } from './CollapsedHistorySummary.js';
import { Header } from './Header.js';
import { MessageRenderer } from './MessageRenderer.js';
import { TaskPanel } from './TaskPanel.js';
import { ThinkingBlock } from './ThinkingBlock.js';

/**
 * 消息区域组件
 *
 * 渲染策略：
 * - 使用 Ink 的 Static 组件渲染已完成的消息（不会重新渲染）
 * - 流式消息在 Static 外部单独渲染
 * - 流式消息完成后自动移入 messages，触发 Static 更新
 */
interface MessageAreaProps {
  active?: boolean;
}

const MessageAreaComponent: React.FC<MessageAreaProps> = ({ active = true }) => {
  const messages = useMessages();
  const currentStreamingMessageId = useCurrentStreamingMessageId();
  const currentStreamingBuffer = useCurrentStreamingBuffer();
  const finalizingStreamingMessageId = useFinalizingStreamingMessageId();
  const isProcessing = useIsProcessing();
  const tasks = useTaskList();
  const showTaskPanel = useShowTaskPanel();
  const currentThinkingContent = useCurrentThinkingContent();
  const thinkingExpanded = useThinkingExpanded();
  const clearCount = useClearCount();
  const expandedMessageCount = useExpandedMessageCount();
  const historyExpanded = useHistoryExpanded();

  const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
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
      prevHistoryExpandedRef.current = historyExpanded;
      if (!active) return;
      if (isRawRendererActive()) {
        clearRawRenderer();
      }
      if (stdout) {
        stdout.write(ansiEscapes.clearTerminal);
      }
      sessionActions.incrementClearCount();
    }
  }, [active, historyExpanded, stdout, sessionActions]);

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
    // 先清除 raw renderer（在 eraseScreen 之前，避免残留）
    if (isRawRendererActive()) {
      clearRawRenderer();
    }
    // 同步执行清理，不再延迟 50ms（消除闪屏的关键）。
    // eraseScreen 不移动光标；流式 tail 清理后光标通常停在 raw 区域起点。
    // 重挂 Static 前必须显式回到左上角，否则最终消息会从旧光标位置开始渲染，
    // 终端顶部就会留下大段空白。
    if (active && stdout) {
      stdout.write(ansiEscapes.eraseScreen + ansiEscapes.cursorTo(0, 0));
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
  }, [
    finalizingStreamingMessageId,
    isProcessing,
    stdout,
    sessionActions,
    historyMessages,
    active,
  ]);

  const activeStreamingMessageId =
    currentStreamingMessageId ?? finalizingStreamingMessageId;

  useEffect(() => {
    // clearCount 变化时（resize/clear 等），清理 raw renderer
    if (active && isRawRendererActive()) {
      clearRawRenderer();
    }
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
  }, [activeStreamingMessageId, clearCount]);

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

    // 新 blocks 添加到 Static 前，清除 raw tail（Static 输出会改变光标位置）
    if (isRawRendererActive()) {
      clearRawRenderer();
    }

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
          renderCodeBlocksAsPlainText={false}
        />
      </Box>,
    ]);
  }, [
    activeStreamingMessageId,
    currentStreamingBuffer.version,
    terminalWidth,
    clearCount,
    active,
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
    // tool 消息添加到 Static 前，清除 raw tail
    if (active && isRawRendererActive()) {
      clearRawRenderer();
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
  }, [active, activeStreamingMessageId, historyMessages, terminalWidth]);

  // Raw tail 渲染：绕过 React/Ink，直接用 stdout.write 输出流式 tail
  // 这是性能优化的核心 — 最高频更新的 tail 不再触发 React reconciliation
  useEffect(() => {
    if (!active) {
      if (isRawRendererActive()) {
        clearRawRenderer();
      }
      return;
    }
    if (!activeStreamingMessageId) {
      if (isRawRendererActive()) {
        clearRawRenderer();
      }
      return;
    }

    // 激活 raw renderer（如果尚未激活）
    if (!isRawRendererActive()) {
      activateRawRenderer(terminalWidth, terminalHeight);
    } else {
      updateRawRendererSize(terminalWidth, terminalHeight);
    }

    const tailSnapshot = getMarkdownTailSnapshot(activeStreamingMessageId);
    if (!tailSnapshot || tailSnapshot.lines.length === 0) {
      return;
    }

    const RESERVED_LINES = 8;
    const maxDisplayLines = Math.max(1, terminalHeight - RESERVED_LINES);
    const hiddenLines = Math.max(0, tailSnapshot.lines.length - maxDisplayLines);
    const visibleLines = tailSnapshot.lines.slice(-maxDisplayLines);
    const hasBlocks =
      (getMarkdownBlocksSnapshot(activeStreamingMessageId)?.length ?? 0) > 0;

    renderTail(visibleLines, hiddenLines, tailSnapshot.mode, hasBlocks);
  }, [
    activeStreamingMessageId,
    currentStreamingBuffer.version,
    terminalHeight,
    terminalWidth,
    active,
  ]);

  // 在 finalization 清理时也清除 raw renderer
  useEffect(() => {
    if (!activeStreamingMessageId && isRawRendererActive()) {
      clearRawRenderer();
    }
  }, [activeStreamingMessageId]);

  useEffect(() => {
    if (collapsePointState === null && historyMessages.length > expandedMessageCount) {
      setCollapsePointState(historyMessages.length);
      if (active && isRawRendererActive()) {
        clearRawRenderer();
      }
      if (active && stdout) {
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
    active,
  ]);

  const hasActiveTasks = useMemo(() => {
    return tasks.some(
      (task) => task.status === 'pending' || task.status === 'in_progress'
    );
  }, [tasks]);

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
      if (msg.role === 'assistant' && streamedAssistantMessageIds.has(msg.id)) {
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

  const allStaticItems = useMemo(
    () =>
      streamingStaticItems.length > 0
        ? [...staticItems, ...streamingStaticItems]
        : staticItems,
    [staticItems, streamingStaticItems]
  );

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box flexDirection="column">
        <Static key={clearCount} items={allStaticItems}>
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

        {/* tail viewport 已由 rawStreamRenderer 直接通过 stdout.write 渲染，
            不再通过 React/Ink 渲染，避免高频 re-render */}

        {showTaskPanel && hasActiveTasks && (
          <Box marginTop={1}>
            <TaskPanel tasks={tasks} visible={true} compact={false} />
          </Box>
        )}
      </Box>
    </Box>
  );
};

export const MessageArea = React.memo(MessageAreaComponent);
