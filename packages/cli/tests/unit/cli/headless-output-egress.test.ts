import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  HeadlessOutputEgress,
  type HeadlessWritableLike,
} from '../../../src/commands/HeadlessOutputEgress.js';

class ControlledWritable extends EventEmitter implements HeadlessWritableLike {
  readonly chunks: string[] = [];
  private readonly results: boolean[];

  constructor(results: boolean[] = []) {
    super();
    this.results = [...results];
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.results.shift() ?? true;
  }
}

function createEgress(
  stdout: HeadlessWritableLike,
  stderr: HeadlessWritableLike,
  options: {
    signal?: AbortSignal;
    onFailure?: (error: Error) => void;
    maxPendingItems?: number;
  } = {}
) {
  return new HeadlessOutputEgress(
    { stdout, stderr },
    {
      signal: options.signal,
      onFailure: options.onFailure,
      maxPendingItems: options.maxPendingItems,
      writeTimeoutMs: 1_000,
    }
  );
}

describe('HeadlessOutputEgress', () => {
  it('waits for drain and starts only one write per stream at a time', async () => {
    const stdout = new ControlledWritable([false, true]);
    const stderr = new ControlledWritable();
    const egress = createEgress(stdout, stderr);

    expect(egress.write('stdout', 'first')).toBe(true);
    expect(egress.write('stdout', 'second')).toBe(true);
    const flush = egress.flush();

    await vi.waitFor(() => expect(stdout.chunks).toEqual(['first']));
    expect(stdout.listenerCount('drain')).toBe(1);
    stdout.emit('drain');

    await expect(flush).resolves.toBeUndefined();
    expect(stdout.chunks).toEqual(['first', 'second']);
    expect(stdout.listenerCount('drain')).toBe(0);
    expect(stdout.listenerCount('error')).toBe(1);

    egress.close();
    expect(stdout.listenerCount('error')).toBe(0);
  });

  it('fails closed when write(false) has no observable drain contract', async () => {
    const onFailure = vi.fn();
    const stdout = {
      write: vi.fn<(chunk: string) => boolean>(() => false),
    };
    const egress = createEgress(stdout, new ControlledWritable(), { onFailure });

    expect(egress.write('stdout', 'blocked')).toBe(true);
    await expect(egress.flush()).rejects.toMatchObject({
      kind: 'write_failed',
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(egress.stats().stdout).toMatchObject({
      closed: true,
      pendingItems: 0,
      pendingBytes: 0,
    });
    expect(egress.stats().stderr.closed).toBe(true);
  });

  it('keeps stdout and stderr queues independent while one stream is blocked', async () => {
    const stdout = new ControlledWritable([false]);
    const stderr = new ControlledWritable([true, true]);
    const egress = createEgress(stdout, stderr, { maxPendingItems: 2 });

    egress.write('stdout', 'stdout-blocked');
    egress.write('stderr', 'stderr-first');
    egress.write('stderr', 'stderr-second');

    await vi.waitFor(() =>
      expect(stderr.chunks).toEqual(['stderr-first', 'stderr-second'])
    );
    expect(stdout.chunks).toEqual(['stdout-blocked']);
    expect(egress.stats().stdout.pendingItems).toBe(1);
    expect(egress.stats().stderr.pendingItems).toBe(0);

    stdout.emit('drain');
    await expect(egress.flush()).resolves.toBeUndefined();
  });

  it('removes drain, error, and abort listeners when a blocked write is aborted', async () => {
    const controller = new AbortController();
    const stdout = new ControlledWritable([false]);
    const egress = createEgress(stdout, new ControlledWritable(), {
      signal: controller.signal,
    });

    egress.write('stdout', 'blocked');
    const flush = egress.flush();
    await vi.waitFor(() => expect(stdout.listenerCount('drain')).toBe(1));

    controller.abort('test-abort');
    await expect(flush).rejects.toMatchObject({ kind: 'aborted' });
    expect(stdout.listenerCount('drain')).toBe(0);
    expect(stdout.listenerCount('error')).toBe(0);
  });

  it('treats EPIPE as one terminal failure and closes both stream queues', async () => {
    const onFailure = vi.fn();
    const stdout = new ControlledWritable([false]);
    const stderr = new ControlledWritable();
    const egress = createEgress(stdout, stderr, { onFailure });

    egress.write('stdout', 'blocked');
    const flush = egress.flush();
    await vi.waitFor(() => expect(stdout.listenerCount('drain')).toBe(1));

    const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    stdout.emit('error', error);

    await expect(flush).rejects.toMatchObject({
      kind: 'write_failed',
      cause: error,
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(egress.stats().stdout.closed).toBe(true);
    expect(egress.stats().stderr.closed).toBe(true);
    expect(stdout.listenerCount('drain')).toBe(0);
    expect(stdout.listenerCount('error')).toBe(0);
    expect(stderr.listenerCount('error')).toBe(0);
  });
});
