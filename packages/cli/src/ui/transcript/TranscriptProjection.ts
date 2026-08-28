import type { PendingCommand, SessionMessage } from '../../store/types.js';
import { wrapCellText } from '../utils/markdown.js';

export type TranscriptBlockKind = 'message' | 'thinking' | 'tool';

export interface TranscriptBlock {
  id: string;
  messageId: string;
  role: SessionMessage['role'];
  kind: TranscriptBlockKind;
  content: string;
  detail?: string;
  revision: string;
  pending?: boolean;
  collapsible: boolean;
}

export interface TranscriptProjectionInput {
  messages: readonly SessionMessage[];
  currentStreamingMessageId: string | null;
  streamingLines: readonly string[];
  streamingTail: string;
  currentThinkingContent?: string | null;
  pendingCommands: readonly PendingCommand[];
}

export interface TranscriptLine {
  key: string;
  blockId: string;
  role: TranscriptBlock['role'];
  kind: TranscriptBlockKind;
  text: string;
  copyText: string;
  pending: boolean;
  header: boolean;
  sourceLine: number | null;
  sourceStart: number;
  sourceEnd: number;
  sourceTextOffset: number;
}

export interface TranscriptMatch {
  blockId: string;
  sourceLine: number;
  start: number;
  end: number;
}

export interface TranscriptLineHighlight {
  start: number;
  end: number;
  matchIndex: number;
}

function streamingContent(lines: readonly string[], tail: string): string {
  return [...lines, tail].join('\n').replace(/\n+$/, '');
}

function contentRevision(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

export function projectTranscriptBlocks({
  messages,
  currentStreamingMessageId,
  streamingLines,
  streamingTail,
  currentThinkingContent,
  pendingCommands,
}: TranscriptProjectionInput): TranscriptBlock[] {
  const liveContent = streamingContent(streamingLines, streamingTail);
  const blocks: TranscriptBlock[] = [];

  for (const message of messages) {
    const content =
      message.id === currentStreamingMessageId ? liveContent : message.content;
    const phase =
      message.metadata && 'phase' in message.metadata
        ? String(message.metadata.phase)
        : '';
    const thinkingContent =
      message.id === currentStreamingMessageId
        ? (currentThinkingContent ?? message.thinkingContent)
        : message.thinkingContent;

    if (message.role === 'assistant' && thinkingContent) {
      blocks.push({
        id: `${message.id}:thinking`,
        messageId: message.id,
        role: 'assistant',
        kind: 'thinking',
        content: thinkingContent,
        revision: `${message.timestamp}:thinking:${contentRevision(thinkingContent)}`,
        collapsible: true,
      });
    }

    const detail =
      message.role === 'tool' &&
      message.metadata &&
      'detail' in message.metadata &&
      typeof message.metadata.detail === 'string' &&
      message.metadata.detail.length > 0
        ? message.metadata.detail
        : undefined;
    blocks.push({
      id: message.id,
      messageId: message.id,
      role: message.role,
      kind: message.role === 'tool' ? 'tool' : 'message',
      content,
      detail,
      revision: `${message.timestamp}:${contentRevision(content)}:${contentRevision(detail ?? '')}:${phase}`,
      collapsible: detail !== undefined,
    });
  }

  if (
    currentStreamingMessageId &&
    !blocks.some((block) => block.id === currentStreamingMessageId)
  ) {
    if (currentThinkingContent) {
      blocks.push({
        id: `${currentStreamingMessageId}:thinking`,
        messageId: currentStreamingMessageId,
        role: 'assistant',
        kind: 'thinking',
        content: currentThinkingContent,
        revision: `stream:thinking:${contentRevision(currentThinkingContent)}`,
        collapsible: true,
      });
    }
    blocks.push({
      id: currentStreamingMessageId,
      messageId: currentStreamingMessageId,
      role: 'assistant',
      kind: 'message',
      content: liveContent,
      revision: `stream:${contentRevision(liveContent)}`,
      collapsible: false,
    });
  }

  for (const [index, command] of pendingCommands.entries()) {
    blocks.push({
      id: `pending:${index}:${command.displayText}`,
      messageId: `pending:${index}`,
      role: 'user',
      kind: 'message',
      content: command.displayText,
      revision: `pending:${contentRevision(command.displayText)}`,
      pending: true,
      collapsible: false,
    });
  }

  return blocks;
}

const ROLE_PREFIX: Record<TranscriptBlock['role'], string> = {
  user: '> ',
  assistant: '• ',
  system: '  ',
  tool: '└ ',
};

interface LayoutSection {
  text: string;
  firstPrefix: string;
  nextPrefix: string;
  sourceLineOffset: number;
  key: string;
  header: boolean;
}

function layoutSection(
  block: TranscriptBlock,
  section: LayoutSection,
  width: number
): TranscriptLine[] {
  const sourceLines = section.text.length > 0 ? section.text.split('\n') : [''];
  const result: TranscriptLine[] = [];

  for (const [lineIndex, sourceLine] of sourceLines.entries()) {
    const prefix = result.length === 0 ? section.firstPrefix : section.nextPrefix;
    const contentWidth = Math.max(1, width - prefix.length);
    const wrapped = wrapCellText(sourceLine, contentWidth, true);
    let sourceCursor = 0;

    for (const text of wrapped) {
      const located =
        text.length > 0 ? sourceLine.indexOf(text, sourceCursor) : sourceCursor;
      const sourceStart = located >= 0 ? located : sourceCursor;
      const sourceEnd = sourceStart + text.length;
      const linePrefix = result.length === 0 ? section.firstPrefix : section.nextPrefix;
      result.push({
        key: `${block.id}:${section.key}:${lineIndex}:${result.length}`,
        blockId: block.id,
        role: block.role,
        kind: block.kind,
        text: `${linePrefix}${text}`,
        copyText: text,
        pending: block.pending === true,
        header: section.header && result.length === 0,
        sourceLine: section.sourceLineOffset + lineIndex,
        sourceStart,
        sourceEnd,
        sourceTextOffset: linePrefix.length,
      });
      sourceCursor = sourceEnd;
    }
  }

  return result;
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length;
}

function thinkingSummary(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  if (firstLine.length <= 48) return firstLine;
  return `${firstLine.slice(0, 45)}...`;
}

export function layoutTranscriptBlock(
  block: TranscriptBlock,
  width: number,
  expanded = false
): TranscriptLine[] {
  if (block.kind === 'thinking') {
    const marker = expanded ? '[-]' : '[+]';
    const summary = thinkingSummary(block.content);
    const label = `${marker} Thinking (${countLines(block.content)} lines)${
      !expanded && summary ? ` - ${summary}` : ''
    }`;
    const header: TranscriptLine = {
      key: `${block.id}:header`,
      blockId: block.id,
      role: block.role,
      kind: block.kind,
      text: `? ${label}`,
      copyText: label,
      pending: block.pending === true,
      header: true,
      sourceLine: null,
      sourceStart: 0,
      sourceEnd: 0,
      sourceTextOffset: 2,
    };
    if (!expanded) return [header];
    return [
      header,
      ...layoutSection(
        block,
        {
          text: block.content,
          firstPrefix: '    ',
          nextPrefix: '    ',
          sourceLineOffset: 0,
          key: 'thinking',
          header: false,
        },
        width
      ),
    ];
  }

  if (block.kind === 'tool' && block.detail) {
    const marker = expanded ? '[-]' : '[+]';
    const headerLines = layoutSection(
      block,
      {
        text: block.content,
        firstPrefix: `${ROLE_PREFIX.tool}${marker} `,
        nextPrefix: '      ',
        sourceLineOffset: 0,
        key: 'summary',
        header: true,
      },
      width
    );
    if (!expanded) return headerLines;
    return [
      ...headerLines,
      ...layoutSection(
        block,
        {
          text: block.detail,
          firstPrefix: '    ',
          nextPrefix: '    ',
          sourceLineOffset: countLines(block.content),
          key: 'detail',
          header: false,
        },
        width
      ),
    ];
  }

  return layoutSection(
    block,
    {
      text: block.content.length > 0 ? block.content : '…',
      firstPrefix: ROLE_PREFIX[block.role],
      nextPrefix: '  ',
      sourceLineOffset: 0,
      key: 'content',
      header: true,
    },
    width
  );
}

export function layoutTranscriptBlocks(
  blocks: readonly TranscriptBlock[],
  width: number,
  expandedBlockIds: ReadonlySet<string> = new Set()
): TranscriptLine[] {
  return blocks.flatMap((block, index) => {
    const lines = layoutTranscriptBlock(block, width, expandedBlockIds.has(block.id));
    if (index === blocks.length - 1) return lines;
    return [
      ...lines,
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
}

function searchableLines(block: TranscriptBlock): string[] {
  if (block.kind === 'tool' && block.detail) {
    return [...block.content.split('\n'), ...block.detail.split('\n')];
  }
  return block.content.split('\n');
}

function searchTranscriptBlock(
  block: TranscriptBlock,
  matcher: RegExp
): TranscriptMatch[] {
  const matches: TranscriptMatch[] = [];
  for (const [sourceLine, text] of searchableLines(block).entries()) {
    for (const match of text.matchAll(matcher)) {
      const start = match.index;
      const value = match[0];
      if (value.length === 0) continue;
      matches.push({
        blockId: block.id,
        sourceLine,
        start,
        end: start + value.length,
      });
    }
  }
  return matches;
}

export class TranscriptSearchIndex {
  private readonly cache = new Map<
    string,
    { revision: string; query: string; matches: TranscriptMatch[] }
  >();

  search(blocks: readonly TranscriptBlock[], query: string): TranscriptMatch[] {
    if (query.length === 0) return [];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(escaped, 'giu');
    const activeIds = new Set(blocks.map((block) => block.id));
    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) this.cache.delete(id);
    }

    return blocks.flatMap((block) => {
      const cached = this.cache.get(block.id);
      if (cached?.revision === block.revision && cached.query === query) {
        return cached.matches;
      }
      const matches = searchTranscriptBlock(block, matcher);
      this.cache.set(block.id, { revision: block.revision, query, matches });
      return matches;
    });
  }
}

export function searchTranscriptBlocks(
  blocks: readonly TranscriptBlock[],
  query: string
): TranscriptMatch[] {
  return new TranscriptSearchIndex().search(blocks, query);
}

export function findTranscriptMatchLineIndex(
  lines: readonly TranscriptLine[],
  match: TranscriptMatch
): number {
  const exactIndex = lines.findIndex(
    (line) =>
      line.blockId === match.blockId &&
      line.sourceLine === match.sourceLine &&
      match.start >= line.sourceStart &&
      match.start < Math.max(line.sourceEnd, line.sourceStart + 1)
  );
  if (exactIndex >= 0) return exactIndex;
  return lines.findIndex((line) => line.blockId === match.blockId);
}

export function transcriptLineHighlights(
  line: TranscriptLine,
  matches: readonly TranscriptMatch[]
): TranscriptLineHighlight[] {
  if (line.sourceLine === null || line.sourceEnd <= line.sourceStart) return [];
  const highlights: TranscriptLineHighlight[] = [];
  for (const [matchIndex, match] of matches.entries()) {
    if (
      match.blockId !== line.blockId ||
      match.sourceLine !== line.sourceLine ||
      match.end <= line.sourceStart ||
      match.start >= line.sourceEnd
    ) {
      continue;
    }
    highlights.push({
      start:
        line.sourceTextOffset +
        Math.max(line.sourceStart, match.start) -
        line.sourceStart,
      end:
        line.sourceTextOffset + Math.min(line.sourceEnd, match.end) - line.sourceStart,
      matchIndex,
    });
  }
  return highlights;
}

export function copyTranscriptLineRange(
  lines: readonly TranscriptLine[],
  anchor: number,
  head: number
): string {
  const start = Math.max(0, Math.min(anchor, head));
  const end = Math.min(lines.length - 1, Math.max(anchor, head));
  if (end < start) return '';
  const selected = lines.slice(start, end + 1);
  let output = '';
  for (const [index, line] of selected.entries()) {
    if (index === 0) {
      output = line.copyText;
      continue;
    }
    const previous = selected[index - 1]!;
    const isSoftWrap =
      line.sourceLine !== null &&
      line.blockId === previous.blockId &&
      line.sourceLine === previous.sourceLine;
    output += `${isSoftWrap ? '' : '\n'}${line.copyText}`;
  }
  return output;
}

export function changedTranscriptBlockIds(
  previous: readonly TranscriptBlock[],
  current: readonly TranscriptBlock[]
): string[] {
  const previousRevisions = new Map(
    previous.map((block) => [block.id, block.revision])
  );
  return current
    .filter((block) => previousRevisions.get(block.id) !== block.revision)
    .map((block) => block.id);
}
