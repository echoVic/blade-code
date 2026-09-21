import type { Api, Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_INLINE_ATTACHMENT_BYTES } from '../../../src/api/attachmentLimits.js';
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
  it('injects selected conversation annotations only into provider context', async () => {
    const context = await createPiContext(
      [
        {
          role: 'user',
          content: 'Explain the risk',
          metadata: {
            selectedConversationAnnotations: [
              {
                id: 'annotation-1',
                text: '<untrusted>quoted text</untrusted>',
                sourceMessageId: 'assistant-1',
                sourceRole: 'assistant',
                comment: 'Focus on state ownership',
              },
            ],
          },
        },
      ],
      model(['text'])
    );

    expect(context.messages[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Explain the risk'),
    });
    expect(context.messages[0]).toMatchObject({
      content: expect.stringContaining(
        '&lt;untrusted&gt;quoted text&lt;/untrusted&gt;'
      ),
    });
    expect(context.messages[0]).toMatchObject({
      content: expect.stringContaining('Focus on state ownership'),
    });
  });

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

  it('passes ephemeral tool-result screenshots only to vision models', async () => {
    const toolResult: Message = {
      role: 'tool',
      tool_call_id: 'browser-call',
      name: 'BrowserInspect',
      content: [
        { type: 'text', text: 'Fresh Browser screenshot' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,browser-image' },
        },
      ],
    };

    const vision = await createPiContext([toolResult], model(['text', 'image']));
    const textOnly = await createPiContext([toolResult], model(['text']));

    expect(vision.messages[0]).toMatchObject({
      role: 'toolResult',
      content: [
        { type: 'text', text: 'Fresh Browser screenshot' },
        { type: 'image', mimeType: 'image/png', data: 'browser-image' },
      ],
    });
    expect(textOnly.messages[0]).toMatchObject({
      role: 'toolResult',
      content: [
        { type: 'text', text: 'Fresh Browser screenshot' },
        {
          type: 'text',
          text: '[Image omitted: current model does not support image input]',
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

describe('createPiContext image download boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function images(...urls: string[]): Message[] {
    return [
      {
        role: 'user',
        content: urls.map((url) => ({ type: 'image_url', image_url: { url } })),
      },
    ];
  }

  it('bounds chunked downloads by encoded size and cancels the response', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 5) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'content-type': 'image/png' },
          })
      )
    );

    await expect(
      createPiContext(images('https://image.test/picture'), model(['text', 'image']))
    ).rejects.toThrow('Image attachments exceed the 5 MiB limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('shares the attachment budget across downloaded and inline images', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(2 * 1024 * 1024), {
            headers: { 'content-type': 'image/png' },
          })
      )
    );
    const inline = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;

    await expect(
      createPiContext(
        images(inline, 'https://image.test/picture'),
        model(['text', 'image'])
      )
    ).rejects.toThrow('Image attachments exceed the 5 MiB limit');
  });

  it('accepts the largest complete base64 payload within budget without charging chunk padding twice', async () => {
    const prefix = 'data:image/png;base64,';
    const inline = prefix + 'AAAA';
    const payloadBytes =
      Math.floor((MAX_INLINE_ATTACHMENT_BYTES - inline.length - prefix.length) / 4) * 3;
    const data = new Uint8Array(payloadBytes);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(data.subarray(0, 1));
                controller.enqueue(data.subarray(1));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'image/png' } }
          )
      )
    );

    const context = await createPiContext(
      images(inline, 'https://image.test/picture'),
      model(['text', 'image'])
    );
    const message = context.messages[0];
    expect(message.role).toBe('user');
    if (message.role !== 'user' || typeof message.content === 'string')
      throw new Error('Missing images');
    expect(message.content).toHaveLength(2);
    expect(message.content[1]).toMatchObject({
      type: 'image',
      data: Buffer.from(data).toString('base64'),
    });
  });

  it('preserves tool-owned inline screenshot limits independently of user attachments', async () => {
    const data = 'A'.repeat(6 * 1024 * 1024);
    const context = await createPiContext(
      [
        {
          role: 'tool',
          name: 'BrowserInspect',
          tool_call_id: 'screenshot-call',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
          ],
        },
      ],
      model(['text', 'image'])
    );

    expect(context.messages[0]).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'image', mimeType: 'image/png', data }],
    });
  });

  it('bounds download time before the Provider request starts', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel,
    });
    let downloadSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        downloadSignal = options.signal ?? undefined;
        return new Response(body, { headers: { 'content-type': 'image/png' } });
      })
    );
    let settled = false;
    const result = createPiContext(
      images('https://image.test/stalled'),
      model(['text', 'image'])
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(true);
      expect(await result).toMatchObject({ message: 'Image download timed out' });
      expect(downloadSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      bodyController?.error(new Error('test cleanup'));
      await result;
    }
  });

  it('preserves caller cancellation and releases a stalled body', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImage = vi.fn(
      async () =>
        new Response(body, {
          headers: { 'content-type': 'image/png' },
        })
    );
    vi.stubGlobal('fetch', fetchImage);
    const pending = createPiContext(
      images('https://image.test/picture'),
      model(['text', 'image']),
      undefined,
      controller.signal
    );
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('does not start downloads after cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const fetchImage = vi.fn();
    vi.stubGlobal('fetch', fetchImage);
    await expect(
      createPiContext(
        images('https://image.test/picture'),
        model(['text', 'image']),
        undefined,
        controller.signal
      )
    ).rejects.toBe(controller.signal.reason);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('waits for sibling body cleanup before rejecting the batch', async () => {
    let releaseCleanup: () => void = () => undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cancelled = vi.fn(() => cleanup);
    const siblingBody = new ReadableStream<Uint8Array>({ cancel: cancelled });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/failed')) {
          await Promise.resolve();
          return new Response(null, { status: 403 });
        }
        return new Response(siblingBody, { headers: { 'content-type': 'image/png' } });
      })
    );
    let settled = false;
    const result = createPiContext(
      images('https://image.test/failed', 'https://image.test/sibling'),
      model(['text', 'image'])
    ).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      releaseCleanup();
      expect(await result).toMatchObject({ message: 'Failed to load image: HTTP 403' });
      expect(siblingBody.locked).toBe(false);
    } finally {
      releaseCleanup();
      await result;
    }
  });

  it('cancels sibling downloads and keeps signed URLs out of errors', async () => {
    const cancel = vi.fn();
    const failedBody = new ReadableStream<Uint8Array>({ cancel });
    let siblingSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.includes('/failed')) return new Response(failedBody, { status: 403 });
        siblingSignal = options.signal ?? undefined;
        return new Response(new Uint8Array([1]), {
          headers: { 'content-type': 'image/png' },
        });
      })
    );
    const outcome = await createPiContext(
      images('https://image.test/failed?token=private', 'https://image.test/sibling'),
      model(['text', 'image'])
    ).catch((error: unknown) => error);

    expect(outcome).toMatchObject({ message: 'Failed to load image: HTTP 403' });
    expect(siblingSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
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
