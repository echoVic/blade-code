import { Box, type Key, Text } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useCurrentFocus,
  useCurrentStreamingBuffer,
  useCurrentStreamingMessageId,
  useMessages,
  usePendingCommands,
  useTheme,
} from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { useTerminalDimensions } from '../hooks/useTerminalDimensions.js';
import { useTerminalInput } from '../input/TerminalInputRouter.js';
import {
  changedTranscriptBlockIds,
  layoutTranscriptBlock,
  projectTranscriptBlocks,
  type TranscriptLine,
} from '../transcript/TranscriptProjection.js';

interface TranscriptPagerProps {
  isOpen: boolean;
  onClose: () => void;
  compact?: boolean;
}

type NavigationKey = Key & { home?: boolean; end?: boolean };

export const TranscriptPager: React.FC<TranscriptPagerProps> = React.memo(
  ({ isOpen, onClose, compact = false }) => {
    const messages = useMessages();
    const currentStreamingMessageId = useCurrentStreamingMessageId();
    const streamingBuffer = useCurrentStreamingBuffer();
    const pendingCommands = usePendingCommands();
    const currentFocus = useCurrentFocus();
    const theme = useTheme();
    const { width, height } = useTerminalDimensions();
    const pagerHeight = compact ? Math.max(6, Math.floor(height * 0.4)) : height;
    const viewportHeight = Math.max(1, pagerHeight - 3);
    const contentWidth = Math.max(12, width - 4);
    const lineCacheRef = useRef(
      new Map<string, { revision: string; width: number; lines: TranscriptLine[] }>()
    );

    const blocks = useMemo(
      () =>
        projectTranscriptBlocks({
          messages,
          currentStreamingMessageId,
          streamingLines: streamingBuffer.lines,
          streamingTail: streamingBuffer.tail,
          pendingCommands,
        }),
      [
        messages,
        currentStreamingMessageId,
        streamingBuffer.lines,
        streamingBuffer.tail,
        pendingCommands,
      ]
    );
    const lines = useMemo(() => {
      const activeIds = new Set(blocks.map((block) => block.id));
      for (const cachedId of lineCacheRef.current.keys()) {
        if (!activeIds.has(cachedId)) lineCacheRef.current.delete(cachedId);
      }
      return blocks.flatMap((block, index) => {
        const cached = lineCacheRef.current.get(block.id);
        const blockLines =
          cached?.revision === block.revision && cached.width === contentWidth
            ? cached.lines
            : layoutTranscriptBlock(block, contentWidth);
        if (blockLines !== cached?.lines) {
          lineCacheRef.current.set(block.id, {
            revision: block.revision,
            width: contentWidth,
            lines: blockLines,
          });
        }
        if (index === blocks.length - 1) return blockLines;
        return [
          ...blockLines,
          {
            key: `${block.id}:separator`,
            blockId: block.id,
            role: block.role,
            text: '',
            pending: block.pending === true,
          },
        ];
      });
    }, [blocks, contentWidth]);

    const [offsetFromBottom, setOffsetFromBottom] = useState(0);
    const [unreadBlockIds, setUnreadBlockIds] = useState<Set<string>>(new Set());
    const offsetRef = useRef(0);
    const previousBlocksRef = useRef(blocks);
    const previousLineCountRef = useRef(lines.length);
    offsetRef.current = offsetFromBottom;

    const maxOffset = Math.max(0, lines.length - viewportHeight);
    const scrollTo = (nextOffset: number) => {
      const bounded = Math.max(0, Math.min(maxOffset, nextOffset));
      offsetRef.current = bounded;
      setOffsetFromBottom(bounded);
      if (bounded === 0) {
        setUnreadBlockIds(new Set());
      }
    };

    useEffect(() => {
      if (!isOpen) {
        previousBlocksRef.current = blocks;
        previousLineCountRef.current = lines.length;
        return;
      }
      offsetRef.current = 0;
      setOffsetFromBottom(0);
      setUnreadBlockIds(new Set());
      previousBlocksRef.current = blocks;
      previousLineCountRef.current = lines.length;
    }, [isOpen]);

    useEffect(() => {
      const previousLineCount = previousLineCountRef.current;
      previousLineCountRef.current = lines.length;
      if (!isOpen) return;

      if (offsetRef.current === 0) {
        setUnreadBlockIds(new Set());
        return;
      }

      const addedLines = Math.max(0, lines.length - previousLineCount);
      if (addedLines > 0) {
        setOffsetFromBottom((current) => {
          const next = Math.min(maxOffset, current + addedLines);
          offsetRef.current = next;
          return next;
        });
      } else if (offsetRef.current > maxOffset) {
        offsetRef.current = maxOffset;
        setOffsetFromBottom(maxOffset);
      }
    }, [isOpen, lines.length, maxOffset]);

    useEffect(() => {
      const previousBlocks = previousBlocksRef.current;
      previousBlocksRef.current = blocks;
      if (!isOpen || offsetRef.current === 0) return;
      const changedIds = changedTranscriptBlockIds(previousBlocks, blocks);
      if (changedIds.length === 0) return;
      setUnreadBlockIds((current) => {
        const next = new Set(current);
        for (const id of changedIds) next.add(id);
        return next;
      });
    }, [blocks, isOpen]);

    useTerminalInput(
      (input, rawKey) => {
        if (!isOpen) return;
        const key = rawKey as NavigationKey;
        const ownsFocus = currentFocus === FocusId.TRANSCRIPT_PAGER;
        if ((key.ctrl || key.meta) && input.toLowerCase() === 'o') {
          onClose();
          return true;
        }
        if (!ownsFocus) {
          if (key.pageUp) {
            scrollTo(offsetRef.current + Math.max(1, viewportHeight - 1));
            return true;
          }
          if (key.pageDown) {
            scrollTo(offsetRef.current - Math.max(1, viewportHeight - 1));
            return true;
          }
          return false;
        }
        if (key.escape || input === 'q') {
          onClose();
          return true;
        }
        if (key.upArrow || input === 'k') {
          scrollTo(offsetRef.current + 1);
          return true;
        }
        if (key.downArrow || input === 'j') {
          scrollTo(offsetRef.current - 1);
          return true;
        }
        if (key.pageUp) {
          scrollTo(offsetRef.current + Math.max(1, viewportHeight - 1));
          return true;
        }
        if (key.pageDown) {
          scrollTo(offsetRef.current - Math.max(1, viewportHeight - 1));
          return true;
        }
        if (key.home || input === 'g') {
          scrollTo(maxOffset);
          return true;
        }
        if (key.end || input === 'G') {
          scrollTo(0);
          return true;
        }
        return true;
      },
      {
        isActive: isOpen,
        priority: 100,
      }
    );

    const end = Math.max(0, lines.length - offsetFromBottom);
    const start = Math.max(0, end - viewportHeight);
    const visibleLines = lines.slice(start, end);
    const unreadCount = unreadBlockIds.size;
    const position =
      lines.length === 0 ? '0/0' : `${Math.min(end, lines.length)}/${lines.length}`;

    return (
      <Box flexDirection="column" width="100%" height={pagerHeight} paddingX={2}>
        <Box justifyContent="space-between" flexShrink={0}>
          <Text bold color={theme.colors.primary}>
            Transcript
          </Text>
          <Text color={theme.colors.text.muted}>{position}</Text>
        </Box>
        <Box
          flexDirection="column"
          height={viewportHeight}
          flexShrink={0}
          overflow="hidden"
        >
          {visibleLines.length === 0 ? (
            <Text color={theme.colors.text.muted}>No transcript yet</Text>
          ) : (
            visibleLines.map((line) => (
              <Text
                key={line.key}
                wrap="truncate-end"
                color={
                  line.pending
                    ? theme.colors.warning
                    : line.role === 'user'
                      ? theme.colors.info
                      : line.role === 'assistant'
                        ? theme.colors.success
                        : theme.colors.text.secondary
                }
              >
                {line.text || ' '}
              </Text>
            ))
          )}
        </Box>
        <Box justifyContent="space-between" flexShrink={0}>
          <Text color={theme.colors.text.muted}>↑/↓ · j/k · PgUp/PgDn · g/G</Text>
          <Text
            color={unreadCount > 0 ? theme.colors.warning : theme.colors.text.muted}
          >
            {unreadCount > 0
              ? `${unreadCount} new · G latest`
              : 'Ctrl+O / Esc / q close'}
          </Text>
        </Box>
      </Box>
    );
  }
);
