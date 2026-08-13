import { describe, expect, it } from 'vitest';

import {
  ShellOutputCapture,
  ShellOutputStream,
} from '../../../../../../src/tools/builtin/shell/ShellOutputCapture.js';

describe('ShellOutputCapture', () => {
  it('decodes a split emoji without a replacement character', () => {
    const capture = new ShellOutputCapture(16);
    const emoji = Buffer.from('😀');

    capture.append(ShellOutputStream.Stdout, emoji.subarray(0, 2));
    capture.append(ShellOutputStream.Stdout, emoji.subarray(2));

    const stdout = capture.finish().stdout;
    expect(stdout.content).toBe('😀');
    expect(stdout.content).not.toContain('�');
    expect(stdout.totalChars).toBe(2);
  });

  it('applies the four-byte budget independently to each stream', () => {
    const capture = new ShellOutputCapture(4);

    capture.append(ShellOutputStream.Stdout, 'abcde');
    capture.append(ShellOutputStream.Stderr, '12345');

    const snapshot = capture.finish();
    expect(snapshot.stdout.content).toBe('bcde');
    expect(snapshot.stderr.content).toBe('2345');
    expect(snapshot.stdout.totalBytes).toBe(5);
    expect(snapshot.stderr.totalBytes).toBe(5);
  });

  it('accepts string and Buffer chunks', () => {
    const capture = new ShellOutputCapture(16);

    capture.append(ShellOutputStream.Stdout, 'hello ');
    capture.append(ShellOutputStream.Stdout, Buffer.from('world'));

    expect(capture.finish().stdout.content).toBe('hello world');
  });

  it('finishes idempotently', () => {
    const capture = new ShellOutputCapture(16);
    capture.append(ShellOutputStream.Stdout, 'done');

    expect(capture.finish()).toEqual(capture.finish());
  });

  it('counts decoder replacement characters from incomplete UTF-8 at finish', () => {
    const capture = new ShellOutputCapture(16);
    capture.append(ShellOutputStream.Stdout, Buffer.from([0xf0, 0x9f]));

    const stdout = capture.finish().stdout;
    expect(stdout.content).toBe('�');
    expect(stdout.totalChars).toBe(1);
  });

  it('marks accounting incomplete for both streams without discarding statistics', () => {
    const capture = new ShellOutputCapture(4);
    capture.append(ShellOutputStream.Stdout, 'abcde');
    capture.append(ShellOutputStream.Stderr, '12345');
    capture.markAccountingIncomplete();

    const snapshot = capture.finish();
    expect(snapshot.stdout.accountingComplete).toBe(false);
    expect(snapshot.stderr.accountingComplete).toBe(false);
    expect(snapshot.stdout.totalBytes).toBe(5);
    expect(snapshot.stderr.totalBytes).toBe(5);
  });

  it('includes the terminal output merged flag', () => {
    expect(new ShellOutputCapture(16, true).finish().terminalOutputMerged).toBe(true);
    expect(new ShellOutputCapture(16, false).finish().terminalOutputMerged).toBe(false);
  });

  it('keeps total bytes equal to retained plus omitted bytes', () => {
    const capture = new ShellOutputCapture(4);
    capture.append(ShellOutputStream.Stdout, 'abcdef');
    capture.append(ShellOutputStream.Stderr, Buffer.from('123456'));

    const snapshot = capture.finish();
    for (const stream of [snapshot.stdout, snapshot.stderr]) {
      expect(stream.totalBytes).toBe(stream.retainedBytes + stream.omittedBytes);
    }
  });
});
