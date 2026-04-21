import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService.toUISafeMessages', () => {
  it('filters internal messages while preserving user-visible multimodal placeholders', () => {
    const messages: Message[] = [
      { role: 'system', content: 'internal summary' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at ' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,def' } }],
      },
      { role: 'tool', content: '{"secret":"tool-json"}' },
      { role: 'assistant', content: 'Done' },
    ];

    expect(SessionService.toUISafeMessages(messages)).toMatchObject([
      { role: 'user', content: 'Look at [Image]' },
      { role: 'assistant', content: '[Image]' },
      { role: 'assistant', content: 'Done' },
    ]);
  });

  it('drops consecutive duplicate visible messages during resume normalization', () => {
    const messages: Message[] = [
      { role: 'user', content: 'same prompt' },
      { role: 'user', content: 'same prompt' },
      { role: 'assistant', content: 'same answer' },
      { role: 'assistant', content: 'same answer' },
    ];

    expect(SessionService.toUISafeMessages(messages)).toMatchObject([
      { role: 'user', content: 'same prompt' },
      { role: 'assistant', content: 'same answer' },
    ]);
  });
});
