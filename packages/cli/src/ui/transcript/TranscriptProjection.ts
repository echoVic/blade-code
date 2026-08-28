import type { PendingCommand, SessionMessage } from '../../store/types.js';
import { wrapCellText } from '../utils/markdown.js';

export interface TranscriptBlock {
  id: string;
  role: SessionMessage['role'];
  content: string;
  revision: string;
  pending?: boolean;
}

export interface TranscriptProjectionInput {
  messages: readonly SessionMessage[];
  currentStreamingMessageId: string | null;
  streamingLines: readonly string[];
  streamingTail: string;
  pendingCommands: readonly PendingCommand[];
}

export interface TranscriptLine {
  key: string;
  blockId: string;
  role: TranscriptBlock['role'];
  text: string;
  pending: boolean;
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
  pendingCommands,
}: TranscriptProjectionInput): TranscriptBlock[] {
  const liveContent = streamingContent(streamingLines, streamingTail);
  const blocks = messages.map((message): TranscriptBlock => {
    const content =
      message.id === currentStreamingMessageId ? liveContent : message.content;
    const phase =
      message.metadata && 'phase' in message.metadata
        ? String(message.metadata.phase)
        : '';
    return {
      id: message.id,
      role: message.role,
      content,
      revision: `${message.timestamp}:${contentRevision(content)}:${phase}`,
    };
  });

  if (
    currentStreamingMessageId &&
    !blocks.some((block) => block.id === currentStreamingMessageId)
  ) {
    blocks.push({
      id: currentStreamingMessageId,
      role: 'assistant',
      content: liveContent,
      revision: `stream:${contentRevision(liveContent)}`,
    });
  }

  for (const [index, command] of pendingCommands.entries()) {
    blocks.push({
      id: `pending:${index}:${command.displayText}`,
      role: 'user',
      content: command.displayText,
      revision: `pending:${contentRevision(command.displayText)}`,
      pending: true,
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

export function layoutTranscriptBlock(
  block: TranscriptBlock,
  width: number
): TranscriptLine[] {
  const contentWidth = Math.max(1, width - 2);
  const sourceLines = block.content.length > 0 ? block.content.split('\n') : ['…'];
  const wrapped = sourceLines.flatMap((line) => wrapCellText(line, contentWidth, true));

  return wrapped.map((text, index) => ({
    key: `${block.id}:${index}`,
    blockId: block.id,
    role: block.role,
    text: `${index === 0 ? ROLE_PREFIX[block.role] : '  '}${text}`,
    pending: block.pending === true,
  }));
}

export function layoutTranscriptBlocks(
  blocks: readonly TranscriptBlock[],
  width: number
): TranscriptLine[] {
  return blocks.flatMap((block, index) => {
    const lines = layoutTranscriptBlock(block, width);
    if (index === blocks.length - 1) return lines;
    return [
      ...lines,
      {
        key: `${block.id}:separator`,
        blockId: block.id,
        role: block.role,
        text: '',
        pending: block.pending === true,
      },
    ];
  });
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
