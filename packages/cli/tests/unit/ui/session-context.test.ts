import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { buildContextMessagesFromSession } from '../../../src/ui/utils/sessionContext.js';

describe('buildContextMessagesFromSession', () => {
  it('keeps restored raw context and appends only messages added after resume', () => {
    const restoredContextMessages: Message[] = [
      { role: 'system', content: 'compressed summary' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
      { role: 'assistant', content: 'I see the image' },
    ];

    const result = buildContextMessagesFromSession({
      restoredContextMessages,
      restoredVisibleMessageCount: 2,
      messages: [
        { id: 'm1', role: 'user', content: '[Image]', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'I see the image', timestamp: 2 },
        { id: 'm3', role: 'user', content: 'Continue from that image', timestamp: 3 },
      ],
    });

    expect(result).toEqual([
      ...restoredContextMessages,
      { role: 'user', content: 'Continue from that image' },
    ]);
  });

  it('falls back to UI messages when there is no restored context', () => {
    const result = buildContextMessagesFromSession({
      restoredContextMessages: null,
      restoredVisibleMessageCount: 0,
      messages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'world', timestamp: 2 },
      ],
    });

    expect(result).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
  });
});
