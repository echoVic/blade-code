import { describe, expect, it, vi } from 'vitest';
import {
  estimateProviderRequestPendingBytes,
  estimateRetainedValueBytes,
  PROVIDER_REQUEST_FOOTPRINT_MAX_NODES,
} from '../../../src/services/pi/providerRequestFootprint.js';

describe('Provider request retained-footprint estimator', () => {
  it('counts exact UTF-8 string and raw typed-array bytes', () => {
    expect(estimateRetainedValueBytes('é🙂')).toBe(6);
    expect(estimateRetainedValueBytes(new Uint8Array(17))).toBe(49);
  });

  it('charges structural overhead without counting one object twice', () => {
    const shared = { text: 'payload' };
    const single = estimateRetainedValueBytes([shared]);
    const repeated = estimateRetainedValueBytes([shared, shared]);

    expect(repeated).toBe(single);
    expect(single).toBeGreaterThan(Buffer.byteLength('payload'));
  });

  it('terminates cycles and never invokes property getters', () => {
    const getter = vi.fn(() => 'secret');
    const value: Record<string, unknown> = {};
    value.self = value;
    Object.defineProperty(value, 'lazy', {
      enumerable: true,
      get: getter,
    });

    expect(estimateRetainedValueBytes(value)).toBeGreaterThan(0);
    expect(getter).not.toHaveBeenCalled();
  });

  it('traverses map and set entries under the shared identity guard', () => {
    const shared = { marker: 'same' };
    const value = new Map<unknown, unknown>([
      ['key', shared],
      ['set', new Set([shared, 'tail'])],
    ]);

    const bytes = estimateRetainedValueBytes(value);
    expect(bytes).toBeGreaterThan(Buffer.byteLength('keysametail'));
    expect(bytes).toBeLessThan(1_000);
  });

  it('saturates one byte above the byte or node limit', () => {
    expect(
      estimateRetainedValueBytes('x'.repeat(11), {
        maxBytes: 10,
      })
    ).toBe(11);
    expect(
      estimateRetainedValueBytes([1, 2, 3], {
        maxBytes: 1_000,
        maxNodes: 2,
      })
    ).toBe(1_001);
    expect(PROVIDER_REQUEST_FOOTPRINT_MAX_NODES).toBe(100_000);
  });

  it('rejects unsafe estimator limits', () => {
    expect(() => estimateRetainedValueBytes('x', { maxBytes: 0 })).toThrow('maxBytes');
    expect(() => estimateRetainedValueBytes('x', { maxNodes: 0 })).toThrow('maxNodes');
  });

  it('weighs original messages and normalized context once per request', () => {
    const bytes = estimateProviderRequestPendingBytes({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'request' },
      ],
      context: {
        systemPrompt: 'system',
        messages: [
          {
            role: 'user',
            content: 'request',
            timestamp: 1,
          },
        ],
      },
      tools: [
        {
          name: 'Read',
          description: 'Read one file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
      requestOptions: {
        maxOutputTokens: 128,
      },
    });

    expect(bytes).toBeGreaterThan(Buffer.byteLength('systemrequest'));
    expect(bytes).toBeLessThan(16 * 1024);
  });
});
