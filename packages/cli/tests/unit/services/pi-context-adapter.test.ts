import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { createPiContext } from '../../../src/services/pi/contextAdapter.js';

function model(input: Array<'text' | 'image'>): Model<Api> {
  return {
    id: 'model',
    name: 'Model',
    api: 'openai-completions',
    provider: 'test',
    baseUrl: 'https://example.test/v1',
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

const multimodalHistory: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Earlier request' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,history-image' },
      },
    ],
  },
];

describe('createPiContext image capabilities', () => {
  it('replaces historical images when switching to a text-only model', async () => {
    const context = await createPiContext(multimodalHistory, model(['text']));

    expect(context.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Earlier request' },
        {
          type: 'text',
          text: '[Image omitted: current model does not support image input]',
        },
      ],
    });
  });

  it('preserves historical images for a vision model', async () => {
    const context = await createPiContext(multimodalHistory, model(['text', 'image']));

    expect(context.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Earlier request' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'history-image',
        },
      ],
    });
  });

  it('does not forward Blade-only identity or metadata to provider context', async () => {
    const context = await createPiContext(
      [
        {
          id: 'handoff-message-1',
          role: 'user',
          content: 'hidden runtime marker',
          metadata: {
            clientVisible: false,
            tokenBudgetHandoff: {
              version: 1,
              messageId: 'handoff-message-1',
            },
          },
        },
      ],
      model(['text'])
    );

    expect(context.messages[0]).toEqual({
      role: 'user',
      content: 'hidden runtime marker',
      timestamp: expect.any(Number),
    });
    expect(context.messages[0]).not.toHaveProperty('id');
    expect(context.messages[0]).not.toHaveProperty('metadata');
  });
});

describe('createPiContext constrained tools', () => {
  it('sorts tool declarations into a cache-stable order', async () => {
    const context = await createPiContext([], model(['text']), [
      { name: 'Write', description: 'Write a file', parameters: {} },
      { name: 'Bash', description: 'Run a command', parameters: {} },
      { name: 'Read', description: 'Read a file', parameters: {} },
    ]);

    expect(context.tools?.map((tool) => tool.name)).toEqual(['Bash', 'Read', 'Write']);
  });

  it('preserves provider constrained-sampling preferences', async () => {
    const context = await createPiContext([], model(['text']), [
      {
        name: 'StructuredOutput',
        description: 'Submit output',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        constrainedSampling: {
          type: 'json_schema',
          strict: 'prefer',
        },
      },
    ]);

    expect(context.tools).toEqual([
      expect.objectContaining({
        name: 'StructuredOutput',
        constrainedSampling: {
          type: 'json_schema',
          strict: 'prefer',
        },
      }),
    ]);
  });
});
