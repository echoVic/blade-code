import { Box, Text, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSurfaceMessage } from '../../api/sessionSurfaceSchemas.js';
import { useCurrentFocus } from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { useTerminalDimensions } from '../hooks/useTerminalDimensions.js';
import { useTerminalInput } from '../input/TerminalInputRouter.js';
import type {
  SessionHistoryActionTarget,
  SessionHistoryViewState,
} from '../services/SessionHistoryController.js';
import {
  layoutTranscriptBlocks,
  type TranscriptBlock,
  TranscriptSearchIndex,
} from '../transcript/TranscriptProjection.js';
import { copyTranscriptText } from '../utils/clipboard.js';

interface SessionHistoryViewerProps {
  state: SessionHistoryViewState;
  onLoadOlder: (target: SessionHistoryActionTarget) => void | Promise<void>;
  onFork: (target: SessionHistoryActionTarget) => void | Promise<void>;
  onClose: () => void;
}

type SearchEditor = { value: string; cursor: number };

function toTranscriptBlocks(
  messages: readonly SessionSurfaceMessage[]
): TranscriptBlock[] {
  return messages.map((message) => ({
    id: message.id,
    messageId: message.id,
    role: message.role,
    kind: 'message',
    content: message.content,
    revision: `${message.timestamp}:${message.content.length}:${message.truncated === true}`,
    collapsible: false,
  }));
}

function editSearch(
  editor: SearchEditor,
  input: string,
  key: Record<string, boolean>
): SearchEditor {
  const characters = Array.from(editor.value);
  if (key.backspace || key.delete) {
    if (editor.cursor === 0) return editor;
    characters.splice(editor.cursor - 1, 1);
    return { value: characters.join(''), cursor: editor.cursor - 1 };
  }
  if (key.leftArrow) return { ...editor, cursor: Math.max(0, editor.cursor - 1) };
  if (key.rightArrow) {
    return { ...editor, cursor: Math.min(characters.length, editor.cursor + 1) };
  }
  if (!input || key.ctrl || key.meta) return editor;
  characters.splice(editor.cursor, 0, ...Array.from(input));
  return {
    value: characters.join(''),
    cursor: editor.cursor + Array.from(input).length,
  };
}

export const SessionHistoryViewer: React.FC<SessionHistoryViewerProps> = ({
  state,
  onLoadOlder,
  onFork,
  onClose,
}) => {
  const currentFocus = useCurrentFocus();
  const { width, height } = useTerminalDimensions();
  const { stdout } = useStdout();
  const contentWidth = Math.max(20, width - 4);
  const viewportHeight = Math.max(1, height - 8);
  const blocks = useMemo(() => toTranscriptBlocks(state.messages), [state.messages]);
  const lines = useMemo(
    () => layoutTranscriptBlocks(blocks, contentWidth),
    [blocks, contentWidth]
  );
  const maxOffset = Math.max(0, lines.length - viewportHeight);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  const [selectedLine, setSelectedLine] = useState(() => Math.max(0, lines.length - 1));
  const selectedLineRef = useRef(selectedLine);
  const selectedLineKeyRef = useRef<string | null>(lines.at(-1)?.key ?? null);
  const [searchEditing, setSearchEditing] = useState(false);
  const searchEditingRef = useRef(false);
  const [searchEditor, setSearchEditor] = useState<SearchEditor>({
    value: '',
    cursor: 0,
  });
  const searchEditorRef = useRef(searchEditor);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const searchIndexRef = useRef(new TranscriptSearchIndex());
  const requestedCursorRef = useRef<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const actionTarget = useMemo<SessionHistoryActionTarget | undefined>(
    () =>
      state.session
        ? {
            viewGeneration: state.viewGeneration,
            locator: state.session.locator,
            snapshot: state.snapshot,
            olderCursor: state.olderCursor,
          }
        : undefined,
    [state.olderCursor, state.session, state.snapshot, state.viewGeneration]
  );

  offsetRef.current = offset;
  selectedLineRef.current = selectedLine;
  searchEditingRef.current = searchEditing;
  searchEditorRef.current = searchEditor;

  const matches = useMemo(
    () => searchIndexRef.current.search(blocks, searchQuery),
    [blocks, searchQuery]
  );

  useEffect(() => {
    requestedCursorRef.current = null;
  }, [state.olderCursor]);

  useEffect(() => {
    if (state.status === 'error') requestedCursorRef.current = null;
  }, [state.status]);

  useEffect(() => {
    const anchoredLine = selectedLineKeyRef.current
      ? lines.findIndex((line) => line.key === selectedLineKeyRef.current)
      : -1;
    const next =
      lines.length === 0 ? 0 : anchoredLine >= 0 ? anchoredLine : lines.length - 1;
    selectedLineRef.current = next;
    selectedLineKeyRef.current = lines[next]?.key ?? null;
    setSelectedLine(next);
    const nextOffset = Math.max(0, Math.min(offsetRef.current, maxOffset));
    offsetRef.current = nextOffset;
    setOffset(nextOffset);
  }, [lines, maxOffset]);

  const requestOlder = () => {
    const cursor = state.olderCursor;
    if (
      !cursor ||
      !actionTarget ||
      !state.session?.capabilities.history.read ||
      (state.status !== 'ready' && state.status !== 'error')
    ) {
      return;
    }
    if (requestedCursorRef.current === cursor) return;
    requestedCursorRef.current = cursor;
    void onLoadOlder(actionTarget);
  };

  const scrollTo = (next: number, loadOlderAtTop = true) => {
    const clamped = Math.max(0, Math.min(maxOffset, next));
    offsetRef.current = clamped;
    setOffset(clamped);
    const end = Math.max(1, lines.length - clamped);
    const start = Math.max(0, end - viewportHeight);
    const nextSelected = Math.max(start, Math.min(end - 1, selectedLineRef.current));
    selectedLineRef.current = nextSelected;
    selectedLineKeyRef.current = lines[nextSelected]?.key ?? null;
    setSelectedLine(nextSelected);
    if (loadOlderAtTop && clamped === maxOffset) requestOlder();
  };

  const revealMatch = (index: number) => {
    if (matches.length === 0) return;
    const wrappedIndex = ((index % matches.length) + matches.length) % matches.length;
    const match = matches[wrappedIndex]!;
    const lineIndex = lines.findIndex((line) => line.blockId === match.blockId);
    setMatchIndex(wrappedIndex);
    if (lineIndex < 0) return;
    selectedLineRef.current = lineIndex;
    selectedLineKeyRef.current = lines[lineIndex]?.key ?? null;
    setSelectedLine(lineIndex);
    const targetOffset = Math.max(
      0,
      lines.length - Math.min(lines.length, lineIndex + 1)
    );
    scrollTo(targetOffset, false);
  };

  const copyCurrentLine = () => {
    const line = lines[selectedLineRef.current];
    if (!line) return;
    void copyTranscriptText(line.copyText, {
      writeTerminal: (value) => stdout.write(value),
    }).then((result) => {
      setCopyStatus(result.success ? 'Copied' : 'Copy failed');
    });
  };

  useTerminalInput(
    (input, rawKey) => {
      const key = rawKey as Record<string, boolean>;
      if (searchEditingRef.current) {
        if (key.escape) {
          searchEditingRef.current = false;
          setSearchEditing(false);
          return true;
        }
        if (key.return) {
          const query = searchEditorRef.current.value;
          setSearchQuery(query);
          searchEditingRef.current = false;
          setSearchEditing(false);
          const nextMatches = searchIndexRef.current.search(blocks, query);
          if (nextMatches.length > 0) {
            const match = nextMatches[0]!;
            const lineIndex = lines.findIndex((line) => line.blockId === match.blockId);
            setMatchIndex(0);
            if (lineIndex >= 0) {
              selectedLineRef.current = lineIndex;
              selectedLineKeyRef.current = lines[lineIndex]?.key ?? null;
              setSelectedLine(lineIndex);
              scrollTo(
                Math.max(0, lines.length - Math.min(lines.length, lineIndex + 1)),
                false
              );
            }
          }
          return true;
        }
        const next = editSearch(searchEditorRef.current, input, key);
        searchEditorRef.current = next;
        setSearchEditor(next);
        return true;
      }

      if (key.escape || input === 'q') {
        onClose();
        return true;
      }
      if (input === '/') {
        const editor = { value: searchQuery, cursor: Array.from(searchQuery).length };
        searchEditorRef.current = editor;
        setSearchEditor(editor);
        searchEditingRef.current = true;
        setSearchEditing(true);
        return true;
      }
      if (input === 'n' && matches.length > 0) {
        revealMatch(matchIndex + 1);
        return true;
      }
      if (input === 'N' && matches.length > 0) {
        revealMatch(matchIndex - 1);
        return true;
      }
      if (input === 'y') {
        copyCurrentLine();
        return true;
      }
      if (input === 'f') {
        if (
          actionTarget &&
          state.session?.capabilities.history.fork &&
          state.status === 'ready'
        ) {
          void onFork(actionTarget);
        }
        return true;
      }
      if (key.home || input === 'g') {
        selectedLineRef.current = 0;
        selectedLineKeyRef.current = lines[0]?.key ?? null;
        setSelectedLine(0);
        scrollTo(maxOffset);
        return true;
      }
      if (key.end || input === 'G') {
        selectedLineRef.current = Math.max(0, lines.length - 1);
        selectedLineKeyRef.current = lines[selectedLineRef.current]?.key ?? null;
        setSelectedLine(selectedLineRef.current);
        scrollTo(0);
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
      if (key.upArrow || input === 'k') {
        selectedLineRef.current = Math.max(0, selectedLineRef.current - 1);
        selectedLineKeyRef.current = lines[selectedLineRef.current]?.key ?? null;
        setSelectedLine(selectedLineRef.current);
        scrollTo(offsetRef.current + 1);
        return true;
      }
      if (key.downArrow || input === 'j') {
        selectedLineRef.current = Math.min(
          lines.length - 1,
          selectedLineRef.current + 1
        );
        selectedLineKeyRef.current = lines[selectedLineRef.current]?.key ?? null;
        setSelectedLine(selectedLineRef.current);
        scrollTo(offsetRef.current - 1);
        return true;
      }
      return true;
    },
    {
      isActive: currentFocus === FocusId.SESSION_HISTORY_VIEWER,
      priority: 200,
    }
  );

  const end = Math.max(0, lines.length - offset);
  const start = Math.max(0, end - viewportHeight);
  const visibleLines = lines.slice(start, end);
  const searchStatus = searchQuery
    ? `/${searchQuery} ${matches.length > 0 ? `${matchIndex + 1}/${matches.length}` : '0/0'} · loaded pages only`
    : null;
  const session = state.session;
  const unavailableActions = [
    session && !session.capabilities.history.read ? 'Older history unavailable' : null,
    session && !session.capabilities.history.fork ? 'Fork unavailable' : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' · ');
  const operationStatus =
    state.status === 'loading'
      ? 'Loading Session history…'
      : state.status === 'forking'
        ? 'Forking Session history…'
        : state.status === 'loading-older'
          ? 'Loading older history…'
          : null;
  const footer =
    state.error?.message ??
    operationStatus ??
    copyStatus ??
    searchStatus ??
    (unavailableActions ||
      `${state.status === 'loading-older' ? 'Loading older history… · ' : ''}/ search · y copy · f fork · Esc close`);

  return (
    <Box flexDirection="column" width="100%" height={height} paddingX={2}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {session?.title?.trim() || 'Session history'}
        </Text>
        <Text color="yellow">
          Remote · {session?.capabilities.connection ?? 'offline'} · History only
        </Text>
      </Box>
      <Text dimColor>{session?.displayCwd ?? ''}</Text>
      {state.truncated ? (
        <Text color="yellow">History content was truncated.</Text>
      ) : null}
      <Box flexDirection="column" height={viewportHeight}>
        {visibleLines.map((line, index) => (
          <Text
            key={line.key}
            color={start + index === selectedLine ? 'cyan' : undefined}
          >
            {line.text}
          </Text>
        ))}
      </Box>
      {searchEditing ? <Text>/{searchEditor.value}</Text> : null}
      <Text color={state.error ? 'red' : 'gray'}>{footer}</Text>
      <Text dimColor>Open this Session from its ACP owner to continue.</Text>
      <Text dimColor>Files and terminal are unavailable in history-only mode.</Text>
    </Box>
  );
};
