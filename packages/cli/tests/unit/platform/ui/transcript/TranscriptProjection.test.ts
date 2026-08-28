import { describe, expect, it } from 'vitest';
import {
  changedTranscriptBlockIds,
  copyTranscriptLineRange,
  findTranscriptMatchLineIndex,
  layoutTranscriptBlocks,
  projectTranscriptBlocks,
  searchTranscriptBlocks,
  TranscriptSearchIndex,
  transcriptLineHighlights,
} from '../../../../../src/ui/transcript/TranscriptProjection.js';

describe('TranscriptProjection', () => {
  it('projects committed, live, and queued input as structured blocks', () => {
    const blocks = projectTranscriptBlocks({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'inspect the renderer',
          timestamp: 1,
        },
        {
          id: 'assistant-live',
          role: 'assistant',
          content: '',
          timestamp: 2,
          thinkingContent: 'checking assumptions',
        },
        {
          id: 'tool-1',
          role: 'tool',
          content: 'Read package.json',
          timestamp: 3,
          metadata: {
            toolName: 'Read',
            phase: 'complete',
            detail: 'hidden dependency details',
          },
        },
      ],
      currentStreamingMessageId: 'assistant-live',
      streamingLines: ['first line'],
      streamingTail: 'second line',
      currentThinkingContent: 'live reasoning',
      pendingCommands: [
        {
          text: 'follow up',
          displayText: 'follow up',
          images: [],
          parts: [{ type: 'text', text: 'follow up' }],
        },
      ],
    });

    expect(blocks.map((block) => block.id)).toEqual([
      'user-1',
      'assistant-live:thinking',
      'assistant-live',
      'tool-1',
      'pending:0:follow up',
    ]);
    expect(blocks[1]?.content).toBe('live reasoning');
    expect(blocks[2]?.content).toBe('first line\nsecond line');
    expect(blocks[3]?.detail).toBe('hidden dependency details');
    expect(blocks[4]?.pending).toBe(true);
  });

  it('reflows raw structured content at the requested width', () => {
    const lines = layoutTranscriptBlocks(
      [
        {
          id: 'message-1',
          messageId: 'message-1',
          role: 'assistant',
          kind: 'message',
          content: 'abcdefghij',
          revision: '1',
          collapsible: false,
        },
      ],
      7
    );

    expect(lines.map((line) => line.text)).toEqual(['• abcde', '  fghij']);
  });

  it('reports each changed block once without depending on rendered ANSI', () => {
    expect(
      changedTranscriptBlockIds(
        [
          {
            id: 'a',
            messageId: 'a',
            role: 'user',
            kind: 'message',
            content: 'one',
            revision: '1',
            collapsible: false,
          },
          {
            id: 'b',
            messageId: 'b',
            role: 'assistant',
            kind: 'message',
            content: 'two',
            revision: '1',
            collapsible: false,
          },
        ],
        [
          {
            id: 'a',
            messageId: 'a',
            role: 'user',
            kind: 'message',
            content: 'one',
            revision: '1',
            collapsible: false,
          },
          {
            id: 'b',
            messageId: 'b',
            role: 'assistant',
            kind: 'message',
            content: 'TWO',
            revision: '2',
            collapsible: false,
          },
          {
            id: 'c',
            messageId: 'c',
            role: 'tool',
            kind: 'tool',
            content: 'result',
            revision: '1',
            collapsible: false,
          },
        ]
      )
    ).toEqual(['b', 'c']);
  });

  it('changes revisions for same-length content replacements', () => {
    const project = (content: string) =>
      projectTranscriptBlocks({
        messages: [{ id: 'assistant-1', role: 'assistant', content, timestamp: 1 }],
        currentStreamingMessageId: null,
        streamingLines: [],
        streamingTail: '',
        currentThinkingContent: null,
        pendingCommands: [],
      })[0]!.revision;

    expect(project('abc')).not.toBe(project('xyz'));
  });

  it('keeps tool and thinking details collapsed independently', () => {
    const blocks = projectTranscriptBlocks({
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'answer',
          thinkingContent: 'reason one\nreason two',
          timestamp: 1,
        },
        {
          id: 'tool-1',
          role: 'tool',
          content: 'Read file\nfrom workspace',
          timestamp: 2,
          metadata: {
            toolName: 'Read',
            phase: 'complete',
            detail: 'detail one\ndetail two',
          },
        },
      ],
      currentStreamingMessageId: null,
      streamingLines: [],
      streamingTail: '',
      currentThinkingContent: null,
      pendingCommands: [],
    });

    const collapsed = layoutTranscriptBlocks(blocks, 40);
    expect(collapsed.map((line) => line.text).join('\n')).toContain('[+] Thinking');
    expect(collapsed.map((line) => line.text).join('\n')).not.toContain('reason two');
    expect(collapsed.map((line) => line.text).join('\n')).not.toContain('detail two');

    const expanded = layoutTranscriptBlocks(
      blocks,
      40,
      new Set(['assistant-1:thinking', 'tool-1'])
    );
    expect(expanded.map((line) => line.text).join('\n')).toContain('reason two');
    expect(expanded.map((line) => line.text).join('\n')).toContain('detail two');
  });

  it('searches hidden details and maps matches back to reflowed lines', () => {
    const blocks = projectTranscriptBlocks({
      messages: [
        {
          id: 'tool-1',
          role: 'tool',
          content: 'Read file\nfrom workspace',
          timestamp: 1,
          metadata: {
            toolName: 'Read',
            phase: 'complete',
            detail: 'alpha hidden needle omega',
          },
        },
      ],
      currentStreamingMessageId: null,
      streamingLines: [],
      streamingTail: '',
      currentThinkingContent: null,
      pendingCommands: [],
    });
    const matches = searchTranscriptBlocks(blocks, 'NEEDLE');
    const lines = layoutTranscriptBlocks(blocks, 14, new Set(['tool-1']));
    const lineIndex = findTranscriptMatchLineIndex(lines, matches[0]!);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.sourceLine).toBe(2);
    expect(lineIndex).toBeGreaterThan(0);
    expect(transcriptLineHighlights(lines[lineIndex]!, matches)).toHaveLength(1);
  });

  it('copies a selected visual line range without role decorations', () => {
    const lines = layoutTranscriptBlocks(
      [
        {
          id: 'message-1',
          messageId: 'message-1',
          role: 'assistant',
          kind: 'message',
          content: 'one\ntwo',
          revision: '1',
          collapsible: false,
        },
      ],
      20
    );

    expect(copyTranscriptLineRange(lines, 0, 1)).toBe('one\ntwo');
  });

  it('treats search input literally and preserves soft wraps while copying', () => {
    const blocks = [
      {
        id: 'message-1',
        messageId: 'message-1',
        role: 'assistant' as const,
        kind: 'message' as const,
        content: 'alpha [needle] omega',
        revision: '1',
        collapsible: false,
      },
    ];
    const matches = searchTranscriptBlocks(blocks, '[NEEDLE]');
    const lines = layoutTranscriptBlocks(blocks, 8);

    expect(matches).toHaveLength(1);
    expect(copyTranscriptLineRange(lines, 0, lines.length - 1)).toBe(
      'alpha [needle] omega'
    );
  });

  it('reuses unchanged block search results across streaming revisions', () => {
    const index = new TranscriptSearchIndex();
    const firstBlocks = [
      {
        id: 'stable',
        messageId: 'stable',
        role: 'user' as const,
        kind: 'message' as const,
        content: 'needle',
        revision: '1',
        collapsible: false,
      },
      {
        id: 'stream',
        messageId: 'stream',
        role: 'assistant' as const,
        kind: 'message' as const,
        content: 'needle',
        revision: '1',
        collapsible: false,
      },
    ];
    const first = index.search(firstBlocks, 'needle');
    const second = index.search(
      [
        firstBlocks[0]!,
        {
          ...firstBlocks[1]!,
          content: 'needle updated',
          revision: '2',
        },
      ],
      'needle'
    );

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });
});
