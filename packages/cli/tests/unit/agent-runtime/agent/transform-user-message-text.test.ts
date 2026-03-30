import { describe, expect, it } from 'vitest';

import { transformUserMessageText } from '../../../../src/agent/transformUserMessageText.js';

describe('transformUserMessageText', () => {
  it('transforms plain string messages directly', () => {
    expect(
      transformUserMessageText('build a plan', (text) => `REMINDER\n\n${text}`)
    ).toBe('REMINDER\n\nbuild a plan');
  });

  it('transforms only the first text part for multimodal messages', () => {
    const image = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } } as const;

    expect(
      transformUserMessageText(
        [
          image,
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        (text) => `PREFIX\n\n${text}`
      )
    ).toEqual([
      image,
      { type: 'text', text: 'PREFIX\n\nfirst' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('prepends a text part when the message has no text parts', () => {
    const imageOnlyMessage = [
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ] as const;

    expect(
      transformUserMessageText(imageOnlyMessage as any, () => 'REMINDER')
    ).toEqual([
      { type: 'text', text: 'REMINDER' },
      ...imageOnlyMessage,
    ]);
  });
});
