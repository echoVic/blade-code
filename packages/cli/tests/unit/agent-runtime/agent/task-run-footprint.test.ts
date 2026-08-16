import { describe, expect, it } from 'vitest';
import { estimateTaskRunPendingBytes } from '../../../../src/agent/runtime/taskRunFootprint.js';

describe('task run retained-footprint estimator', () => {
  it('charges two conservative projections of direct UTF-8 input', () => {
    const ascii = estimateTaskRunPendingBytes({ content: 'plain' });
    const unicode = estimateTaskRunPendingBytes({ content: '界'.repeat(5) });

    expect(ascii).toBeGreaterThan(Buffer.byteLength('plain') * 2);
    expect(unicode).toBeGreaterThan(ascii);
  });

  it('includes multimodal content and output schema', () => {
    const textOnly = estimateTaskRunPendingBytes({ content: 'task' });
    const multimodal = estimateTaskRunPendingBytes({
      content: [
        { type: 'text', text: 'task' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${'a'.repeat(4_096)}` },
        },
      ],
      outputSchema: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'bounded result' },
        },
      },
    });

    expect(multimodal).toBeGreaterThan(textOnly + 4_096);
  });

  it('uses recovered durable input instead of the empty synthetic message', () => {
    const empty = estimateTaskRunPendingBytes({ content: '' });
    const recovered = estimateTaskRunPendingBytes({
      content: '',
      pendingMessages: [
        {
          id: 'recovered-task-input',
          content: 'recover this exact task'.repeat(200),
          queuedAt: 1,
          recovered: true,
          outputSchema: {
            type: 'object',
            properties: { result: { type: 'string' } },
          },
          metadata: {
            inboxMessageId: 'recovered-task-input',
          },
        },
      ],
    });

    expect(recovered).toBeGreaterThan(empty * 10);
  });

  it('accounts every recovered message, including metadata', () => {
    const one = estimateTaskRunPendingBytes({
      content: '',
      pendingMessages: [
        {
          id: 'one',
          content: 'first',
          queuedAt: 1,
          recovered: true,
        },
      ],
    });
    const two = estimateTaskRunPendingBytes({
      content: '',
      pendingMessages: [
        {
          id: 'one',
          content: 'first',
          queuedAt: 1,
          recovered: true,
        },
        {
          id: 'two',
          content: 'second'.repeat(100),
          queuedAt: 2,
          recovered: true,
          metadata: {
            inboxMessageId: 'two',
          },
        },
      ],
    });

    expect(two).toBeGreaterThan(one);
  });
});
