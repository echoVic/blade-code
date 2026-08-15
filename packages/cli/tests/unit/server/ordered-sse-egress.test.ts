import { describe, expect, it, vi } from 'vitest';
import {
  OrderedSseEgress,
  sseMessageUtf8Bytes,
  type SerializedSseMessage,
} from '../../../src/server/OrderedSseEgress.js';

function message(type: string, sequence?: number): SerializedSseMessage {
  return {
    ...(sequence !== undefined ? { id: String(sequence) } : {}),
    data: JSON.stringify({ type, ...(sequence !== undefined ? { sequence } : {}) }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OrderedSseEgress', () => {
  it('accounts the exact SSE wire representation in UTF-8 bytes', () => {
    const frame = {
      id: '7',
      event: 'message',
      retry: 1_000,
      data: 'é\n🙂',
    };
    expect(sseMessageUtf8Bytes(frame)).toBe(
      Buffer.byteLength('id: 7\nevent: message\ndata: é\ndata: 🙂\nretry: 1000\n\n')
    );
  });

  it('writes connected before fresh buffered events and preserves observation order', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const seen: string[] = [];
    let index = 0;
    const egress = new OrderedSseEgress({
      write: async (frame) => {
        seen.push(JSON.parse(frame.data).type);
        const gate = gates[index]!;
        index += 1;
        await gate.promise;
      },
    });

    const connected = egress.writeInitial(message('connected'));
    egress.observe(message('first'));
    egress.observe(message('second'));
    expect(egress.stats()).toMatchObject({
      pendingItems: 3,
      bufferedItems: 2,
    });
    await vi.waitFor(() => expect(seen).toEqual(['connected']));

    gates[0]!.resolve();
    await connected;
    egress.finishInitialization({ replayed: false });
    await vi.waitFor(() => expect(seen).toEqual(['connected', 'first']));
    gates[1]!.resolve();
    await vi.waitFor(() => expect(seen).toEqual(['connected', 'first', 'second']));
    gates[2]!.resolve();
    await egress.flush();
  });

  it('drops replay-window ephemeral events and deduplicates buffered commits by seq', async () => {
    const seen: Array<{ type: string; sequence?: number }> = [];
    const egress = new OrderedSseEgress({
      write: async (frame) => {
        seen.push(JSON.parse(frame.data));
      },
    });

    egress.observe(message('stale-delta'));
    egress.observe(message('duplicate-two', 2), 2);
    egress.observe(message('after-replay', 4), 4);
    egress.observe(message('duplicate-four', 4), 4);
    await egress.writeInitial(message('connected'));
    await egress.writeReplay(message('replay-one', 1), 1);
    await egress.writeReplay(message('replay-two', 2), 2);
    await egress.writeReplay(message('replay-three', 3), 3);
    egress.finishInitialization({ replayed: true });
    await egress.flush();

    expect(seen).toEqual([
      { type: 'connected' },
      { type: 'replay-one', sequence: 1 },
      { type: 'replay-two', sequence: 2 },
      { type: 'replay-three', sequence: 3 },
      { type: 'after-replay', sequence: 4 },
    ]);
  });

  it('orders post-replay buffered commits by sequence rather than callback order', async () => {
    const seen: number[] = [];
    const egress = new OrderedSseEgress({
      write: async (frame) => {
        const parsed = JSON.parse(frame.data) as { sequence?: number };
        if (parsed.sequence !== undefined) seen.push(parsed.sequence);
      },
    });

    egress.observe(message('five', 5), 5);
    egress.observe(message('four', 4), 4);
    await egress.writeReplay(message('three', 3), 3);
    egress.finishInitialization({ replayed: true });
    await egress.flush();

    expect(seen).toEqual([3, 4, 5]);
  });

  it('fails closed for a live committed sequence regression', async () => {
    const onFailure = vi.fn();
    const egress = new OrderedSseEgress({
      write: async () => undefined,
      onFailure,
    });
    egress.finishInitialization({ replayed: false });

    egress.observe(message('two', 2), 2);
    await egress.flush();
    egress.observe(message('one', 1), 1);

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'write_failed',
        message: 'SSE committed sequence regressed',
      })
    );
    expect(egress.stats().closed).toBe(true);
  });

  it('evicts only the overflowing slow subscriber', async () => {
    const slowGate = deferred();
    const slowFailure = vi.fn();
    const slow = new OrderedSseEgress({
      maxPendingItems: 2,
      write: async () => slowGate.promise,
      onFailure: slowFailure,
    });
    const fastSeen: string[] = [];
    const fastFailure = vi.fn();
    const fast = new OrderedSseEgress({
      maxPendingItems: 2,
      write: async (frame) => {
        fastSeen.push(JSON.parse(frame.data).type);
      },
      onFailure: fastFailure,
    });
    slow.finishInitialization({ replayed: false });
    fast.finishInitialization({ replayed: false });

    for (const type of ['one', 'two', 'three']) {
      slow.observe(message(type));
      fast.observe(message(type));
      await fast.flush();
    }

    expect(slowFailure).toHaveBeenCalledTimes(1);
    expect(slow.stats().closed).toBe(true);
    expect(fastFailure).not.toHaveBeenCalled();
    expect(fastSeen).toEqual(['one', 'two', 'three']);
    slowGate.resolve();
  });

  it('suppresses heartbeats while another frame is pending', async () => {
    const gate = deferred();
    const seen: string[] = [];
    const egress = new OrderedSseEgress({
      write: async (frame) => {
        seen.push(JSON.parse(frame.data).type);
        await gate.promise;
      },
    });
    egress.finishInitialization({ replayed: false });

    egress.observe(message('busy'));
    expect(egress.offerHeartbeat(message('heartbeat'))).toBe(false);
    gate.resolve();
    await egress.flush();

    expect(seen).toEqual(['busy']);
  });
});
