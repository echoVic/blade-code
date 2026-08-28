import { Box, type Key, Text, useStdout } from 'ink';
import React, {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useCurrentFocus,
  useCurrentStreamingBuffer,
  useCurrentStreamingMessageId,
  useCurrentThinkingContent,
  useMessages,
  usePendingCommands,
  useTheme,
} from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { useTerminalDimensions } from '../hooks/useTerminalDimensions.js';
import { useTerminalInput } from '../input/TerminalInputRouter.js';
import {
  changedTranscriptBlockIds,
  copyTranscriptLineRange,
  findTranscriptMatchLineIndex,
  layoutTranscriptBlock,
  projectTranscriptBlocks,
  type TranscriptLine,
  type TranscriptMatch,
  TranscriptSearchIndex,
  transcriptLineHighlights,
} from '../transcript/TranscriptProjection.js';
import { copyTranscriptText } from '../utils/clipboard.js';

interface TranscriptPagerProps {
  isOpen: boolean;
  onClose: () => void;
  compact?: boolean;
}

type NavigationKey = Key & { home?: boolean; end?: boolean };

interface LineSelection {
  anchor: number;
  head: number;
}

interface SearchEditor {
  value: string;
  cursor: number;
}

interface PendingReveal {
  blockId: string;
  match?: TranscriptMatch;
}

function moveSearchCursor(editor: SearchEditor, delta: number): SearchEditor {
  const characters = Array.from(editor.value);
  return {
    ...editor,
    cursor: Math.max(0, Math.min(characters.length, editor.cursor + delta)),
  };
}

function editSearch(
  editor: SearchEditor,
  input: string,
  key: NavigationKey
): SearchEditor {
  const characters = Array.from(editor.value);
  if (key.leftArrow) return moveSearchCursor(editor, -1);
  if (key.rightArrow) return moveSearchCursor(editor, 1);
  if (key.home) return { ...editor, cursor: 0 };
  if (key.end) return { ...editor, cursor: characters.length };
  if (key.backspace && editor.cursor > 0) {
    characters.splice(editor.cursor - 1, 1);
    return { value: characters.join(''), cursor: editor.cursor - 1 };
  }
  if (key.delete && editor.cursor < characters.length) {
    characters.splice(editor.cursor, 1);
    return { value: characters.join(''), cursor: editor.cursor };
  }
  if (key.ctrl && input.toLowerCase() === 'u') {
    return { value: '', cursor: 0 };
  }
  if (key.ctrl || key.meta || input.length === 0) return editor;

  const inserted = input.replace(/[\r\n\t]+/g, ' ');
  if (inserted.length === 0) return editor;
  const insertedCharacters = Array.from(inserted);
  characters.splice(editor.cursor, 0, ...insertedCharacters);
  return {
    value: characters.join(''),
    cursor: editor.cursor + insertedCharacters.length,
  };
}

function SearchPrompt({ editor }: { editor: SearchEditor }): React.ReactElement {
  const characters = Array.from(editor.value);
  const before = characters.slice(0, editor.cursor).join('');
  const current = characters[editor.cursor] ?? ' ';
  const after = characters.slice(editor.cursor + 1).join('');
  return (
    <Text wrap="truncate-end">
      /{before}
      <Text inverse>{current}</Text>
      {after}
      <Text dimColor> · Enter search · Esc cancel</Text>
    </Text>
  );
}

function HighlightedTranscriptLine({
  line,
  matches,
  currentMatchIndex,
  selected,
  selectedBlock,
  color,
  highlightColor,
}: {
  line: TranscriptLine;
  matches: readonly TranscriptMatch[];
  currentMatchIndex: number;
  selected: boolean;
  selectedBlock: boolean;
  color: string;
  highlightColor: string;
}): React.ReactElement {
  const highlights = transcriptLineHighlights(line, matches);
  if (selected || highlights.length === 0) {
    return (
      <Text
        wrap="truncate-end"
        color={color}
        inverse={selected}
        bold={selectedBlock}
        underline={selectedBlock}
      >
        {line.text || ' '}
      </Text>
    );
  }

  const fragments: ReactNode[] = [];
  let cursor = 0;
  for (const highlight of highlights) {
    if (highlight.start > cursor) {
      fragments.push(line.text.slice(cursor, highlight.start));
    }
    fragments.push(
      <Text
        key={`${line.key}:match:${highlight.matchIndex}`}
        color={highlightColor}
        bold
        inverse={highlight.matchIndex === currentMatchIndex}
      >
        {line.text.slice(highlight.start, highlight.end)}
      </Text>
    );
    cursor = highlight.end;
  }
  if (cursor < line.text.length) {
    fragments.push(line.text.slice(cursor));
  }

  return (
    <Text
      wrap="truncate-end"
      color={color}
      bold={selectedBlock}
      underline={selectedBlock}
    >
      {fragments}
    </Text>
  );
}

export const TranscriptPager: React.FC<TranscriptPagerProps> = React.memo(
  ({ isOpen, onClose, compact = false }) => {
    const messages = useMessages();
    const currentStreamingMessageId = useCurrentStreamingMessageId();
    const currentThinkingContent = useCurrentThinkingContent();
    const streamingBuffer = useCurrentStreamingBuffer();
    const pendingCommands = usePendingCommands();
    const currentFocus = useCurrentFocus();
    const theme = useTheme();
    const { stdout } = useStdout();
    const { width, height } = useTerminalDimensions();
    const pagerHeight = compact ? Math.max(6, Math.floor(height * 0.4)) : height;
    const viewportHeight = Math.max(1, pagerHeight - 3);
    const contentWidth = Math.max(12, width - 4);

    const lineCacheRef = useRef(
      new Map<
        string,
        {
          revision: string;
          width: number;
          expanded: boolean;
          lines: TranscriptLine[];
        }
      >()
    );
    const searchIndexRef = useRef(new TranscriptSearchIndex());
    const [expandedBlockIds, setExpandedBlockIds] = useState<Set<string>>(new Set());
    const expandedBlockIdsRef = useRef(expandedBlockIds);
    expandedBlockIdsRef.current = expandedBlockIds;

    const blocks = useMemo(
      () =>
        projectTranscriptBlocks({
          messages,
          currentStreamingMessageId,
          streamingLines: streamingBuffer.lines,
          streamingTail: streamingBuffer.tail,
          currentThinkingContent,
          pendingCommands,
        }),
      [
        messages,
        currentStreamingMessageId,
        streamingBuffer.lines,
        streamingBuffer.tail,
        currentThinkingContent,
        pendingCommands,
      ]
    );
    const lines = useMemo(() => {
      const activeIds = new Set(blocks.map((block) => block.id));
      for (const cachedId of lineCacheRef.current.keys()) {
        if (!activeIds.has(cachedId)) lineCacheRef.current.delete(cachedId);
      }
      return blocks.flatMap((block, index) => {
        const expanded = expandedBlockIds.has(block.id);
        const cached = lineCacheRef.current.get(block.id);
        const blockLines =
          cached?.revision === block.revision &&
          cached.width === contentWidth &&
          cached.expanded === expanded
            ? cached.lines
            : layoutTranscriptBlock(block, contentWidth, expanded);
        if (blockLines !== cached?.lines) {
          lineCacheRef.current.set(block.id, {
            revision: block.revision,
            width: contentWidth,
            expanded,
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
            kind: block.kind,
            text: '',
            copyText: '',
            pending: block.pending === true,
            header: false,
            sourceLine: null,
            sourceStart: 0,
            sourceEnd: 0,
            sourceTextOffset: 0,
          },
        ];
      });
    }, [blocks, contentWidth, expandedBlockIds]);

    const [offsetFromBottom, setOffsetFromBottom] = useState(0);
    const [unreadBlockIds, setUnreadBlockIds] = useState<Set<string>>(new Set());
    const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
    const selectedBlockIdRef = useRef<string | null>(null);
    const [searchEditing, setSearchEditing] = useState(false);
    const searchEditingRef = useRef(false);
    const [searchEditor, setSearchEditor] = useState<SearchEditor>({
      value: '',
      cursor: 0,
    });
    const searchEditorRef = useRef(searchEditor);
    const [searchQuery, setSearchQuery] = useState('');
    const [matchIndex, setMatchIndex] = useState(0);
    const matchIndexRef = useRef(0);
    const [selection, setSelection] = useState<LineSelection | null>(null);
    const selectionRef = useRef<LineSelection | null>(null);
    const [copyStatus, setCopyStatus] = useState<string | null>(null);
    const copyGenerationRef = useRef(0);
    const pendingRevealRef = useRef<PendingReveal | null>(null);
    const offsetRef = useRef(0);
    const previousBlocksRef = useRef(blocks);
    const previousLineCountRef = useRef(lines.length);
    const previousWidthRef = useRef(contentWidth);
    offsetRef.current = offsetFromBottom;
    selectedBlockIdRef.current = selectedBlockId;
    searchEditingRef.current = searchEditing;
    searchEditorRef.current = searchEditor;
    matchIndexRef.current = matchIndex;
    selectionRef.current = selection;

    const matches = useMemo(
      () => searchIndexRef.current.search(blocks, searchQuery),
      [blocks, searchQuery]
    );
    const maxOffset = Math.max(0, lines.length - viewportHeight);
    const end = Math.max(0, lines.length - offsetFromBottom);
    const start = Math.max(0, end - viewportHeight);

    const scrollTo = useCallback(
      (nextOffset: number) => {
        const bounded = Math.max(0, Math.min(maxOffset, nextOffset));
        offsetRef.current = bounded;
        setOffsetFromBottom(bounded);
        if (bounded === 0) {
          setUnreadBlockIds(new Set());
        }
      },
      [maxOffset]
    );

    const scrollToLine = useCallback(
      (lineIndex: number) => {
        if (lines.length === 0) return;
        const boundedLine = Math.max(0, Math.min(lines.length - 1, lineIndex));
        const targetStart = Math.max(
          0,
          Math.min(
            lines.length - viewportHeight,
            boundedLine - Math.floor(viewportHeight / 2)
          )
        );
        const targetEnd = Math.min(lines.length, targetStart + viewportHeight);
        scrollTo(lines.length - targetEnd);
      },
      [lines.length, scrollTo, viewportHeight]
    );

    const setExpanded = useCallback(
      (blockId: string, expanded: boolean, reveal: PendingReveal) => {
        const next = new Set(expandedBlockIdsRef.current);
        if (expanded) next.add(blockId);
        else next.delete(blockId);
        expandedBlockIdsRef.current = next;
        pendingRevealRef.current = reveal;
        setExpandedBlockIds(next);
      },
      []
    );

    const revealMatch = useCallback(
      (match: TranscriptMatch) => {
        const block = blocks.find((candidate) => candidate.id === match.blockId);
        if (block?.collapsible && !expandedBlockIdsRef.current.has(block.id)) {
          setExpanded(block.id, true, { blockId: block.id, match });
          return;
        }
        const lineIndex = findTranscriptMatchLineIndex(lines, match);
        if (lineIndex >= 0) scrollToLine(lineIndex);
      },
      [blocks, lines, scrollToLine, setExpanded]
    );

    const selectMatch = useCallback(
      (nextIndex: number, availableMatches = matches) => {
        if (availableMatches.length === 0) {
          matchIndexRef.current = 0;
          setMatchIndex(0);
          return;
        }
        const bounded =
          ((nextIndex % availableMatches.length) + availableMatches.length) %
          availableMatches.length;
        matchIndexRef.current = bounded;
        setMatchIndex(bounded);
        const match = availableMatches[bounded];
        selectedBlockIdRef.current = match.blockId;
        setSelectedBlockId(match.blockId);
        revealMatch(match);
      },
      [matches, revealMatch]
    );

    const cycleExpandableBlock = useCallback(
      (direction: 1 | -1) => {
        const expandable = blocks.filter((block) => block.collapsible);
        if (expandable.length === 0) return;
        const currentIndex = expandable.findIndex(
          (block) => block.id === selectedBlockIdRef.current
        );
        const nextIndex =
          currentIndex < 0
            ? direction > 0
              ? 0
              : expandable.length - 1
            : (currentIndex + direction + expandable.length) % expandable.length;
        const blockId = expandable[nextIndex]!.id;
        selectedBlockIdRef.current = blockId;
        setSelectedBlockId(blockId);
        const lineIndex = lines.findIndex(
          (line) => line.blockId === blockId && line.header
        );
        if (lineIndex >= 0) scrollToLine(lineIndex);
      },
      [blocks, lines, scrollToLine]
    );

    const toggleSelectedBlock = useCallback(() => {
      let blockId = selectedBlockIdRef.current;
      if (!blockId) {
        blockId =
          lines
            .slice(start, end)
            .find((line) =>
              blocks.some((block) => block.id === line.blockId && block.collapsible)
            )?.blockId ?? null;
      }
      if (!blockId) return;
      const block = blocks.find((candidate) => candidate.id === blockId);
      if (!block?.collapsible) return;
      selectedBlockIdRef.current = blockId;
      setSelectedBlockId(blockId);
      setExpanded(blockId, !expandedBlockIdsRef.current.has(blockId), { blockId });
    }, [blocks, end, lines, setExpanded, start]);

    const moveSelection = useCallback(
      (delta: number, absolute?: 'top' | 'bottom') => {
        const current = selectionRef.current;
        if (!current || lines.length === 0) return;
        const head =
          absolute === 'top'
            ? 0
            : absolute === 'bottom'
              ? lines.length - 1
              : Math.max(0, Math.min(lines.length - 1, current.head + delta));
        const next = { ...current, head };
        selectionRef.current = next;
        setSelection(next);
        scrollToLine(head);
      },
      [lines.length, scrollToLine]
    );

    const copySelection = useCallback(() => {
      const current = selectionRef.current;
      if (!current) return;
      const text = copyTranscriptLineRange(lines, current.anchor, current.head);
      if (!text.trim()) {
        setCopyStatus('Nothing selected');
        return;
      }
      const generation = ++copyGenerationRef.current;
      setCopyStatus('Copying...');
      void copyTranscriptText(text, {
        writeTerminal: (value) => stdout.write(value),
      }).then((result) => {
        if (copyGenerationRef.current !== generation) return;
        setCopyStatus(
          result.success
            ? result.method === 'osc52'
              ? 'Copy sent via OSC 52'
              : `Copied ${text.split('\n').length} lines`
            : 'Copy failed'
        );
        selectionRef.current = null;
        setSelection(null);
      });
    }, [lines, stdout]);

    useEffect(() => {
      if (!copyStatus) return;
      const timeout = setTimeout(() => setCopyStatus(null), 2500);
      return () => clearTimeout(timeout);
    }, [copyStatus]);

    useEffect(() => {
      if (!isOpen) {
        copyGenerationRef.current++;
        previousBlocksRef.current = blocks;
        previousLineCountRef.current = lines.length;
        return;
      }
      expandedBlockIdsRef.current = new Set();
      setExpandedBlockIds(new Set());
      selectedBlockIdRef.current = null;
      setSelectedBlockId(null);
      searchEditingRef.current = false;
      setSearchEditing(false);
      searchEditorRef.current = { value: '', cursor: 0 };
      setSearchEditor({ value: '', cursor: 0 });
      setSearchQuery('');
      matchIndexRef.current = 0;
      setMatchIndex(0);
      selectionRef.current = null;
      setSelection(null);
      setCopyStatus(null);
      offsetRef.current = 0;
      setOffsetFromBottom(0);
      setUnreadBlockIds(new Set());
      previousBlocksRef.current = blocks;
      previousLineCountRef.current = lines.length;
      previousWidthRef.current = contentWidth;
    }, [isOpen]);

    useEffect(() => {
      const activeIds = new Set(blocks.map((block) => block.id));
      setExpandedBlockIds((current) => {
        const next = new Set([...current].filter((id) => activeIds.has(id)));
        expandedBlockIdsRef.current = next;
        const unchanged =
          next.size === current.size && [...next].every((id) => current.has(id));
        return unchanged ? current : next;
      });
      if (selectedBlockIdRef.current && !activeIds.has(selectedBlockIdRef.current)) {
        selectedBlockIdRef.current = null;
        setSelectedBlockId(null);
      }
    }, [blocks]);

    useEffect(() => {
      const previousLineCount = previousLineCountRef.current;
      previousLineCountRef.current = lines.length;
      if (!isOpen) return;

      const pendingReveal = pendingRevealRef.current;
      if (pendingReveal) {
        pendingRevealRef.current = null;
        const lineIndex = pendingReveal.match
          ? findTranscriptMatchLineIndex(lines, pendingReveal.match)
          : lines.findIndex(
              (line) => line.blockId === pendingReveal.blockId && line.header
            );
        if (lineIndex >= 0) scrollToLine(lineIndex);
        return;
      }

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
    }, [contentWidth, expandedBlockIds, isOpen, lines.length, maxOffset, scrollToLine]);

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

    useEffect(() => {
      if (matches.length === 0) {
        matchIndexRef.current = 0;
        setMatchIndex(0);
      } else if (matchIndexRef.current >= matches.length) {
        matchIndexRef.current = matches.length - 1;
        setMatchIndex(matches.length - 1);
      }
    }, [matches.length]);

    useEffect(() => {
      if (previousWidthRef.current === contentWidth) return;
      previousWidthRef.current = contentWidth;
      selectionRef.current = null;
      setSelection(null);
      const currentMatch = matches[matchIndexRef.current];
      if (currentMatch) revealMatch(currentMatch);
    }, [contentWidth, matches, revealMatch]);

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

        if (searchEditingRef.current) {
          if (key.escape) {
            searchEditingRef.current = false;
            setSearchEditing(false);
            searchEditorRef.current = {
              value: searchQuery,
              cursor: Array.from(searchQuery).length,
            };
            setSearchEditor(searchEditorRef.current);
            return true;
          }
          if (key.return) {
            const query = searchEditorRef.current.value;
            const nextMatches = searchIndexRef.current.search(blocks, query);
            setSearchQuery(query);
            searchEditingRef.current = false;
            setSearchEditing(false);
            selectMatch(0, nextMatches);
            return true;
          }
          const next = editSearch(searchEditorRef.current, input, key);
          searchEditorRef.current = next;
          setSearchEditor(next);
          return true;
        }

        if (input === 'q') {
          onClose();
          return true;
        }

        if (selectionRef.current) {
          if (key.escape) {
            selectionRef.current = null;
            setSelection(null);
            return true;
          }
          if (input === 'y' || (key.ctrl && !key.meta && input.toLowerCase() === 'c')) {
            copySelection();
            return true;
          }
          if (key.upArrow || input === 'k') {
            moveSelection(-1);
            return true;
          }
          if (key.downArrow || input === 'j') {
            moveSelection(1);
            return true;
          }
          if (key.pageUp) {
            moveSelection(-Math.max(1, viewportHeight - 1));
            return true;
          }
          if (key.pageDown) {
            moveSelection(Math.max(1, viewportHeight - 1));
            return true;
          }
          if (key.home || input === 'g') {
            moveSelection(0, 'top');
            return true;
          }
          if (key.end || input === 'G') {
            moveSelection(0, 'bottom');
            return true;
          }
          return true;
        }

        if (key.escape) {
          onClose();
          return true;
        }
        if (input === '/') {
          const editor = {
            value: searchQuery,
            cursor: Array.from(searchQuery).length,
          };
          searchEditorRef.current = editor;
          setSearchEditor(editor);
          searchEditingRef.current = true;
          setSearchEditing(true);
          return true;
        }
        if (input === 'n' && matches.length > 0) {
          selectMatch(matchIndexRef.current + 1);
          return true;
        }
        if (input === 'N' && matches.length > 0) {
          selectMatch(matchIndexRef.current - 1);
          return true;
        }
        if (key.tab) {
          cycleExpandableBlock(key.shift ? -1 : 1);
          return true;
        }
        if (key.return || input === 'e') {
          toggleSelectedBlock();
          return true;
        }
        if (input === 'v') {
          if (lines.length === 0) return true;
          const currentEnd = Math.max(0, lines.length - offsetRef.current);
          const currentStart = Math.max(0, currentEnd - viewportHeight);
          const selectedLine = selectedBlockIdRef.current
            ? lines.findIndex(
                (line) => line.blockId === selectedBlockIdRef.current && line.header
              )
            : -1;
          const anchor =
            selectedLine >= 0
              ? selectedLine
              : Math.max(0, Math.min(lines.length - 1, currentStart));
          const next = { anchor, head: anchor };
          selectionRef.current = next;
          setSelection(next);
          scrollToLine(anchor);
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

    const visibleLines = lines.slice(start, end);
    const unreadCount = unreadBlockIds.size;
    const position =
      lines.length === 0 ? '0/0' : `${Math.min(end, lines.length)}/${lines.length}`;
    const selectionStart = selection ? Math.min(selection.anchor, selection.head) : -1;
    const selectionEnd = selection ? Math.max(selection.anchor, selection.head) : -1;
    const searchStatus =
      searchQuery.length > 0
        ? `/${searchQuery} ${matches.length > 0 ? `${matchIndex + 1}/${matches.length}` : '0/0'}`
        : null;
    const footerStatus = copyStatus
      ? copyStatus
      : selection
        ? `${selectionEnd - selectionStart + 1} lines selected · y copy · Esc cancel`
        : searchStatus
          ? `${searchStatus} · n/N`
          : unreadCount > 0
            ? `${unreadCount} new · G latest`
            : 'Ctrl+O / Esc / q close';

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
            visibleLines.map((line, visibleIndex) => {
              const absoluteIndex = start + visibleIndex;
              const selected =
                selectionStart >= 0 &&
                absoluteIndex >= selectionStart &&
                absoluteIndex <= selectionEnd;
              const selectedBlock = line.header && line.blockId === selectedBlockId;
              const color = line.pending
                ? theme.colors.warning
                : line.kind === 'thinking'
                  ? theme.colors.info
                  : line.role === 'user'
                    ? theme.colors.info
                    : line.role === 'assistant'
                      ? theme.colors.success
                      : theme.colors.text.secondary;
              return (
                <HighlightedTranscriptLine
                  key={line.key}
                  line={line}
                  matches={matches}
                  currentMatchIndex={matchIndex}
                  selected={selected}
                  selectedBlock={selectedBlock}
                  color={color}
                  highlightColor={theme.colors.warning}
                />
              );
            })
          )}
        </Box>
        <Box flexShrink={0}>
          {searchEditing ? (
            <SearchPrompt editor={searchEditor} />
          ) : (
            <Text
              color={
                copyStatus || unreadCount > 0
                  ? theme.colors.warning
                  : theme.colors.text.muted
              }
              wrap="truncate-end"
            >
              {footerStatus} · / search · Tab/Enter expand · v/y copy · j/k PgUp/PgDn
              g/G
            </Text>
          )}
        </Box>
      </Box>
    );
  }
);
