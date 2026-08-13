import { describe, expect, expectTypeOf, it } from 'vitest';

import { ShellOutputCapture } from '../../../../../../src/tools/builtin/shell/ShellOutputCapture.js';

describe('ShellOutputCapture', () => {
  it('decodes a split emoji without a replacement character', () => {
    const capture = new ShellOutputCapture(16);
    const emoji = Buffer.from('😀');

    capture.append('stdout', emoji.subarray(0, 2));
    capture.append('stdout', emoji.subarray(2));

    capture.finish();
    const stdout = capture.snapshot().stdout;
    expect(stdout.content).toBe('😀');
    expect(stdout.content).not.toContain('�');
    expect(stdout.totalBytes).toBe(4);
    expect(stdout.totalChars).toBe(2);
  });

  it('applies the four-byte budget independently to each stream', () => {
    const capture = new ShellOutputCapture(4);

    capture.append('stdout', 'abcde');
    capture.append('stderr', '12345');

    capture.finish();
    const snapshot = capture.snapshot();
    expect(snapshot.stdout.content).toBe('bcde');
    expect(snapshot.stderr.content).toBe('2345');
    expect(snapshot.stdout.totalBytes).toBe(5);
    expect(snapshot.stderr.totalBytes).toBe(5);
  });

  it('accepts string and Buffer chunks', () => {
    const capture = new ShellOutputCapture(16);

    capture.append('stdout', 'hello ');
    capture.append('stdout', Buffer.from('world'));

    capture.finish();
    expect(capture.snapshot().stdout.content).toBe('hello world');
  });

  it('finishes idempotently', () => {
    const capture = new ShellOutputCapture(16);
    capture.append('stdout', 'done');

    expectTypeOf(capture.finish()).toEqualTypeOf<void>();
    capture.finish();
    const first = capture.snapshot();
    capture.finish();
    expect(capture.snapshot()).toEqual(first);
  });

  it('counts decoder replacement characters from incomplete UTF-8 at finish', () => {
    const capture = new ShellOutputCapture(16);
    capture.append('stdout', Buffer.from([0xf0, 0x9f]));

    capture.finish();
    const stdout = capture.snapshot().stdout;
    expect(stdout.content).toBe('�');
    expect(stdout.totalChars).toBe(1);
  });

  it('marks accounting incomplete for both streams without discarding statistics', () => {
    const capture = new ShellOutputCapture(4);
    capture.append('stdout', 'abcde');
    capture.append('stderr', '12345');
    capture.markAccountingIncomplete();

    capture.finish();
    const snapshot = capture.snapshot();
    expect(snapshot.stdout.accountingComplete).toBe(false);
    expect(snapshot.stderr.accountingComplete).toBe(false);
    expect(snapshot.stdout.totalBytes).toBe(5);
    expect(snapshot.stderr.totalBytes).toBe(5);
  });

  it('includes the terminal output merged flag', () => {
    const merged = new ShellOutputCapture(16, true);
    const split = new ShellOutputCapture(16, false);
    merged.finish();
    split.finish();
    expect(merged.snapshot().terminalOutputMerged).toBe(true);
    expect(split.snapshot().terminalOutputMerged).toBe(false);
  });

  it('keeps total bytes equal to retained plus omitted bytes', () => {
    const capture = new ShellOutputCapture(4);
    capture.append('stdout', 'abcdef');
    capture.append('stderr', Buffer.from('123456'));

    capture.finish();
    const snapshot = capture.snapshot();
    for (const stream of [snapshot.stdout, snapshot.stderr]) {
      expect(stream.totalBytes).toBe(stream.retainedBytes + stream.omittedBytes);
    }
  });
});
