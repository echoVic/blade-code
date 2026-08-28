import { describe, expect, it } from 'vitest';
import {
  changedTranscriptBlockIds,
  layoutTranscriptBlocks,
  projectTranscriptBlocks,
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
        },
      ],
      currentStreamingMessageId: 'assistant-live',
      streamingLines: ['first line'],
      streamingTail: 'second line',
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
      'assistant-live',
      'pending:0:follow up',
    ]);
    expect(blocks[1]?.content).toBe('first line\nsecond line');
    expect(blocks[2]?.pending).toBe(true);
  });

  it('reflows raw structured content at the requested width', () => {
    const lines = layoutTranscriptBlocks(
      [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'abcdefghij',
          revision: '1',
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
          { id: 'a', role: 'user', content: 'one', revision: '1' },
          { id: 'b', role: 'assistant', content: 'two', revision: '1' },
        ],
        [
          { id: 'a', role: 'user', content: 'one', revision: '1' },
          { id: 'b', role: 'assistant', content: 'TWO', revision: '2' },
          { id: 'c', role: 'tool', content: 'result', revision: '1' },
        ]
      )
    ).toEqual(['b', 'c']);
  });

  it('changes revisions for same-length content replacements', () => {
    const project = (content: string) =>
      projectTranscriptBlocks({
        messages: [
          { id: 'assistant-1', role: 'assistant', content, timestamp: 1 },
        ],
        currentStreamingMessageId: null,
        streamingLines: [],
        streamingTail: '',
        pendingCommands: [],
      })[0]!.revision;

    expect(project('abc')).not.toBe(project('xyz'));
  });
});
