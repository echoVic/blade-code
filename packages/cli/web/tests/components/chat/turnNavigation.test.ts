// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/services';
import {
  deriveChatTurns,
  turnPreview,
} from '../../../src/components/chat/turnNavigation';

function userMessage(id: string, content: Message['content']): Message {
  return { id, role: 'user', content } as Message;
}

function assistantMessage(id: string, text: string): Message {
  return { id, role: 'assistant', content: text } as Message;
}

describe('turnPreview', () => {
  it('collapses whitespace and trims', () => {
    expect(turnPreview('  hello   world \n\n next ')).toBe('hello world next');
  });

  it('truncates long prompts with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const preview = turnPreview(long);
    expect(preview.length).toBe(80);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('extracts text parts from multimodal content', () => {
    const preview = turnPreview([
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'this image' },
    ] as Message['content']);
    expect(preview).toBe('describe this image');
  });

  it('returns empty string for image-only content', () => {
    const preview = turnPreview([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] as Message['content']);
    expect(preview).toBe('');
  });
});

describe('deriveChatTurns', () => {
  it('keeps only user messages with ids and non-empty previews in order', () => {
    const turns = deriveChatTurns([
      userMessage('u1', 'first prompt'),
      assistantMessage('a1', 'reply'),
      userMessage('u2', 'second prompt'),
      assistantMessage('a2', 'reply two'),
    ]);
    expect(turns).toEqual([
      { id: 'u1', index: 0, preview: 'first prompt' },
      { id: 'u2', index: 2, preview: 'second prompt' },
    ]);
  });

  it('skips user messages without ids or previews', () => {
    const turns = deriveChatTurns([
      userMessage('', 'no id'),
      userMessage('u2', '   '),
      userMessage('u3', 'kept'),
    ]);
    expect(turns).toEqual([{ id: 'u3', index: 2, preview: 'kept' }]);
  });

  it('preserves the original message index for windowed rendering', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 5; i += 1) {
      messages.push(assistantMessage(`a${i}`, 'noise'));
    }
    messages.push(userMessage('late', 'the only turn'));
    const turns = deriveChatTurns(messages);
    expect(turns).toEqual([{ id: 'late', index: 5, preview: 'the only turn' }]);
  });
});
